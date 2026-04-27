import axios from "axios"

const BASE = import.meta.env.DEV ? "http://localhost:8080" : ""
export const client = axios.create({ baseURL: BASE })

// ─── Token 管理 ───────────────────────────────────────────────────────────────

const TOKEN_KEY = "mihop_token"

export const auth = {
  getToken:    ()          => localStorage.getItem(TOKEN_KEY),
  setToken:    (t: string) => localStorage.setItem(TOKEN_KEY, t),
  clearToken:  ()          => localStorage.removeItem(TOKEN_KEY),
  isLoggedIn:  ()          => !!localStorage.getItem(TOKEN_KEY),
}

// 每次请求自动携带 token
client.interceptors.request.use(cfg => {
  const tok = auth.getToken()
  if (tok) cfg.headers.Authorization = `Bearer ${tok}`
  return cfg
})

// 401 时清除 token 并跳转登录页
client.interceptors.response.use(
  r => r,
  err => {
    if (err.response?.status === 401 && window.location.pathname !== "/login") {
      auth.clearToken()
      window.location.href = "/login"
    }
    const serverMsg = err.response?.data?.error
    return Promise.reject(serverMsg ? new Error(serverMsg) : err)
  }
)

// Proxy：name 是唯一标识，对应 mihomo config 中的 name 字段
// extra 存放协议相关的任意 key-value，前端以动态表单填写
export interface Proxy {
  name: string
  type: string
  server: string
  port: number
  extra?: Record<string, string>
}

export interface UserEntry {
  username: string
  password: string
}

// Listener：local_port 作为 ID
export interface Listener {
  name?: string       // 自定义名称，空则自动生成 mihop-{port}
  local_port: number  // 也是 API ID
  type: string        // http / socks / mixed
  proxy_id: string    // 代理模式：引用 Proxy.name
  rule_id: string     // 规则模式：引用 SubRule.name
  enabled: boolean
  users?: UserEntry[] // 认证用户列表，空则不设置 users 键
  listen?: string     // 监听地址，默认 0.0.0.0
}

// Tunnel：address（host:port）作为 ID
export interface Tunnel {
  address: string     // 本地监听地址，如 127.0.0.1:6553
  network: string     // "tcp" | "udp" | "tcp+udp"
  target: string      // 转发目标地址
  proxy?: string      // 可选代理名
  enabled: boolean
}

export interface RuleEntry {
  type: string
  value: string       // MATCH 时为空
  target: string      // 代理名 / DIRECT / REJECT
  no_resolve: boolean // 仅 IP 类规则有效
}

export interface SubRule {
  name: string
  entries: RuleEntry[]
}

// DNSConfig：hosts 中多个 IP 用逗号分隔，如 "1.1.1.1, 2.2.2.2"
export interface DNSConfig {
  enable: boolean
  default_nameserver: string[]
  nameserver: string[]
  enhanced_mode: string
  fake_ip_range: string
  fake_ip_filter: string[]
  nameserver_policy: Record<string, string>
  hosts: Record<string, string>
}

export interface AppSettings {
  mihomo_path: string
  mihomo_api_url: string
  mihomo_secret: string
}

export interface MihomoStatus {
  running: boolean
  started_at?: string
  pid?: number
}

export interface TestResult {
  reachable: boolean
  latency_ms?: number
  error?: string
}

export interface MihomoConnection {
  id: string
  upload: number    // bytes total
  download: number  // bytes total
  start: string
  chains: string[]
  rule: string
  metadata: {
    network: string
    type: string
    sourceIP: string
    destinationIP: string
    host: string
    inboundIP?: string
    inboundPort?: string
    processPath?: string
    specialRules?: string  // 规则模式时为规则集名称
  }
}

export interface MihomoConnectionsResp {
  downloadTotal: number
  uploadTotal: number
  connections: MihomoConnection[]
}

export const api = {
  // 认证
  login:  (password: string) =>
    client.post<{ token: string }>("/api/login", { username: "admin", password }).then(r => r.data),
  logout: () => client.post("/api/logout"),

  // 上游代理（:id = proxy name）
  listProxies:  () => client.get<Proxy[]>("/api/proxies").then(r => r.data),
  createProxy:  (p: Proxy) => client.post<Proxy>("/api/proxies", p).then(r => r.data),
  updateProxy:  (oldId: string, p: Proxy) => client.put<Proxy>(`/api/proxies/${encodeURIComponent(oldId)}`, p).then(r => r.data),
  deleteProxy:  (id: string) => client.delete(`/api/proxies/${encodeURIComponent(id)}`),
  testProxy:    (id: string) => client.post<TestResult>(`/api/proxies/${encodeURIComponent(id)}/test`).then(r => r.data),

  // 流量隧道（address URL encoded）
  listTunnels:   () => client.get<Tunnel[]>("/api/tunnels").then(r => r.data),
  createTunnel:  (t: Tunnel) => client.post<Tunnel>("/api/tunnels", t).then(r => r.data),
  updateTunnel:  (oldAddr: string, t: Tunnel) =>
    client.put<Tunnel>(`/api/tunnels/${encodeURIComponent(oldAddr)}`, t).then(r => r.data),
  deleteTunnel:  (addr: string) => client.delete(`/api/tunnels/${encodeURIComponent(addr)}`),
  toggleTunnel:  (addr: string) =>
    client.post<Tunnel>(`/api/tunnels/${encodeURIComponent(addr)}/toggle`).then(r => r.data),

  // 规则集
  listSubRules:  () => client.get<SubRule[]>("/api/rules").then(r => r.data),
  createSubRule: (r: SubRule) => client.post<SubRule>("/api/rules", r).then(r => r.data),
  updateSubRule: (oldName: string, r: SubRule) =>
    client.put<SubRule>(`/api/rules/${encodeURIComponent(oldName)}`, r).then(r => r.data),
  deleteSubRule: (name: string) => client.delete(`/api/rules/${encodeURIComponent(name)}`),

  // DNS 设置
  getDNS: () => client.get<DNSConfig>("/api/dns").then(r => r.data),
  setDNS: (c: DNSConfig) => client.put<DNSConfig>("/api/dns", c).then(r => r.data),

  // 本地监听（:port = local_port）
  listListeners:  () => client.get<Listener[]>("/api/listeners").then(r => r.data),
  createListener: (l: Listener) => client.post<Listener>("/api/listeners", l).then(r => r.data),
  updateListener: (port: number, l: Listener) => client.put<Listener>(`/api/listeners/${port}`, l).then(r => r.data),
  deleteListener: (port: number) => client.delete(`/api/listeners/${port}`),
  toggleListener: (port: number) => client.post<Listener>(`/api/listeners/${port}/toggle`).then(r => r.data),

  // mihomo 原生 API
  getMihomoConnections: () =>
    client.get<MihomoConnectionsResp>("/api/mihomo/connections").then(r => r.data),

  // 控制
  getSettings:    () => client.get<AppSettings>("/api/settings").then(r => r.data),
  updateSettings: (s: AppSettings) => client.put<AppSettings>("/api/settings", s).then(r => r.data),
  getStatus:      () => client.get<MihomoStatus>("/api/status").then(r => r.data),
  startMihomo:    () => client.post<{ message: string }>("/api/start").then(r => r.data),
  stopMihomo:     () => client.post("/api/stop"),
  reloadConfig:   () => client.post<{ message: string }>("/api/reload").then(r => r.data),
}
