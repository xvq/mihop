// Package store 以 mihomo-config.yaml 为唯一数据源。
// 使用 yaml.Node 做增量写入，只替换 proxies / listeners / x-mihop 三个
// 顶层 key，其余用户手写的字段（rules、dns 等）完整保留。
package store

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	"gopkg.in/yaml.v3"
)

// ─── 对外类型（双 tag：yaml 字段名=mihomo 规范，json 字段名=API 规范） ────────

// Proxy 上游代理。Name 字段在 API 中充当 ID，在 mihomo config 中是 name。
// Extra 通过 yaml:",inline" 将任意 key-value 内联到 YAML 代理条目，
// 前端以动态 KV 表单填写，字符串值在写入 YAML 前自动转换为合适的 Go 类型。
type Proxy struct {
	Name   string                 `yaml:"name"            json:"name"`
	Type   string                 `yaml:"type"            json:"type"`
	Server string                 `yaml:"server,omitempty" json:"server,omitempty"`
	Port   int                    `yaml:"port,omitempty"   json:"port,omitempty"`
	Extra  map[string]interface{} `yaml:",inline"          json:"extra,omitempty"`
}

// UserEntry 认证用户，对应 mihomo listener 的 users 列表。
type UserEntry struct {
	Username string `yaml:"username" json:"username"`
	Password string `yaml:"password" json:"password"`
}

// Listener 本地监听端口。LocalPort 在 API 中充当 ID。
type Listener struct {
	Name      string      `json:"name"`             // mihomo listener 名称，空则自动生成
	LocalPort int         `json:"local_port"`        // API ID，对应 mihomo listener.port
	Type      string      `json:"type"`              // http / socks / mixed，默认 mixed
	ProxyName string      `json:"proxy_id"`          // 代理模式：引用 Proxy.Name
	RuleName  string      `json:"rule_id"`           // 规则模式：引用 SubRule.Name
	Enabled   bool        `json:"enabled"`
	Users     []UserEntry `json:"users,omitempty"`   // 认证用户列表，空则不设置
	Listen    string      `json:"listen,omitempty"`  // 监听地址，默认 0.0.0.0
}

// Tunnel 流量转发隧道。Address（host:port）在 API 中充当 ID。
type Tunnel struct {
	Address string `json:"address"`         // 本地监听地址，如 127.0.0.1:6553
	Network string `json:"network"`          // "tcp" / "udp" / "tcp+udp"
	Target  string `json:"target"`           // 转发目标地址
	Proxy   string `json:"proxy,omitempty"`  // 可选，经过某个代理
	Enabled bool   `json:"enabled"`
}

// RuleEntry 规则集中的单条规则。
type RuleEntry struct {
	Type      string `json:"type"`
	Value     string `json:"value"`      // MATCH 时为空
	Target    string `json:"target"`     // 代理名 / DIRECT / REJECT
	NoResolve bool   `json:"no_resolve"` // 仅 IP 类规则有效
}

// SubRule 命名规则集，对应 mihomo yaml 的 sub-rules 条目。
type SubRule struct {
	Name    string      `json:"name"`
	Entries []RuleEntry `json:"entries"`
}

// DNSConfig DNS 设置（供 API 使用，JSON 序列化）。
// Hosts 中多个 IP 用逗号分隔，如 "1.1.1.1, 2.2.2.2"。
type DNSConfig struct {
	Enable            bool              `json:"enable"`
	DefaultNameserver []string          `json:"default_nameserver"`
	Nameserver        []string          `json:"nameserver"`
	EnhancedMode      string            `json:"enhanced_mode"`
	FakeIPRange       string            `json:"fake_ip_range"`
	FakeIPFilter      []string          `json:"fake_ip_filter"`
	NameserverPolicy  map[string]string `json:"nameserver_policy"`
	Hosts             map[string]string `json:"hosts"`
}

// AppSettings 仅存放 mihomo 可执行文件路径（不在 yaml 中的字段）。
// external-controller 和 secret 直接从 yaml 里读取。
type AppSettings struct {
	MihomoPath   string `json:"mihomo_path"`
	MihomoAPIURL string `json:"mihomo_api_url"` // 从 yaml external-controller 派生
	MihomoSecret string `json:"mihomo_secret"`  // 从 yaml secret 派生
}

var ErrNotFound = errors.New("not found")

// ─── 内部 YAML 结构 ──────────────────────────────────────────────────────────

// mihomoListener mihomo config 格式的 listener 条目
type mihomoListener struct {
	Name   string      `yaml:"name"`
	Type   string      `yaml:"type"`
	Port   int         `yaml:"port"`
	Listen string      `yaml:"listen,omitempty"`
	Proxy  string      `yaml:"proxy,omitempty"`
	Rule   string      `yaml:"rule,omitempty"`
	Users  []UserEntry `yaml:"users,omitempty"`
}

// mihomoTunnel mihomo config 格式的 tunnel 条目（多行格式）
type mihomoTunnel struct {
	Network []string `yaml:"network"`
	Address string   `yaml:"address"`
	Target  string   `yaml:"target"`
	Proxy   string   `yaml:"proxy,omitempty"`
}

// rawTunnel 用于加载 YAML，同时支持单行（字符串）和多行（映射）格式
type rawTunnel struct {
	Network []string
	Address string
	Target  string
	Proxy   string
}

func (t *rawTunnel) UnmarshalYAML(value *yaml.Node) error {
	if value.Kind == yaml.ScalarNode {
		// 单行格式：tcp/udp,127.0.0.1:6553,8.8.8.8:53[,proxy]
		parts := strings.Split(value.Value, ",")
		if len(parts) < 3 {
			return fmt.Errorf("invalid tunnel: %s", value.Value)
		}
		for _, n := range strings.Split(parts[0], "/") {
			t.Network = append(t.Network, strings.TrimSpace(n))
		}
		t.Address = strings.TrimSpace(parts[1])
		t.Target = strings.TrimSpace(parts[2])
		if len(parts) > 3 {
			t.Proxy = strings.TrimSpace(parts[3])
		}
		return nil
	}
	// 多行格式（映射）
	type alias struct {
		Network []string `yaml:"network"`
		Address string   `yaml:"address"`
		Target  string   `yaml:"target"`
		Proxy   string   `yaml:"proxy"`
	}
	var a alias
	if err := value.Decode(&a); err != nil {
		return err
	}
	t.Network = a.Network
	t.Address = a.Address
	t.Target = a.Target
	t.Proxy = a.Proxy
	return nil
}

// dnsYAML mihomo config 中 dns 块的 YAML 结构
type dnsYAML struct {
	Enable            bool              `yaml:"enable"`
	IPv6              bool              `yaml:"ipv6"`
	DefaultNameserver []string          `yaml:"default-nameserver,omitempty"`
	Nameserver        []string          `yaml:"nameserver,omitempty"`
	EnhancedMode      string            `yaml:"enhanced-mode,omitempty"`
	FakeIPRange       string            `yaml:"fake-ip-range,omitempty"`
	FakeIPFilter      []string          `yaml:"fake-ip-filter,omitempty"`
	NameserverPolicy  map[string]string `yaml:"nameserver-policy,omitempty"`
}

// xMihop 存储在 yaml 顶层 x-mihop key 下，mihomo 会忽略未知 key
type xMihop struct {
	DisabledListeners []disabledListener `yaml:"disabled_listeners,omitempty"`
	DisabledTunnels   []disabledTunnel   `yaml:"disabled_tunnels,omitempty"`
}

type disabledListener struct {
	Name      string      `yaml:"name,omitempty"`
	Port      int         `yaml:"port"`
	Type      string      `yaml:"type,omitempty"`
	Listen    string      `yaml:"listen,omitempty"`
	ProxyName string      `yaml:"proxy,omitempty"`
	RuleName  string      `yaml:"rule,omitempty"`
	Users     []UserEntry `yaml:"users,omitempty"`
}

type disabledTunnel struct {
	Address string `yaml:"address"`
	Network string `yaml:"network,omitempty"`
	Target  string `yaml:"target,omitempty"`
	Proxy   string `yaml:"proxy,omitempty"`
}

// parsedConfig 仅解析我们关心的字段（其余保留在 yaml.Node 里）
type parsedConfig struct {
	ExternalController string                 `yaml:"external-controller"`
	Secret             string                 `yaml:"secret"`
	Proxies            []Proxy                `yaml:"proxies"`
	Listeners          []mihomoListener       `yaml:"listeners"`
	Tunnels            []rawTunnel            `yaml:"tunnels"`
	XMihop             xMihop                 `yaml:"x-mihop"`
	DNS                dnsYAML                `yaml:"dns"`
	Hosts              map[string]interface{} `yaml:"hosts"`
	SubRules           map[string][]string    `yaml:"sub-rules"`
}

// ─── Store ───────────────────────────────────────────────────────────────────

type Store struct {
	mu           sync.RWMutex
	configPath   string
	settingsPath string

	proxies   []Proxy
	listeners []Listener // 含 enabled/disabled
	tunnels   []Tunnel   // 含 enabled/disabled
	subRules  []SubRule
	dns       DNSConfig

	// 从 yaml 读出，写入时也更新到 yaml
	externalController string
	secret             string

	mihomoPath string // 存在 mihop-config.json
	password   string // UI 登录密码，存在 mihop-config.json
	logLevel   string // 日志级别：debug / info / silent，存在 mihop-config.json
	listenAddr string // Mihop 监听地址，存在 mihop-config.json
}

func New(dataDir string) (*Store, error) {
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return nil, err
	}
	s := &Store{
		configPath:         filepath.Join(dataDir, "mihomo-config.yaml"),
		settingsPath:       filepath.Join(dataDir, "mihop-config.json"),
		proxies:            []Proxy{},
		listeners:          []Listener{},
		tunnels:            []Tunnel{},
		subRules:           []SubRule{},
		dns: DNSConfig{
			Enable:            false,
			DefaultNameserver: []string{"223.5.5.5", "119.29.29.29"},
			Nameserver: []string{
				"https://doh.pub/dns-query",
				"https://dns.alidns.com/dns-query",
				"tls://dot.pub:853",
				"tls://dns.alidns.com:853",
			},
			EnhancedMode:     "redir-host",
			FakeIPRange:      "198.18.0.1/16",
			FakeIPFilter:     []string{},
			NameserverPolicy: map[string]string{},
			Hosts:            map[string]string{},
		},
		externalController: "127.0.0.1:9090",
		secret:             "",
		mihomoPath: "mihomo",
		password:   "admin",
		logLevel:   "info",
	}
	if err := s.loadSettings(); err != nil {
		// 文件不存在或解析失败，写出默认配置文件
		_ = s.saveSettings()
	}
	_ = s.loadConfig() // 不存在时用默认值，首次运行会写出默认文件
	return s, nil
}

// ─── 加载 ────────────────────────────────────────────────────────────────────

func (s *Store) loadSettings() error {
	b, err := os.ReadFile(s.settingsPath)
	if err != nil {
		return err
	}
	var v struct {
		MihomoPath string `json:"mihomo_path"`
		Password   string `json:"password"`
		LogLevel   string `json:"log_level"`
		ListenAddr string `json:"listen_addr"`
	}
	if err := json.Unmarshal(b, &v); err != nil {
		return err
	}
	if v.MihomoPath != "" {
		s.mihomoPath = v.MihomoPath
	}
	if v.Password != "" {
		s.password = v.Password
	}
	if v.LogLevel != "" {
		s.logLevel = v.LogLevel
	}
	if v.ListenAddr != "" {
		s.listenAddr = v.ListenAddr
	}
	return nil
}

func (s *Store) saveSettings() error {
	v := struct {
		MihomoPath string `json:"mihomo_path"`
		Password   string `json:"password"`
		LogLevel   string `json:"log_level"`
		ListenAddr string `json:"listen_addr"`
	}{MihomoPath: s.mihomoPath, Password: s.password, LogLevel: s.logLevel, ListenAddr: s.listenAddr}
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.settingsPath, b, 0o644)
}

func (s *Store) GetLogLevel() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.logLevel
}

func (s *Store) GetPassword() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.password
}

func (s *Store) SetPassword(pw string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.password = pw
	return s.saveSettings()
}

func (s *Store) loadConfig() error {
	b, err := os.ReadFile(s.configPath)
	if os.IsNotExist(err) {
		// 首次运行：写出默认配置
		return s.writeDefaultConfig()
	}
	if err != nil {
		return err
	}
	var cfg parsedConfig
	if err := yaml.Unmarshal(b, &cfg); err != nil {
		return err
	}
	s.proxies = cfg.Proxies
	if s.proxies == nil {
		s.proxies = []Proxy{}
	}
	if cfg.ExternalController != "" {
		s.externalController = cfg.ExternalController
	}
	s.secret = cfg.Secret

	// 重建 listeners（enabled + disabled）
	s.listeners = make([]Listener, 0, len(cfg.Listeners)+len(cfg.XMihop.DisabledListeners))
	for _, l := range cfg.Listeners {
		users := l.Users
		if users == nil {
			users = []UserEntry{}
		}
		s.listeners = append(s.listeners, Listener{
			Name:      l.Name,
			LocalPort: l.Port,
			Type:      listenerTypeFromMihomo(l.Type),
			Listen:    l.Listen,
			ProxyName: l.Proxy,
			RuleName:  l.Rule,
			Enabled:   true,
			Users:     users,
		})
	}
	for _, d := range cfg.XMihop.DisabledListeners {
		users := d.Users
		if users == nil {
			users = []UserEntry{}
		}
		s.listeners = append(s.listeners, Listener{
			Name:      d.Name,
			LocalPort: d.Port,
			Type:      listenerTypeFromMihomo(d.Type),
			Listen:    d.Listen,
			ProxyName: d.ProxyName,
			RuleName:  d.RuleName,
			Enabled:   false,
			Users:     users,
		})
	}

	// 加载 tunnels
	s.tunnels = make([]Tunnel, 0, len(cfg.Tunnels)+len(cfg.XMihop.DisabledTunnels))
	for _, t := range cfg.Tunnels {
		s.tunnels = append(s.tunnels, Tunnel{
			Address: t.Address,
			Network: networkToAPI(t.Network),
			Target:  t.Target,
			Proxy:   t.Proxy,
			Enabled: true,
		})
	}
	for _, t := range cfg.XMihop.DisabledTunnels {
		network := t.Network
		if network == "" {
			network = "tcp+udp"
		}
		s.tunnels = append(s.tunnels, Tunnel{
			Address: t.Address,
			Network: network,
			Target:  t.Target,
			Proxy:   t.Proxy,
			Enabled: false,
		})
	}

	s.dns = parseDNS(cfg.DNS, cfg.Hosts)
	s.subRules = parseSubRules(cfg.SubRules)
	return nil
}

func (s *Store) writeDefaultConfig() error {
	const defaultYAML = `allow-lan: false
log-level: info
unified-delay: true
tcp-concurrent: true
external-controller: 127.0.0.1:9090
secret: ""

proxies: []
listeners: []
`
	return os.WriteFile(s.configPath, []byte(defaultYAML), 0o644)
}

// ─── 增量 YAML 写入 ───────────────────────────────────────────────────────────

// saveConfig 读取现有 yaml，只替换 proxies / listeners / x-mihop 三个 key。
func (s *Store) saveConfig() error {
	// 读取现有文件（保留用户的其他配置）
	raw, err := os.ReadFile(s.configPath)
	if os.IsNotExist(err) {
		if err := s.writeDefaultConfig(); err != nil {
			return err
		}
		raw, err = os.ReadFile(s.configPath)
	}
	if err != nil {
		return err
	}

	var doc yaml.Node
	if err := yaml.Unmarshal(raw, &doc); err != nil {
		return err
	}
	if doc.Kind == 0 {
		doc = yaml.Node{Kind: yaml.DocumentNode, Content: []*yaml.Node{{Kind: yaml.MappingNode}}}
	}

	// 构建要写入 yaml 的各 section
	enabledListeners := make([]mihomoListener, 0)
	disabledListeners := make([]disabledListener, 0)
	for _, l := range s.listeners {
		name := l.Name
		if name == "" {
			name = listenerName(l.LocalPort)
		}
		ltype := listenerTypeToMihomo(l.Type)
		// 空用户列表写 nil，触发 omitempty 不输出 users 键
		var users []UserEntry
		if len(l.Users) > 0 {
			users = l.Users
		}
		if l.Enabled {
			enabledListeners = append(enabledListeners, mihomoListener{
				Name:   name,
				Type:   ltype,
				Port:   l.LocalPort,
				Listen: l.Listen,
				Proxy:  l.ProxyName,
				Rule:   l.RuleName,
				Users:  users,
			})
		} else {
			disabledListeners = append(disabledListeners, disabledListener{
				Name:      name,
				Port:      l.LocalPort,
				Type:      ltype,
				Listen:    l.Listen,
				ProxyName: l.ProxyName,
				RuleName:  l.RuleName,
				Users:     users,
			})
		}
	}

	enabledTunnels := make([]mihomoTunnel, 0)
	disabledTunnels := make([]disabledTunnel, 0)
	for _, t := range s.tunnels {
		if t.Enabled {
			enabledTunnels = append(enabledTunnels, mihomoTunnel{
				Network: networkToYAML(t.Network),
				Address: t.Address,
				Target:  t.Target,
				Proxy:   t.Proxy,
			})
		} else {
			disabledTunnels = append(disabledTunnels, disabledTunnel{
				Address: t.Address,
				Network: t.Network,
				Target:  t.Target,
				Proxy:   t.Proxy,
			})
		}
	}
	xm := xMihop{DisabledListeners: disabledListeners, DisabledTunnels: disabledTunnels}
	dy, hostsMap := formatDNS(s.dns)

	// 增量更新各 key
	if err := setYAMLKey(&doc, "proxies", s.proxies); err != nil {
		return err
	}
	if err := setYAMLKey(&doc, "listeners", enabledListeners); err != nil {
		return err
	}
	if err := setYAMLKey(&doc, "x-mihop", xm); err != nil {
		return err
	}
	if err := setYAMLKey(&doc, "dns", dy); err != nil {
		return err
	}
	if err := setYAMLKey(&doc, "hosts", hostsMap); err != nil {
		return err
	}
	subRulesMap := make(map[string][]string, len(s.subRules))
	for _, sr := range s.subRules {
		entries := make([]string, 0, len(sr.Entries))
		for _, e := range sr.Entries {
			entries = append(entries, formatRuleEntry(e))
		}
		subRulesMap[sr.Name] = entries
	}
	if err := setYAMLKey(&doc, "sub-rules", subRulesMap); err != nil {
		return err
	}
	if err := setYAMLKey(&doc, "tunnels", enabledTunnels); err != nil {
		return err
	}

	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(&doc); err != nil {
		return err
	}
	return os.WriteFile(s.configPath, buf.Bytes(), 0o644)
}

// setYAMLKey 在 yaml.Node 文档中找到 key 并替换其值，找不到则追加。
func setYAMLKey(doc *yaml.Node, key string, value any) error {
	valNode, err := encodeNode(value)
	if err != nil {
		return err
	}
	root := doc.Content[0] // MappingNode
	for i := 0; i < len(root.Content)-1; i += 2 {
		if root.Content[i].Value == key {
			root.Content[i+1] = valNode
			return nil
		}
	}
	// key 不存在，追加
	keyNode := &yaml.Node{Kind: yaml.ScalarNode, Value: key}
	root.Content = append(root.Content, keyNode, valNode)
	return nil
}

// encodeNode 将任意值编码为 yaml.Node，空结构体/nil 返回空 MappingNode。
// 注意：不使用 (*yaml.Node).Encode，因为它把 n 设置为值节点本身（SequenceNode
// 等），n.Content[0] 会取到第一个元素而非整个序列。
// 通过 yaml.Marshal→yaml.Unmarshal 的 round-trip，Unmarshal 总是把 n 设置
// 为 DocumentNode，n.Content[0] 才是真正的值节点。
func encodeNode(value any) (*yaml.Node, error) {
	b, err := yaml.Marshal(value)
	if err != nil {
		return nil, err
	}
	var n yaml.Node
	if err := yaml.Unmarshal(b, &n); err != nil {
		return nil, err
	}
	if len(n.Content) == 0 {
		// 空值（如空结构体所有字段 omitempty）→ 返回空映射节点
		return &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}, nil
	}
	return n.Content[0], nil
}

// ─── SubRule 帮助函数 ─────────────────────────────────────────────────────────

func parseSubRules(raw map[string][]string) []SubRule {
	if len(raw) == 0 {
		return []SubRule{}
	}
	result := make([]SubRule, 0, len(raw))
	for name, lines := range raw {
		sr := SubRule{Name: name, Entries: make([]RuleEntry, 0, len(lines))}
		for _, line := range lines {
			if e, ok := parseRuleEntry(line); ok {
				sr.Entries = append(sr.Entries, e)
			}
		}
		result = append(result, sr)
	}
	return result
}

func parseRuleEntry(s string) (RuleEntry, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return RuleEntry{}, false
	}
	parts := strings.Split(s, ",")
	noResolve := false
	if len(parts) > 0 && strings.TrimSpace(parts[len(parts)-1]) == "no-resolve" {
		noResolve = true
		parts = parts[:len(parts)-1]
	}
	for i := range parts {
		parts[i] = strings.TrimSpace(parts[i])
	}
	switch len(parts) {
	case 2: // MATCH,TARGET
		return RuleEntry{Type: parts[0], Target: parts[1], NoResolve: noResolve}, true
	case 3: // TYPE,VALUE,TARGET
		return RuleEntry{Type: parts[0], Value: parts[1], Target: parts[2], NoResolve: noResolve}, true
	}
	return RuleEntry{}, false
}

func formatRuleEntry(e RuleEntry) string {
	var s string
	if e.Value == "" {
		s = e.Type + "," + e.Target
	} else {
		s = e.Type + "," + e.Value + "," + e.Target
	}
	if e.NoResolve {
		s += ",no-resolve"
	}
	return s
}

// ─── SubRule CRUD ─────────────────────────────────────────────────────────────

func (s *Store) ListSubRules() []SubRule {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]SubRule, len(s.subRules))
	copy(out, s.subRules)
	return out
}

func (s *Store) GetSubRule(name string) (SubRule, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, r := range s.subRules {
		if r.Name == name {
			return r, true
		}
	}
	return SubRule{}, false
}

func (s *Store) AddSubRule(r SubRule) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, existing := range s.subRules {
		if existing.Name == r.Name {
			return fmt.Errorf("rule '%s' already exists", r.Name)
		}
	}
	if r.Entries == nil {
		r.Entries = []RuleEntry{}
	}
	s.subRules = append(s.subRules, r)
	return s.saveConfig()
}

func (s *Store) UpdateSubRule(oldName string, r SubRule) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	idx := -1
	for i, existing := range s.subRules {
		if existing.Name == oldName {
			idx = i
		} else if existing.Name == r.Name && r.Name != oldName {
			return fmt.Errorf("rule '%s' already exists", r.Name)
		}
	}
	if idx == -1 {
		return ErrNotFound
	}
	if r.Name != oldName {
		for i, l := range s.listeners {
			if l.RuleName == oldName {
				s.listeners[i].RuleName = r.Name
			}
		}
	}
	if r.Entries == nil {
		r.Entries = []RuleEntry{}
	}
	s.subRules[idx] = r
	return s.saveConfig()
}

func (s *Store) DeleteSubRule(name string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, r := range s.subRules {
		if r.Name == name {
			s.subRules = append(s.subRules[:i], s.subRules[i+1:]...)
			return s.saveConfig()
		}
	}
	return ErrNotFound
}

// parseDNS 将 YAML 解析结果转为 API 用的 DNSConfig。
func parseDNS(d dnsYAML, rawHosts map[string]interface{}) DNSConfig {
	strSlice := func(s []string) []string {
		if s == nil {
			return []string{}
		}
		return s
	}
	strMap := func(m map[string]string) map[string]string {
		if m == nil {
			return map[string]string{}
		}
		return m
	}
	cfg := DNSConfig{
		Enable:           d.Enable,
		EnhancedMode:     d.EnhancedMode,
		FakeIPRange:      d.FakeIPRange,
		DefaultNameserver: strSlice(d.DefaultNameserver),
		Nameserver:       strSlice(d.Nameserver),
		FakeIPFilter:     strSlice(d.FakeIPFilter),
		NameserverPolicy: strMap(d.NameserverPolicy),
		Hosts:            make(map[string]string),
	}
	for k, v := range rawHosts {
		switch val := v.(type) {
		case string:
			cfg.Hosts[k] = val
		case []interface{}:
			parts := make([]string, 0, len(val))
			for _, item := range val {
				parts = append(parts, fmt.Sprintf("%v", item))
			}
			cfg.Hosts[k] = strings.Join(parts, ", ")
		default:
			cfg.Hosts[k] = fmt.Sprintf("%v", v)
		}
	}
	return cfg
}

// formatDNS 将 DNSConfig 序列化回 YAML 结构。
// Hosts 中逗号分隔的多值会被拆分为 YAML 序列。
func formatDNS(cfg DNSConfig) (dnsYAML, map[string]interface{}) {
	d := dnsYAML{
		Enable:            cfg.Enable,
		IPv6:              false,
		DefaultNameserver: cfg.DefaultNameserver,
		Nameserver:        cfg.Nameserver,
		EnhancedMode:      cfg.EnhancedMode,
		FakeIPRange:       cfg.FakeIPRange,
		FakeIPFilter:      cfg.FakeIPFilter,
		NameserverPolicy:  cfg.NameserverPolicy,
	}
	hosts := make(map[string]interface{})
	for k, v := range cfg.Hosts {
		v = strings.TrimSpace(v)
		if v == "" {
			continue
		}
		if strings.Contains(v, ",") {
			parts := strings.Split(v, ",")
			items := make([]string, 0, len(parts))
			for _, p := range parts {
				if p = strings.TrimSpace(p); p != "" {
					items = append(items, p)
				}
			}
			hosts[k] = items
		} else {
			hosts[k] = v
		}
	}
	return d, hosts
}

// ─── DNS CRUD ─────────────────────────────────────────────────────────────────

func (s *Store) GetDNS() DNSConfig {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.dns
}

func (s *Store) SetDNS(cfg DNSConfig) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if cfg.DefaultNameserver == nil {
		cfg.DefaultNameserver = []string{}
	}
	if cfg.Nameserver == nil {
		cfg.Nameserver = []string{}
	}
	if cfg.FakeIPFilter == nil {
		cfg.FakeIPFilter = []string{}
	}
	if cfg.NameserverPolicy == nil {
		cfg.NameserverPolicy = map[string]string{}
	}
	if cfg.Hosts == nil {
		cfg.Hosts = map[string]string{}
	}
	s.dns = cfg
	return s.saveConfig()
}

// ─── 网络类型转换 ─────────────────────────────────────────────────────────────

func networkToAPI(networks []string) string {
	hasTCP, hasUDP := false, false
	for _, n := range networks {
		switch strings.ToLower(n) {
		case "tcp":
			hasTCP = true
		case "udp":
			hasUDP = true
		}
	}
	if hasTCP && hasUDP {
		return "tcp+udp"
	} else if hasTCP {
		return "tcp"
	} else if hasUDP {
		return "udp"
	}
	return "tcp+udp"
}

func networkToYAML(network string) []string {
	switch network {
	case "tcp":
		return []string{"tcp"}
	case "udp":
		return []string{"udp"}
	default:
		return []string{"tcp", "udp"}
	}
}

// extractPort 从 host:port 地址中提取端口号
func extractPort(address string) int {
	_, portStr, err := net.SplitHostPort(address)
	if err != nil {
		return 0
	}
	port, _ := strconv.Atoi(portStr)
	return port
}

// ─── Tunnel CRUD ─────────────────────────────────────────────────────────────

func (s *Store) ListTunnels() []Tunnel {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Tunnel, len(s.tunnels))
	copy(out, s.tunnels)
	return out
}

func (s *Store) AddTunnel(t Tunnel) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, existing := range s.tunnels {
		if existing.Address == t.Address {
			return fmt.Errorf("tunnel address '%s' already in use", t.Address)
		}
	}
	// 检查端口与本地监听冲突
	tPort := extractPort(t.Address)
	if tPort > 0 {
		for _, l := range s.listeners {
			if l.LocalPort == tPort {
				return fmt.Errorf("port %d already in use by a listener", tPort)
			}
		}
	}
	s.tunnels = append(s.tunnels, t)
	return s.saveConfig()
}

func (s *Store) UpdateTunnel(oldAddress string, t Tunnel) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	idx := -1
	for i, existing := range s.tunnels {
		if existing.Address == oldAddress {
			idx = i
		} else if existing.Address == t.Address && t.Address != oldAddress {
			return fmt.Errorf("tunnel address '%s' already in use", t.Address)
		}
	}
	if idx == -1 {
		return ErrNotFound
	}
	// 如果地址（端口）变了，检查与监听冲突
	if t.Address != oldAddress {
		tPort := extractPort(t.Address)
		if tPort > 0 {
			for _, l := range s.listeners {
				if l.LocalPort == tPort {
					return fmt.Errorf("port %d already in use by a listener", tPort)
				}
			}
		}
	}
	s.tunnels[idx] = t
	return s.saveConfig()
}

func (s *Store) DeleteTunnel(address string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, t := range s.tunnels {
		if t.Address == address {
			s.tunnels = append(s.tunnels[:i], s.tunnels[i+1:]...)
			return s.saveConfig()
		}
	}
	return ErrNotFound
}

func (s *Store) ToggleTunnel(address string) (Tunnel, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, t := range s.tunnels {
		if t.Address == address {
			s.tunnels[i].Enabled = !s.tunnels[i].Enabled
			return s.tunnels[i], s.saveConfig()
		}
	}
	return Tunnel{}, ErrNotFound
}

func listenerName(port int) string {
	return fmt.Sprintf("mihop-%d", port)
}

// listenerTypeToMihomo 将 UI 侧的类型名转为 mihomo yaml 中的类型名。
func listenerTypeToMihomo(t string) string {
	if t == "" {
		return "mixed"
	}
	return t
}

// listenerTypeFromMihomo 将 mihomo yaml 中的类型名转回 UI 侧类型名。
func listenerTypeFromMihomo(t string) string {
	return t
}


// ─── Proxy CRUD ──────────────────────────────────────────────────────────────

func (s *Store) ListProxies() []Proxy {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Proxy, len(s.proxies))
	copy(out, s.proxies)
	return out
}

func (s *Store) GetProxy(name string) (Proxy, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, p := range s.proxies {
		if p.Name == name {
			return p, true
		}
	}
	return Proxy{}, false
}

func (s *Store) AddProxy(p Proxy) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, existing := range s.proxies {
		if existing.Name == p.Name {
			return fmt.Errorf("proxy name '%s' already exists", p.Name)
		}
	}
	s.proxies = append(s.proxies, p)
	return s.saveConfig()
}

// UpdateProxy 支持改名：若 Name 变了，自动更新所有 Listener 引用。
func (s *Store) UpdateProxy(oldName string, p Proxy) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	idx := -1
	for i, existing := range s.proxies {
		if existing.Name == oldName {
			idx = i
		} else if existing.Name == p.Name && p.Name != oldName {
			return fmt.Errorf("proxy name '%s' already exists", p.Name)
		}
	}
	if idx == -1 {
		return ErrNotFound
	}
	if p.Name != oldName {
		for i, l := range s.listeners {
			if l.ProxyName == oldName {
				s.listeners[i].ProxyName = p.Name
			}
		}
	}
	s.proxies[idx] = p
	return s.saveConfig()
}

func (s *Store) DeleteProxy(name string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, p := range s.proxies {
		if p.Name == name {
			s.proxies = append(s.proxies[:i], s.proxies[i+1:]...)
			return s.saveConfig()
		}
	}
	return ErrNotFound
}

// ─── Listener CRUD ───────────────────────────────────────────────────────────

func (s *Store) ListListeners() []Listener {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Listener, len(s.listeners))
	copy(out, s.listeners)
	return out
}

func (s *Store) GetListener(port int) (Listener, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, l := range s.listeners {
		if l.LocalPort == port {
			return l, true
		}
	}
	return Listener{}, false
}

func (s *Store) AddListener(l Listener) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, existing := range s.listeners {
		if existing.LocalPort == l.LocalPort {
			return fmt.Errorf("port %d already in use", l.LocalPort)
		}
	}
	for _, t := range s.tunnels {
		if extractPort(t.Address) == l.LocalPort {
			return fmt.Errorf("port %d already in use by a tunnel", l.LocalPort)
		}
	}
	s.listeners = append(s.listeners, l)
	return s.saveConfig()
}

func (s *Store) UpdateListener(port int, l Listener) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, existing := range s.listeners {
		if existing.LocalPort == port {
			// 如果端口变了，检查新端口冲突
			if l.LocalPort != port {
				for _, other := range s.listeners {
					if other.LocalPort == l.LocalPort {
						return fmt.Errorf("port %d already in use", l.LocalPort)
					}
				}
				for _, t := range s.tunnels {
					if extractPort(t.Address) == l.LocalPort {
						return fmt.Errorf("port %d already in use by a tunnel", l.LocalPort)
					}
				}
			}
			s.listeners[i] = l
			return s.saveConfig()
		}
	}
	return ErrNotFound
}

func (s *Store) DeleteListener(port int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, l := range s.listeners {
		if l.LocalPort == port {
			s.listeners = append(s.listeners[:i], s.listeners[i+1:]...)
			return s.saveConfig()
		}
	}
	return ErrNotFound
}

func (s *Store) ToggleListener(port int) (Listener, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, l := range s.listeners {
		if l.LocalPort == port {
			s.listeners[i].Enabled = !s.listeners[i].Enabled
			return s.listeners[i], s.saveConfig()
		}
	}
	return Listener{}, ErrNotFound
}

// ─── Settings ─────────────────────────────────────────────────────────────────

func (s *Store) GetSettings() AppSettings {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return AppSettings{
		MihomoPath:   s.mihomoPath,
		MihomoAPIURL: "http://" + s.externalController,
		MihomoSecret: s.secret,
	}
}

func (s *Store) GetAddr() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.listenAddr != "" {
		return s.listenAddr
	}
	return "0.0.0.0:8080"
}

func (s *Store) UpdateSettings(settings AppSettings) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.mihomoPath = settings.MihomoPath

	// 把 api_url 反解成 host:port 写回 yaml
	host := strings.TrimPrefix(settings.MihomoAPIURL, "http://")
	host = strings.TrimPrefix(host, "https://")
	s.externalController = host
	s.secret = settings.MihomoSecret

	// 更新 yaml 中的 external-controller 和 secret
	raw, err := os.ReadFile(s.configPath)
	if err != nil {
		return err
	}
	var doc yaml.Node
	if err := yaml.Unmarshal(raw, &doc); err != nil {
		return err
	}
	if err := setYAMLKey(&doc, "external-controller", s.externalController); err != nil {
		return err
	}
	if err := setYAMLKey(&doc, "secret", s.secret); err != nil {
		return err
	}
	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(&doc); err != nil {
		return err
	}
	if err := os.WriteFile(s.configPath, buf.Bytes(), 0o644); err != nil {
		return err
	}

	return s.saveSettings()
}

// GetConfigPath 返回 mihomo 配置文件路径，供 process.Manager 使用。
func (s *Store) GetConfigPath() string {
	return s.configPath
}

// Reload 从 yaml 文件重新加载 proxies / listeners，适合用户手动编辑文件后使用。
// 加载完成后写回一次，规范化 yaml 中可能存在的历史格式问题。
func (s *Store) Reload() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.loadConfig(); err != nil {
		return err
	}
	return s.saveConfig()
}
