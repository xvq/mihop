import { useState, useRef, useEffect } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { line } from "d3-shape"
import { api, type Listener, type Proxy, type SubRule, type MihomoStatus } from "@/lib/api"
import { useMihomoConnections } from "@/hooks/use-mihomo-ws"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { ListenerForm } from "@/components/ListenerForm"
import { Plus, Pencil, Trash2, Power, Loader2, ArrowRight, Cable, AlertTriangle, RefreshCw } from "lucide-react"
import { useToast } from "@/hooks/use-toast"

const BUILTIN   = new Set(["DIRECT", "REJECT", "REJECT-DROP", "PASS"])
const WINDOW_MS = 60_000   // 横轴固定显示 60 秒

// ─── 工具 ─────────────────────────────────────────────────────────────────────

function fmtSpeed(bps: number): string {
  if (bps < 1024) return `${bps.toFixed(0)} B/s`
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`
  return `${(bps / 1024 / 1024).toFixed(2)} MB/s`
}

// ─── d3-shape line generator（Catmull-Rom，alpha=0.5 向心参数）───────────────

const lineGen = line<[number, number]>()
  .x(d => d[0])
  .y(d => d[1])

// ─── 背景流量图 ───────────────────────────────────────────────────────────────
// 每个数据点带真实时间戳。
// RAF 每帧根据 Date.now() 计算 X 坐标，横轴固定 WINDOW_MS 宽，
// 时钟驱动滚动，不依赖数据更新，不会跳变。

interface TimedPoint { value: number; ts: number }

function BackgroundSparkline({ data }: { data: TimedPoint[] }) {
  const lineRef = useRef<SVGPathElement>(null)
  const fillRef = useRef<SVGPathElement>(null)
  const dataRef = useRef<TimedPoint[]>(data)
  // Y 轴最大值用"粘性衰减"：新高值立即更新，无新高值时缓慢下降，避免刻度突变
  const stickyMax = useRef(1)

  useEffect(() => { dataRef.current = data }, [data])

  useEffect(() => {
    const W = 100
    const H = 100
    let rafId: number

    function frame() {
      const now     = Date.now()
      const raw     = dataRef.current
      const lastVal = raw.length > 0 ? raw[raw.length - 1].value : 0

      const pts: TimedPoint[] = [
        // 无数据时插一个左锚点画平线；有数据时直接用真实点，让折线自然从右往左流
        ...(raw.length === 0 ? [{ value: 0, ts: now - WINDOW_MS }] : raw),
        { value: lastVal, ts: now }, // 右锚点，保证折线贴住右边缘
      ]

      // 粘性 max：每帧以 0.9995 衰减（~60 秒后降至峰值的 16%），新高立即更新
      const rawMax = Math.max(...pts.map(p => p.value), 1)
      stickyMax.current = Math.max(stickyMax.current * 0.9995, rawMax)
      const max = stickyMax.current

      const svgPts: [number, number][] = pts
        .map(p => [
          W * (1 - (now - p.ts) / WINDOW_MS),
          H - (p.value / max) * (H * 0.80) - H * 0.05,
        ] as [number, number])
        .filter(([x]) => x > -10)

      if (svgPts.length >= 2) {
        const linePath = lineGen(svgPts) ?? ""
        const x0   = svgPts[0][0].toFixed(2)
        const xN   = svgPts[svgPts.length - 1][0].toFixed(2)
        const fill = `${linePath} L${xN},${H} L${x0},${H} Z`
        lineRef.current?.setAttribute("d", linePath)
        fillRef.current?.setAttribute("d", fill)
      }

      rafId = requestAnimationFrame(frame)
    }

    rafId = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(rafId)
  }, [])

  return (
    <div
      className="absolute right-0 top-0 bottom-0 w-3/5 pointer-events-none overflow-hidden"
      style={{ maskImage: "linear-gradient(to right, transparent 0%, black 36%)" }}
    >
      <svg viewBox="0 0 100 100" preserveAspectRatio="none"
        className="w-full h-full" overflow="hidden">
        <path ref={fillRef} fill="rgba(16,185,129,0.14)" />
        <path ref={lineRef} fill="none" stroke="rgba(16,185,129,0.72)" strokeWidth="1.5"
          vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  )
}


// ─── 每个监听的统计 ────────────────────────────────────────────────────────────

interface Stats {
  count:     number
  upRate:    number
  downRate:  number
  downHistory: TimedPoint[]
}

// ─── 主组件 ───────────────────────────────────────────────────────────────────

export function ListenerPage() {
  const qc = useQueryClient()
  const { toast } = useToast()
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<Listener | undefined>()
  const [pendingDelete, setPendingDelete] = useState<Listener | null>(null)

  const { data: listeners = [], isLoading, isError, refetch } = useQuery<Listener[]>({
    queryKey: ["listeners"],
    queryFn: api.listListeners,
  })
  const { data: proxies = [] } = useQuery<Proxy[]>({
    queryKey: ["proxies"],
    queryFn: api.listProxies,
  })
  const { data: subRules = [] } = useQuery<SubRule[]>({
    queryKey: ["subRules"],
    queryFn: api.listSubRules,
  })
  // 复用 Navbar 里相同 queryKey 的查询，React Query 自动共享缓存，不会发额外请求
  const { data: status } = useQuery<MihomoStatus>({
    queryKey: ["status"],
    queryFn: api.getStatus,
    refetchInterval: 3000,
  })
  const connData = useMihomoConnections(status?.running ?? false)

  // ts 字段记录上次更新时间，用于计算真实经过时长（WebSocket 推送间隔不固定）
  const prevTotals = useRef<Record<string, { up: number; down: number; ts: number }>>({})
  const historyRef = useRef<Record<string, TimedPoint[]>>({})
  const [statsMap, setStatsMap] = useState<Record<string, Stats>>({})

  useEffect(() => {
    if (!connData) return
    const conns = connData.connections ?? []
    const now   = Date.now()
    const next: Record<string, Stats> = {}

    for (const l of listeners) {
      // stat key: rule_id for rule-mode, proxy_id for proxy-mode
      const statKey  = l.rule_id || l.proxy_id
      const isRule   = !!l.rule_id
      const matching = isRule
        ? conns.filter(c => c.metadata?.specialRules === l.rule_id)
        : conns.filter(c => c.chains.includes(l.proxy_id))
      const upTotal   = matching.reduce((s, c) => s + c.upload,   0)
      const downTotal = matching.reduce((s, c) => s + c.download, 0)

      const prev    = prevTotals.current[statKey]
      // 用实际经过时长计算速率，避免 WebSocket 推送间隔不等于 POLL_MS 时速率失真
      const elapsed = prev ? Math.max((now - prev.ts) / 1000, 0.1) : 1
      const upRate    = prev ? Math.max(0, upTotal   - prev.up)   / elapsed : 0
      const downRate  = prev ? Math.max(0, downTotal - prev.down) / elapsed : 0
      prevTotals.current[statKey] = { up: upTotal, down: downTotal, ts: now }

      // 只按时间窗口裁剪，不用 slice(-N)，避免 WebSocket 高频推送时截掉过多历史数据
      const hist   = historyRef.current[statKey] ?? []
      hist.push({ value: downRate, ts: now })
      const cutoff = now - WINDOW_MS - 1000
      historyRef.current[statKey] = hist.filter(p => p.ts >= cutoff)

      next[statKey] = {
        count: matching.length,
        upRate, downRate,
        downHistory: [...historyRef.current[statKey]],
      }
    }
    setStatsMap(next)
  }, [connData, listeners])

  const proxyMap   = Object.fromEntries(proxies.map(p => [p.name, p]))
  const subRuleMap = Object.fromEntries(subRules.map(r => [r.name, r]))

  const createMut = useMutation({
    mutationFn: (l: Listener) => api.createListener(l),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["listeners"] }); setShowForm(false) },
    onError: (e: Error) => toast({ title: "添加失败", description: e.message, variant: "destructive" }),
  })
  const updateMut = useMutation({
    mutationFn: ({ port, l }: { port: number; l: Listener }) => api.updateListener(port, l),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["listeners"] }); setEditing(undefined) },
    onError: (e: Error) => toast({ title: "更新失败", description: e.message, variant: "destructive" }),
  })
  const deleteMut = useMutation({
    mutationFn: api.deleteListener,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["listeners"] }); setPendingDelete(null) },
    onError: (e: Error) => { toast({ title: "删除失败", description: e.message, variant: "destructive" }); setPendingDelete(null) },
  })
  const toggleMut = useMutation({
    mutationFn: api.toggleListener,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["listeners"] }),
  })

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-5">
        <div>
          <h1 className="text-lg font-semibold text-slate-800 dark:text-slate-100">本地监听</h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">将本地端口绑定到上游代理</p>
        </div>
        <Button size="sm" onClick={() => setShowForm(true)}
          className="bg-indigo-600 hover:bg-indigo-700 text-white h-10 text-sm px-4">
          <Plus className="h-4 w-4 mr-1.5" />添加监听
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

        {!isLoading && !isError && listeners.length === 0 && (
          <div className="flex flex-col items-center justify-center py-24">
            <div className="h-12 w-12 rounded-xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center mb-4">
              <Cable className="h-6 w-6 text-slate-400" />
            </div>
            <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">还没有本地监听端口</p>
            <Button variant="outline" size="sm" onClick={() => setShowForm(true)} className="text-xs">
              <Plus className="h-3.5 w-3.5 mr-1.5" />添加第一个
            </Button>
          </div>
        )}

        <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(480px, 1fr))" }}>
          {listeners.map(l => {
            const isRuleMode = !!l.rule_id
            const statKey    = l.rule_id || l.proxy_id
            const proxy      = proxyMap[l.proxy_id]
            const subRule    = subRuleMap[l.rule_id]
            const isBuiltin  = BUILTIN.has(l.proxy_id)
            const stats      = statsMap[statKey]
            const hasStats   = !!connData

            return (
              <div key={l.local_port}
                className={`relative overflow-hidden bg-white dark:bg-slate-900 rounded-xl border shadow-sm hover:shadow-md transition-all
                  ${l.enabled ? "border-slate-200 dark:border-slate-700" : "border-slate-200 dark:border-slate-700 opacity-60"}`}>

                {/* 背景流量图 */}
                {hasStats && (
                  <BackgroundSparkline data={stats?.downHistory ?? []} />
                )}

                {/* 卡片内容 */}
                <div className="relative p-4">
                  <div className="flex items-start gap-3">
                    <div className="flex-1 min-w-0">

                      {/* 第一行：:端口 / 名字 · 类型 */}
                      <div className="flex items-center gap-2 flex-wrap mb-3">
                        <span className="w-3 shrink-0 flex items-center justify-center mt-0.5">
                          <span className={`h-2 w-2 rounded-full ${l.enabled ? "bg-emerald-500" : "bg-slate-300 dark:bg-slate-600"}`} />
                        </span>
                        <span className="font-bold text-slate-800 dark:text-slate-100 text-xl leading-none tracking-tight">
                          :{l.local_port}
                        </span>
                        {l.name && (
                          <>
                            <span className="text-slate-300 dark:text-slate-600 text-lg leading-none font-light">/</span>
                            <span className="text-slate-500 dark:text-slate-400 text-lg font-bold leading-none truncate">
                              {l.name}
                            </span>
                          </>
                        )}
                        <span className="text-[11px] px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 font-semibold">
                          {(l.type || "mixed").toUpperCase()}
                        </span>
                      </div>

                      {/* 第二行：目标，箭头用 w-3 容器与上方状态圆点对齐 */}
                      <div className="flex items-center gap-2 mb-3">
                        <span className="w-3 shrink-0 flex items-center justify-center">
                          <ArrowRight className="h-3 w-3 text-slate-300 dark:text-slate-600" />
                        </span>
                        {isRuleMode ? (
                          subRule ? (
                            <span className="flex items-center gap-1.5 min-w-0">
                              <span className="font-semibold text-slate-600 dark:text-slate-300 text-sm truncate">{subRule.name}</span>
                              <span className="text-xs text-slate-400 dark:text-slate-500 shrink-0">{subRule.entries.length} 条规则</span>
                            </span>
                          ) : (
                            <span className="text-xs text-red-400 italic">未知规则集 ({l.rule_id})</span>
                          )
                        ) : (
                          proxy ? (
                            <span className="flex items-center gap-1.5 min-w-0">
                              <span className="font-semibold text-slate-600 dark:text-slate-300 text-sm truncate">{proxy.name}</span>
                              <span className="text-xs text-slate-400 dark:text-slate-500 font-mono shrink-0">{proxy.server}:{proxy.port}</span>
                            </span>
                          ) : isBuiltin ? (
                            <span className="flex items-center gap-1.5">
                              <span className="font-semibold text-slate-600 dark:text-slate-300 text-sm">{l.proxy_id}</span>
                              <span className="text-xs text-slate-400 dark:text-slate-500">内置</span>
                            </span>
                          ) : (
                            <span className="text-xs text-red-400 italic">未知代理 ({l.proxy_id})</span>
                          )
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
                        onClick={() => toggleMut.mutate(l.local_port)}
                        title={l.enabled ? "禁用" : "启用"}
                        className={`h-8 w-8 flex items-center justify-center rounded-lg transition-colors
                          ${l.enabled
                            ? "text-emerald-500 hover:bg-emerald-50 dark:hover:bg-emerald-950"
                            : "text-slate-300 dark:text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-500 dark:hover:text-slate-400"}`}>
                        <Power className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => setEditing(l)}
                        className="h-8 w-8 flex items-center justify-center rounded-lg
                          text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-600 dark:hover:text-slate-300 transition-colors">
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => setPendingDelete(l)}
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

      <ListenerForm open={showForm} proxies={proxies} subRules={subRules}
        onSave={(l, _) => createMut.mutate(l)}
        onClose={() => setShowForm(false)} />
      {editing && (
        <ListenerForm open initial={editing} proxies={proxies} subRules={subRules}
          onSave={(l, oldPort) => updateMut.mutate({ port: oldPort, l })}
          onClose={() => setEditing(undefined)} />
      )}
      <ConfirmDialog
        open={!!pendingDelete}
        title={`删除监听端口 ${pendingDelete?.local_port}`}
        description={pendingDelete?.name ? `「${pendingDelete.name}」将被移除，此操作不可撤销。` : "此操作不可撤销。"}
        onConfirm={() => pendingDelete && deleteMut.mutate(pendingDelete.local_port)}
        onClose={() => setPendingDelete(null)}
        loading={deleteMut.isPending}
      />
    </div>
  )
}
