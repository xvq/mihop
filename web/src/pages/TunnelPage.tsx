import { useState, useRef, useEffect } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { line } from "d3-shape"
import { api, type Tunnel, type Proxy, type MihomoStatus } from "@/lib/api"
import { useMihomoConnections } from "@/hooks/use-mihomo-ws"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { Plus, Pencil, Trash2, Power, Loader2, Route, AlertTriangle, RefreshCw, ArrowRight } from "lucide-react"
import { useToast } from "@/hooks/use-toast"

// ─── 地址拆分 / 合并 ──────────────────────────────────────────────────────────

function parseAddress(addr: string): [string, string] {
  const i = addr.lastIndexOf(":")
  if (i === -1) return [addr, ""]
  return [addr.slice(0, i), addr.slice(i + 1)]
}

// ─── 流量图 ───────────────────────────────────────────────────────────────────

const WINDOW_MS = 60_000

function fmtSpeed(bps: number): string {
  if (bps < 1024) return `${bps.toFixed(0)} B/s`
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`
  return `${(bps / 1024 / 1024).toFixed(2)} MB/s`
}

const lineGen = line<[number, number]>().x(d => d[0]).y(d => d[1])

interface TimedPoint { value: number; ts: number }

function BackgroundSparkline({ data }: { data: TimedPoint[] }) {
  const lineRef = useRef<SVGPathElement>(null)
  const fillRef = useRef<SVGPathElement>(null)
  const dataRef = useRef<TimedPoint[]>(data)
  const stickyMax = useRef(1)

  useEffect(() => { dataRef.current = data }, [data])

  useEffect(() => {
    const W = 100, H = 100
    let rafId: number
    function frame() {
      const now     = Date.now()
      const raw     = dataRef.current
      const lastVal = raw.length > 0 ? raw[raw.length - 1].value : 0
      const pts: TimedPoint[] = [
        ...(raw.length === 0 ? [{ value: 0, ts: now - WINDOW_MS }] : raw),
        { value: lastVal, ts: now },
      ]
      const rawMax = Math.max(...pts.map(p => p.value), 1)
      stickyMax.current = Math.max(stickyMax.current * 0.9995, rawMax)
      const max = stickyMax.current
      const svgPts: [number, number][] = pts
        .map(p => [W * (1 - (now - p.ts) / WINDOW_MS), H - (p.value / max) * (H * 0.80) - H * 0.05] as [number, number])
        .filter(([x]) => x > -10)
      if (svgPts.length >= 2) {
        const linePath = lineGen(svgPts) ?? ""
        const x0 = svgPts[0][0].toFixed(2)
        const xN = svgPts[svgPts.length - 1][0].toFixed(2)
        lineRef.current?.setAttribute("d", linePath)
        fillRef.current?.setAttribute("d", `${linePath} L${xN},${H} L${x0},${H} Z`)
      }
      rafId = requestAnimationFrame(frame)
    }
    rafId = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(rafId)
  }, [])

  return (
    <div className="absolute right-0 top-0 bottom-0 w-3/5 pointer-events-none overflow-hidden"
      style={{ maskImage: "linear-gradient(to right, transparent 0%, black 36%)" }}>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="w-full h-full" overflow="hidden">
        <path ref={fillRef} fill="rgba(16,185,129,0.14)" />
        <path ref={lineRef} fill="none" stroke="rgba(16,185,129,0.72)" strokeWidth="1.5"
          vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  )
}

interface Stats { count: number; upRate: number; downRate: number; downHistory: TimedPoint[] }

// ─── 表单对话框 ───────────────────────────────────────────────────────────────

interface FormState {
  localHost: string
  localPort: string
  targetHost: string
  targetPort: string
  network: string
  proxy: string
  enabled: boolean
}

interface FormProps {
  open: boolean
  initial?: Tunnel
  proxies: Proxy[]
  onSave: (t: Tunnel, oldAddress: string) => void
  onClose: () => void
}

function buildFormState(initial?: Tunnel): FormState {
  if (initial) {
    const [lh, lp] = parseAddress(initial.address)
    const [th, tp] = parseAddress(initial.target)
    return {
      localHost: lh, localPort: lp,
      targetHost: th, targetPort: tp,
      network: initial.network,
      proxy: initial.proxy ?? "",
      enabled: initial.enabled,
    }
  }
  return { localHost: "0.0.0.0", localPort: "", targetHost: "", targetPort: "", network: "tcp+udp", proxy: "", enabled: true }
}

function TunnelForm({ open, initial, proxies, onSave, onClose }: FormProps) {
  const [form, setForm] = useState<FormState>(buildFormState(initial))
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({})

  function set<K extends keyof FormState>(k: K, v: FormState[K]) {
    setForm(prev => ({ ...prev, [k]: v }))
    setErrors(prev => ({ ...prev, [k]: undefined }))
  }

  function validate(): boolean {
    const errs: typeof errors = {}
    if (!form.localHost.trim()) errs.localHost = "必填"
    if (!form.localPort.trim() || isNaN(+form.localPort) || +form.localPort < 1 || +form.localPort > 65535)
      errs.localPort = "1-65535"
    if (!form.targetHost.trim()) errs.targetHost = "必填"
    if (!form.targetPort.trim() || isNaN(+form.targetPort) || +form.targetPort < 1 || +form.targetPort > 65535)
      errs.targetPort = "1-65535"
    setErrors(errs)
    return Object.keys(errs).length === 0
  }

  function handleSave() {
    if (!validate()) return
    const t: Tunnel = {
      address: `${form.localHost.trim()}:${form.localPort.trim()}`,
      target:  `${form.targetHost.trim()}:${form.targetPort.trim()}`,
      network: form.network,
      proxy:   form.proxy || undefined,
      enabled: form.enabled,
    }
    onSave(t, initial?.address ?? t.address)
  }

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{initial ? "编辑隧道" : "添加隧道"}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          {/* 本地监听地址 */}
          <div>
            <Label className="text-sm text-muted-foreground mb-1.5 block">本地监听地址</Label>
            <div className="grid grid-cols-[1fr_auto_160px] items-start gap-2">
              <div className="grid gap-1">
                <Input
                  value={form.localHost}
                  onChange={e => set("localHost", e.target.value)}
                  placeholder="0.0.0.0"
                  className="text-sm"
                />
                {errors.localHost && <p className="text-xs text-destructive">{errors.localHost}</p>}
              </div>
              <span className="text-slate-400 text-sm pt-2">:</span>
              <div className="grid gap-1">
                <Input
                  value={form.localPort}
                  onChange={e => set("localPort", e.target.value)}
                  placeholder="6553"
                  className="text-sm"
                  type="number" min={1} max={65535}
                />
                {errors.localPort && <p className="text-xs text-destructive">{errors.localPort}</p>}
              </div>
            </div>
          </div>

          {/* 转发目标地址 */}
          <div>
            <Label className="text-sm text-muted-foreground mb-1.5 block">转发目标地址</Label>
            <div className="grid grid-cols-[1fr_auto_160px] items-start gap-2">
              <div className="grid gap-1">
                <Input
                  value={form.targetHost}
                  onChange={e => set("targetHost", e.target.value)}
                  placeholder="8.8.8.8"
                  className="text-sm"
                />
                {errors.targetHost && <p className="text-xs text-destructive">{errors.targetHost}</p>}
              </div>
              <span className="text-slate-400 text-sm pt-2">:</span>
              <div className="grid gap-1">
                <Input
                  value={form.targetPort}
                  onChange={e => set("targetPort", e.target.value)}
                  placeholder="53"
                  className="text-sm"
                  type="number" min={1} max={65535}
                />
                {errors.targetPort && <p className="text-xs text-destructive">{errors.targetPort}</p>}
              </div>
            </div>
          </div>

          {/* 协议 + 代理 */}
          <div className="grid grid-cols-2 gap-4 min-w-0">
            <Field label="网络协议">
              <Select value={form.network} onValueChange={v => set("network", v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="tcp+udp">TCP + UDP</SelectItem>
                  <SelectItem value="tcp">TCP</SelectItem>
                  <SelectItem value="udp">UDP</SelectItem>
                </SelectContent>
              </Select>
            </Field>

            <Field label="上游代理">
              <Select
                value={form.proxy || "__none__"}
                onValueChange={v => set("proxy", v === "__none__" ? "" : v)}>
                <SelectTrigger className="min-w-0"><SelectValue placeholder="直连" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">DIRECT</SelectItem>
                  {proxies.length > 0 && <SelectSeparator />}
                  {proxies.map(p => (
                    <SelectItem key={p.name} value={p.name}>
                      <span className="flex items-center gap-2 min-w-0">
                        <span className="font-medium truncate">{p.name}</span>
                        <span className="text-xs text-muted-foreground shrink-0">{p.type.toUpperCase()}</span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button onClick={handleSave}>保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5 min-w-0">
      <Label className="text-sm text-muted-foreground">{label}</Label>
      {children}
    </div>
  )
}

// ─── 网络协议标签 ─────────────────────────────────────────────────────────────

const NETWORK_LABEL: Record<string, string> = {
  "tcp+udp": "TCP+UDP",
  "tcp": "TCP",
  "udp": "UDP",
}

// ─── 主组件 ───────────────────────────────────────────────────────────────────

export function TunnelPage() {
  const qc = useQueryClient()
  const { toast } = useToast()
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<Tunnel | undefined>()
  const [pendingDelete, setPendingDelete] = useState<Tunnel | null>(null)

  const { data: tunnels = [], isLoading, isError, refetch } = useQuery<Tunnel[]>({
    queryKey: ["tunnels"],
    queryFn: api.listTunnels,
  })
  const { data: proxies = [] } = useQuery<Proxy[]>({
    queryKey: ["proxies"],
    queryFn: api.listProxies,
  })
  const { data: status } = useQuery<MihomoStatus>({
    queryKey: ["status"],
    queryFn: api.getStatus,
    refetchInterval: 3000,
  })
  const connData = useMihomoConnections(status?.running ?? false)

  const prevTotals = useRef<Record<string, { up: number; down: number; ts: number }>>({})
  const historyRef = useRef<Record<string, TimedPoint[]>>({})
  const [statsMap, setStatsMap] = useState<Record<string, Stats>>({})

  useEffect(() => {
    if (!connData) return
    const conns = connData.connections ?? []
    const now   = Date.now()
    const next: Record<string, Stats> = {}

    for (const t of tunnels) {
      const [localHost, localPort] = parseAddress(t.address)
      const matching = conns.filter(c =>
        c.metadata?.inboundPort === localPort &&
        (localHost === "0.0.0.0" || c.metadata?.inboundIP === localHost)
      )
      const upTotal   = matching.reduce((s, c) => s + c.upload,   0)
      const downTotal = matching.reduce((s, c) => s + c.download, 0)

      const prev    = prevTotals.current[t.address]
      const elapsed = prev ? Math.max((now - prev.ts) / 1000, 0.1) : 1
      const upRate    = prev ? Math.max(0, upTotal   - prev.up)   / elapsed : 0
      const downRate  = prev ? Math.max(0, downTotal - prev.down) / elapsed : 0
      prevTotals.current[t.address] = { up: upTotal, down: downTotal, ts: now }

      const hist = historyRef.current[t.address] ?? []
      hist.push({ value: downRate, ts: now })
      historyRef.current[t.address] = hist.filter(p => p.ts >= now - WINDOW_MS - 1000)

      next[t.address] = {
        count: matching.length,
        upRate, downRate,
        downHistory: [...historyRef.current[t.address]],
      }
    }
    setStatsMap(next)
  }, [connData, tunnels])

  const createMut = useMutation({
    mutationFn: (t: Tunnel) => api.createTunnel(t),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["tunnels"] }); setShowForm(false) },
    onError: (e: Error) => toast({ title: "添加失败", description: e.message, variant: "destructive" }),
  })

  const updateMut = useMutation({
    mutationFn: ({ oldAddr, t }: { oldAddr: string; t: Tunnel }) => api.updateTunnel(oldAddr, t),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["tunnels"] }); setEditing(undefined) },
    onError: (e: Error) => toast({ title: "更新失败", description: e.message, variant: "destructive" }),
  })

  const deleteMut = useMutation({
    mutationFn: api.deleteTunnel,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["tunnels"] }); setPendingDelete(null) },
    onError: (e: Error) => { toast({ title: "删除失败", description: e.message, variant: "destructive" }); setPendingDelete(null) },
  })

  const toggleMut = useMutation({
    mutationFn: api.toggleTunnel,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tunnels"] }),
  })

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-5">
        <div>
          <h1 className="text-lg font-semibold text-slate-800 dark:text-slate-100">流量隧道</h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">转发本地 TCP/UDP 流量到目标地址</p>
        </div>
        <Button size="sm" onClick={() => setShowForm(true)}
          className="bg-indigo-600 hover:bg-indigo-700 text-white h-10 text-sm px-4">
          <Plus className="h-4 w-4 mr-1.5" />添加隧道
        </Button>
      </div>
      <div className="h-px bg-slate-200 dark:bg-slate-800 mx-6" />

      {/* Content */}
      <div className="flex-1 p-6">
        {isLoading && (
          <div className="flex items-center justify-center py-24 text-slate-400 gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="text-sm">加载中...</span>
          </div>
        )}

        {isError && (
          <div className="flex flex-col items-center justify-center py-24 gap-4">
            <div className="h-12 w-12 rounded-xl bg-red-50 dark:bg-red-950 flex items-center justify-center">
              <AlertTriangle className="h-6 w-6 text-red-400" />
            </div>
            <p className="text-sm text-slate-500 dark:text-slate-400">加载失败</p>
            <Button variant="outline" size="sm" onClick={() => refetch()} className="text-xs gap-1.5">
              <RefreshCw className="h-3.5 w-3.5" />重试
            </Button>
          </div>
        )}

        {!isLoading && !isError && tunnels.length === 0 && (
          <div className="flex flex-col items-center justify-center py-24">
            <div className="h-12 w-12 rounded-xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center mb-4">
              <Route className="h-6 w-6 text-slate-400" />
            </div>
            <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">还没有流量隧道</p>
            <Button variant="outline" size="sm" onClick={() => setShowForm(true)} className="text-xs">
              <Plus className="h-3.5 w-3.5 mr-1.5" />添加第一个
            </Button>
          </div>
        )}

        <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(400px, 1fr))" }}>
          {tunnels.map(t => {
            const port     = t.address.lastIndexOf(":") !== -1
              ? t.address.slice(t.address.lastIndexOf(":") + 1)
              : t.address
            const stats    = statsMap[t.address]
            const hasStats = !!connData

            return (
              <div key={t.address}
                className={`relative overflow-hidden bg-white dark:bg-slate-900 rounded-xl border shadow-sm hover:shadow-md transition-all
                  ${t.enabled ? "border-slate-200 dark:border-slate-700" : "border-slate-200 dark:border-slate-700 opacity-60"}`}>

                {/* 背景流量图 */}
                {hasStats && <BackgroundSparkline data={stats?.downHistory ?? []} />}

                <div className="relative p-4">
                  <div className="flex items-start gap-3">
                    <div className="flex-1 min-w-0">

                      {/* 第一行：状态点 + 端口 + 协议 */}
                      <div className="flex items-center gap-2 flex-wrap mb-3">
                        <span className="w-3 shrink-0 flex items-center justify-center mt-0.5">
                          <span className={`h-2 w-2 rounded-full ${t.enabled ? "bg-emerald-500" : "bg-slate-300 dark:bg-slate-600"}`} />
                        </span>
                        <span className="font-bold text-slate-800 dark:text-slate-100 text-xl leading-none tracking-tight">
                          :{port}
                        </span>
                        <span className="text-[11px] px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 font-semibold">
                          {NETWORK_LABEL[t.network] ?? t.network}
                        </span>
                      </div>

                      {/* 第二行：箭头 + 目标地址 + 代理 */}
                      <div className="flex items-center gap-2 mb-3">
                        <span className="w-3 shrink-0 flex items-center justify-center">
                          <ArrowRight className="h-3 w-3 text-slate-300 dark:text-slate-600" />
                        </span>
                        <span className="font-semibold text-slate-600 dark:text-slate-300 text-sm truncate">
                          {t.target}
                        </span>
                        {t.proxy && (
                          <span className="text-xs text-slate-400 dark:text-slate-500 shrink-0">
                            via {t.proxy}
                          </span>
                        )}
                      </div>

                      {/* 第三行：速率 + 连接数 */}
                      {hasStats && (
                        <div className="flex items-center gap-4 pt-2.5 pl-4 border-t border-slate-100 dark:border-slate-800">
                          <div className="flex items-center gap-1 text-xs text-indigo-500 dark:text-indigo-400 font-medium tabular-nums">
                            <span className="text-[10px] font-bold">↑</span>
                            <span>{fmtSpeed(stats?.upRate ?? 0)}</span>
                          </div>
                          <div className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400 font-medium tabular-nums">
                            <span className="text-[10px] font-bold">↓</span>
                            <span>{fmtSpeed(stats?.downRate ?? 0)}</span>
                          </div>
                          <div className="flex items-center gap-1 text-xs text-slate-400 dark:text-slate-500 font-medium">
                            <span className="h-1.5 w-1.5 rounded-full bg-slate-300 dark:bg-slate-600" />
                            <span>{stats?.count ?? 0} 个连接</span>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* 操作按钮 */}
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => toggleMut.mutate(t.address)}
                        title={t.enabled ? "禁用" : "启用"}
                        className={`h-8 w-8 flex items-center justify-center rounded-lg transition-colors
                          ${t.enabled
                            ? "text-emerald-500 hover:bg-emerald-50 dark:hover:bg-emerald-950"
                            : "text-slate-300 dark:text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-500 dark:hover:text-slate-400"}`}>
                        <Power className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => setEditing(t)}
                        className="h-8 w-8 flex items-center justify-center rounded-lg
                          text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-600 dark:hover:text-slate-300 transition-colors">
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => setPendingDelete(t)}
                        className="h-8 w-8 flex items-center justify-center rounded-lg
                          text-slate-400 hover:bg-red-50 dark:hover:bg-red-950 hover:text-red-500 dark:hover:text-red-400 transition-colors">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      <TunnelForm open={showForm} proxies={proxies}
        onSave={t => createMut.mutate(t)}
        onClose={() => setShowForm(false)} />
      {editing && (
        <TunnelForm open initial={editing} proxies={proxies}
          onSave={(t, oldAddr) => updateMut.mutate({ oldAddr, t })}
          onClose={() => setEditing(undefined)} />
      )}
      <ConfirmDialog
        open={!!pendingDelete}
        title={`删除隧道「${pendingDelete?.address}」`}
        description="此操作不可撤销。"
        onConfirm={() => pendingDelete && deleteMut.mutate(pendingDelete.address)}
        onClose={() => setPendingDelete(null)}
        loading={deleteMut.isPending}
      />
    </div>
  )
}
