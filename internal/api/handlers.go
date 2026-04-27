package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mihop/internal/process"
	"mihop/internal/store"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
)

type Handler struct {
	store   *store.Store
	manager *process.Manager
	session sessionStore
}

func New(s *store.Store, m *process.Manager) *Handler {
	return &Handler{store: s, manager: m}
}

func (h *Handler) RegisterRoutes(r gin.IRouter) {
	// 公开路由（无需登录）
	r.POST("/api/login", h.login)

	// 受保护路由（需要 Bearer token）
	api := r.Group("/api", h.authRequired())

	api.POST("/logout", h.logout)

	// 上游代理（ID = proxy name）
	api.GET("/proxies", h.listProxies)
	api.POST("/proxies", h.createProxy)
	api.PUT("/proxies/:id", h.updateProxy)
	api.DELETE("/proxies/:id", h.deleteProxy)
	api.POST("/proxies/:id/test", h.testProxy)

	// 本地监听（ID = local_port）
	api.GET("/listeners", h.listListeners)
	api.POST("/listeners", h.createListener)
	api.PUT("/listeners/:port", h.updateListener)
	api.DELETE("/listeners/:port", h.deleteListener)
	api.POST("/listeners/:port/toggle", h.toggleListener)

	// 流量隧道（tunnels）
	api.GET("/tunnels", h.listTunnels)
	api.POST("/tunnels", h.createTunnel)
	api.PUT("/tunnels/:address", h.updateTunnel)
	api.DELETE("/tunnels/:address", h.deleteTunnel)
	api.POST("/tunnels/:address/toggle", h.toggleTunnel)

	// 规则集（sub-rules）
	api.GET("/rules", h.listSubRules)
	api.POST("/rules", h.createSubRule)
	api.PUT("/rules/:name", h.updateSubRule)
	api.DELETE("/rules/:name", h.deleteSubRule)

	// DNS 设置
	api.GET("/dns", h.getDNS)
	api.PUT("/dns", h.setDNS)

	// 设置 & 控制
	api.GET("/settings", h.getSettings)
	api.PUT("/settings", h.updateSettings)
	api.GET("/status", h.getStatus)
	api.POST("/start", h.startMihomo)
	api.POST("/stop", h.stopMihomo)
	api.POST("/reload", h.reloadConfig)

	// 反代 mihomo 原生 API
	api.Any("/mihomo/*path", h.proxyMihomo)
}

// ─── 上游代理 ─────────────────────────────────────────────────────────────────

func (h *Handler) listProxies(c *gin.Context) {
	c.JSON(http.StatusOK, h.store.ListProxies())
}

func (h *Handler) createProxy(c *gin.Context) {
	var p store.Proxy
	if err := c.ShouldBindJSON(&p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := validateProxy(p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	p.Extra = coerceExtras(p.Extra)
	if err := h.store.AddProxy(p); err != nil {
		c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
		return
	}
	h.hotReload()
	c.JSON(http.StatusCreated, p)
}

func (h *Handler) updateProxy(c *gin.Context) {
	oldName := c.Param("id")
	var p store.Proxy
	if err := c.ShouldBindJSON(&p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := validateProxy(p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	p.Extra = coerceExtras(p.Extra)
	if err := h.store.UpdateProxy(oldName, p); err != nil {
		status := http.StatusInternalServerError
		if err == store.ErrNotFound {
			status = http.StatusNotFound
		} else if strings.Contains(err.Error(), "already exists") {
			status = http.StatusConflict
		}
		c.JSON(status, gin.H{"error": err.Error()})
		return
	}
	h.hotReload()
	c.JSON(http.StatusOK, p)
}

func (h *Handler) deleteProxy(c *gin.Context) {
	if err := h.store.DeleteProxy(c.Param("id")); err != nil {
		status := http.StatusInternalServerError
		if err == store.ErrNotFound {
			status = http.StatusNotFound
		}
		c.JSON(status, gin.H{"error": err.Error()})
		return
	}
	h.hotReload()
	c.Status(http.StatusNoContent)
}

func (h *Handler) testProxy(c *gin.Context) {
	name := c.Param("id")
	if _, ok := h.store.GetProxy(name); !ok {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	if !h.manager.Status().Running {
		c.JSON(http.StatusOK, gin.H{"reachable": false, "error": "mihomo 未运行，无法测试"})
		return
	}

	settings := h.store.GetSettings()
	testURL := "http://www.gstatic.com/generate_204"
	apiURL := fmt.Sprintf("%s/proxies/%s/delay?timeout=5000&url=%s",
		settings.MihomoAPIURL, url.PathEscape(name), url.QueryEscape(testURL))

	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, apiURL, nil)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if settings.MihomoSecret != "" {
		req.Header.Set("Authorization", "Bearer "+settings.MihomoSecret)
	}

	resp, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"reachable": false, "error": err.Error()})
		return
	}
	defer resp.Body.Close()

	var result struct {
		Delay int    `json:"delay"`
		Error string `json:"message"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		c.JSON(http.StatusOK, gin.H{"reachable": false, "error": "解析响应失败"})
		return
	}
	if result.Delay > 0 {
		c.JSON(http.StatusOK, gin.H{"reachable": true, "latency_ms": result.Delay})
	} else {
		c.JSON(http.StatusOK, gin.H{"reachable": false, "error": result.Error})
	}
}

// ─── 本地监听 ─────────────────────────────────────────────────────────────────

func (h *Handler) listListeners(c *gin.Context) {
	c.JSON(http.StatusOK, h.store.ListListeners())
}

func (h *Handler) createListener(c *gin.Context) {
	var l store.Listener
	if err := c.ShouldBindJSON(&l); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := validateListener(l); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.store.AddListener(l); err != nil {
		c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
		return
	}
	h.hotReload()
	c.JSON(http.StatusCreated, l)
}

func (h *Handler) updateListener(c *gin.Context) {
	port, err := strconv.Atoi(c.Param("port"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid port"})
		return
	}
	var l store.Listener
	if err := c.ShouldBindJSON(&l); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := validateListener(l); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.store.UpdateListener(port, l); err != nil {
		status := http.StatusInternalServerError
		if err == store.ErrNotFound {
			status = http.StatusNotFound
		} else if strings.Contains(err.Error(), "already in use") {
			status = http.StatusConflict
		}
		c.JSON(status, gin.H{"error": err.Error()})
		return
	}
	h.hotReload()
	c.JSON(http.StatusOK, l)
}

func (h *Handler) deleteListener(c *gin.Context) {
	port, err := strconv.Atoi(c.Param("port"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid port"})
		return
	}
	if err := h.store.DeleteListener(port); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	h.hotReload()
	c.Status(http.StatusNoContent)
}

func (h *Handler) toggleListener(c *gin.Context) {
	port, err := strconv.Atoi(c.Param("port"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid port"})
		return
	}
	l, err := h.store.ToggleListener(port)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	h.hotReload()
	c.JSON(http.StatusOK, l)
}

// ─── 流量隧道 ─────────────────────────────────────────────────────────────────

func (h *Handler) listTunnels(c *gin.Context) {
	c.JSON(http.StatusOK, h.store.ListTunnels())
}

func (h *Handler) createTunnel(c *gin.Context) {
	var t store.Tunnel
	if err := c.ShouldBindJSON(&t); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if t.Address == "" || t.Target == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "address and target are required"})
		return
	}
	if err := h.store.AddTunnel(t); err != nil {
		c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
		return
	}
	h.hotReload()
	c.JSON(http.StatusCreated, t)
}

func (h *Handler) updateTunnel(c *gin.Context) {
	oldAddress, err := url.PathUnescape(c.Param("address"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid address"})
		return
	}
	var t store.Tunnel
	if err := c.ShouldBindJSON(&t); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.store.UpdateTunnel(oldAddress, t); err != nil {
		status := http.StatusInternalServerError
		if err == store.ErrNotFound {
			status = http.StatusNotFound
		} else if strings.Contains(err.Error(), "already in use") {
			status = http.StatusConflict
		}
		c.JSON(status, gin.H{"error": err.Error()})
		return
	}
	h.hotReload()
	c.JSON(http.StatusOK, t)
}

func (h *Handler) deleteTunnel(c *gin.Context) {
	address, err := url.PathUnescape(c.Param("address"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid address"})
		return
	}
	if err := h.store.DeleteTunnel(address); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	h.hotReload()
	c.Status(http.StatusNoContent)
}

func (h *Handler) toggleTunnel(c *gin.Context) {
	address, err := url.PathUnescape(c.Param("address"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid address"})
		return
	}
	t, err := h.store.ToggleTunnel(address)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	h.hotReload()
	c.JSON(http.StatusOK, t)
}

// ─── 规则集 ───────────────────────────────────────────────────────────────────

func (h *Handler) listSubRules(c *gin.Context) {
	c.JSON(http.StatusOK, h.store.ListSubRules())
}

func (h *Handler) createSubRule(c *gin.Context) {
	var r store.SubRule
	if err := c.ShouldBindJSON(&r); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if strings.TrimSpace(r.Name) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "name is required"})
		return
	}
	if err := h.store.AddSubRule(r); err != nil {
		c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
		return
	}
	h.hotReload()
	c.JSON(http.StatusCreated, r)
}

func (h *Handler) updateSubRule(c *gin.Context) {
	oldName := c.Param("name")
	var r store.SubRule
	if err := c.ShouldBindJSON(&r); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.store.UpdateSubRule(oldName, r); err != nil {
		status := http.StatusInternalServerError
		if err == store.ErrNotFound {
			status = http.StatusNotFound
		} else if strings.Contains(err.Error(), "already exists") {
			status = http.StatusConflict
		}
		c.JSON(status, gin.H{"error": err.Error()})
		return
	}
	h.hotReload()
	c.JSON(http.StatusOK, r)
}

func (h *Handler) deleteSubRule(c *gin.Context) {
	name := c.Param("name")
	if err := h.store.DeleteSubRule(name); err != nil {
		status := http.StatusInternalServerError
		if err == store.ErrNotFound {
			status = http.StatusNotFound
		}
		c.JSON(status, gin.H{"error": err.Error()})
		return
	}
	h.hotReload()
	c.Status(http.StatusNoContent)
}

// ─── DNS 设置 ─────────────────────────────────────────────────────────────────

func (h *Handler) getDNS(c *gin.Context) {
	c.JSON(http.StatusOK, h.store.GetDNS())
}

func (h *Handler) setDNS(c *gin.Context) {
	var cfg store.DNSConfig
	if err := c.ShouldBindJSON(&cfg); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.store.SetDNS(cfg); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	h.hotReload()
	c.JSON(http.StatusOK, cfg)
}

// ─── 设置 & 控制 ──────────────────────────────────────────────────────────────

func (h *Handler) getSettings(c *gin.Context) {
	c.JSON(http.StatusOK, h.store.GetSettings())
}

func (h *Handler) updateSettings(c *gin.Context) {
	var s store.AppSettings
	if err := c.ShouldBindJSON(&s); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.store.UpdateSettings(s); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	h.manager.SetMihomoPath(s.MihomoPath)
	c.JSON(http.StatusOK, s)
}

func (h *Handler) getStatus(c *gin.Context) {
	c.JSON(http.StatusOK, h.manager.Status())
}

func (h *Handler) startMihomo(c *gin.Context) {
	if err := h.manager.Start(h.store.GetConfigPath()); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "started"})
}

func (h *Handler) stopMihomo(c *gin.Context) {
	if err := h.manager.Stop(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "stopped"})
}

func (h *Handler) reloadConfig(c *gin.Context) {
	if err := h.store.Reload(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	h.hotReload()
	c.JSON(http.StatusOK, gin.H{"message": "reloaded"})
}

// hotReload 调用 mihomo API 热重载配置文件，mihomo 未运行时静默忽略。
// 必须在 body 中指定 path，否则 mihomo 会从默认目录重载而非 -f 指定的文件。
func (h *Handler) hotReload() {
	settings := h.store.GetSettings()
	configPath := h.store.GetConfigPath()

	body := strings.NewReader(fmt.Sprintf(`{"path":%q}`, configPath))
	req, err := http.NewRequestWithContext(context.Background(),
		http.MethodPut, settings.MihomoAPIURL+"/configs?force=true", body)
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	if settings.MihomoSecret != "" {
		req.Header.Set("Authorization", "Bearer "+settings.MihomoSecret)
	}
	c := &http.Client{Timeout: 3 * time.Second}
	resp, err := c.Do(req)
	if err != nil {
		return // mihomo 未运行，静默忽略
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body) // 排空 body，确保连接复用
}

// ─── 反代 mihomo API ─────────────────────────────────────────────────────────

var wsUpgrader = websocket.Upgrader{
	CheckOrigin: func(_ *http.Request) bool { return true },
}

// wsDialer 设置了明确的 TCP 连接超时，避免 mihomo 不可达时卡住整整一分钟
var wsDialer = &websocket.Dialer{
	HandshakeTimeout: 5 * time.Second,
	NetDialContext: (&net.Dialer{
		Timeout:   5 * time.Second,
		KeepAlive: 30 * time.Second,
	}).DialContext,
}

func (h *Handler) proxyMihomo(c *gin.Context) {
	settings := h.store.GetSettings()
	target, err := url.Parse(settings.MihomoAPIURL)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "invalid mihomo api url"})
		return
	}
	path := strings.TrimPrefix(c.Param("path"), "/")

	// WebSocket upgrade detection
	if strings.EqualFold(c.GetHeader("Upgrade"), "websocket") {
		h.proxyWebSocket(c, settings, target, path)
		return
	}

	// SSE passthrough
	if c.GetHeader("Accept") == "text/event-stream" {
		req, err := http.NewRequestWithContext(context.Background(), c.Request.Method,
			settings.MihomoAPIURL+"/"+path, c.Request.Body)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		req.Header = c.Request.Header.Clone()
		if settings.MihomoSecret != "" {
			req.Header.Set("Authorization", "Bearer "+settings.MihomoSecret)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
			return
		}
		defer resp.Body.Close()
		c.Writer.Header().Set("Content-Type", "text/event-stream")
		c.Writer.Header().Set("Cache-Control", "no-cache")
		c.Writer.WriteHeader(resp.StatusCode)
		_, _ = io.Copy(c.Writer, resp.Body)
		return
	}

	// Regular HTTP reverse proxy
	proxy := httputil.NewSingleHostReverseProxy(target)
	orig := proxy.Director
	proxy.Director = func(req *http.Request) {
		orig(req)
		req.URL.Path = "/" + path
		req.URL.RawQuery = stripMihopToken(c.Request.URL.RawQuery)
		if settings.MihomoSecret != "" {
			req.Header.Set("Authorization", "Bearer "+settings.MihomoSecret)
		}
	}
	proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, err error) {
		c.JSON(http.StatusBadGateway, gin.H{"error": "mihomo api unreachable: " + err.Error()})
	}
	proxy.ServeHTTP(c.Writer, c.Request)
}

func (h *Handler) proxyWebSocket(c *gin.Context, settings store.AppSettings, target *url.URL, path string) {
	// Build upstream WebSocket URL (http→ws, https→wss)
	wsScheme := "ws"
	if target.Scheme == "https" {
		wsScheme = "wss"
	}
	upstreamURL := fmt.Sprintf("%s://%s/%s", wsScheme, target.Host, path)
	// 过滤掉 Mihop 自身的 auth token，避免 mihomo 把它当作自己的鉴权 token
	if q := stripMihopToken(c.Request.URL.RawQuery); q != "" {
		upstreamURL += "?" + q
	}

	// Dial upstream mihomo WebSocket
	upHeader := http.Header{}
	if settings.MihomoSecret != "" {
		upHeader.Set("Authorization", "Bearer "+settings.MihomoSecret)
	}
	upConn, _, err := wsDialer.Dial(upstreamURL, upHeader)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": "mihomo ws unreachable: " + err.Error()})
		return
	}
	defer upConn.Close()

	// Upgrade the client (browser) connection
	downConn, err := wsUpgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		return // Upgrade itself writes the error response
	}
	defer downConn.Close()

	// Relay bidirectionally; stop when either side closes
	errc := make(chan error, 2)

	go func() {
		for {
			mt, msg, err := upConn.ReadMessage()
			if err != nil {
				errc <- err
				return
			}
			if err := downConn.WriteMessage(mt, msg); err != nil {
				errc <- err
				return
			}
		}
	}()

	go func() {
		for {
			mt, msg, err := downConn.ReadMessage()
			if err != nil {
				errc <- err
				return
			}
			if err := upConn.WriteMessage(mt, msg); err != nil {
				errc <- err
				return
			}
		}
	}()

	<-errc // wait for either goroutine to finish
}

// stripMihopToken 从 query string 中删除 Mihop 自身的 "token" 参数，
// 防止它被当作 mihomo API 的鉴权 token 转发出去。
func stripMihopToken(rawQuery string) string {
	q, err := url.ParseQuery(rawQuery)
	if err != nil {
		return rawQuery
	}
	q.Del("token")
	return q.Encode()
}

// ─── 校验 ─────────────────────────────────────────────────────────────────────

var mihomoReserved = map[string]bool{
	"DIRECT": true, "REJECT": true, "REJECT-DROP": true, "PASS": true, "COMPATIBLE": true,
}

func validateProxy(p store.Proxy) error {
	if strings.TrimSpace(p.Name) == "" {
		return fmt.Errorf("name is required")
	}
	if mihomoReserved[strings.ToUpper(p.Name)] {
		return fmt.Errorf("'%s' 是 mihomo 内置保留名称，不能用作代理名", p.Name)
	}
	valid := map[string]bool{
		"http": true, "socks5": true,
		"ss": true, "ssr": true,
		"snell": true,
		"vmess": true, "vless": true,
		"trojan": true, "anytls": true,
		"mieru": true, "sudoku": true,
		"hysteria": true, "hysteria2": true,
		"tuic": true, "wireguard": true,
		"ssh": true, "masque": true, "trusttunnel": true,
	}
	if !valid[p.Type] {
		return fmt.Errorf("invalid proxy type: %s", p.Type)
	}
	if strings.TrimSpace(p.Server) == "" {
		return fmt.Errorf("server is required")
	}
	if p.Port < 1 || p.Port > 65535 {
		return fmt.Errorf("port must be 1–65535")
	}
	return nil
}

// coerceExtras 将前端以字符串传入的 extra 值转换为合适的 Go 类型，
// 使 YAML 序列化时 "true"→true、"0"→0，而不是带引号的字符串。
func coerceExtras(extras map[string]interface{}) map[string]interface{} {
	if len(extras) == 0 {
		return extras
	}
	result := make(map[string]interface{}, len(extras))
	for k, v := range extras {
		s, ok := v.(string)
		if !ok {
			result[k] = v
			continue
		}
		switch s {
		case "true":
			result[k] = true
		case "false":
			result[k] = false
		default:
			if i, err := strconv.Atoi(s); err == nil {
				result[k] = i
			} else if f, err := strconv.ParseFloat(s, 64); err == nil {
				result[k] = f
			} else {
				result[k] = s
			}
		}
	}
	return result
}

func validateListener(l store.Listener) error {
	if l.LocalPort < 1 || l.LocalPort > 65535 {
		return fmt.Errorf("local_port must be 1–65535")
	}
	hasProxy := strings.TrimSpace(l.ProxyName) != ""
	hasRule := strings.TrimSpace(l.RuleName) != ""
	if !hasProxy && !hasRule {
		return fmt.Errorf("proxy_id or rule_id is required")
	}
	if hasProxy && hasRule {
		return fmt.Errorf("proxy_id and rule_id cannot both be set")
	}
	validTypes := map[string]bool{"http": true, "socks": true, "mixed": true}
	if l.Type != "" && !validTypes[l.Type] {
		return fmt.Errorf("listener type must be http, socks, or mixed")
	}
	return nil
}
