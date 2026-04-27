import { useState } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { api, type Proxy } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { ProxyForm } from "@/components/ProxyForm"
import { Plus, Pencil, Trash2, Wifi, Loader2, Server, CheckCircle, XCircle, AlertTriangle, RefreshCw } from "lucide-react"
import { useToast } from "@/hooks/use-toast"

const TYPE_COLOR: Record<string, string> = {
  socks5: "bg-blue-50 text-blue-600 dark:bg-blue-950 dark:text-blue-400",
  http:   "bg-emerald-50 text-emerald-600 dark:bg-emerald-950 dark:text-emerald-400",
  ss:     "bg-violet-50 text-violet-600 dark:bg-violet-950 dark:text-violet-400",
  trojan: "bg-orange-50 text-orange-600 dark:bg-orange-950 dark:text-orange-400",
  vmess:  "bg-rose-50 text-rose-600 dark:bg-rose-950 dark:text-rose-400",
  anytls: "bg-cyan-50 text-cyan-600 dark:bg-cyan-950 dark:text-cyan-400",
}

export function ProxyPage() {
  const qc = useQueryClient()
  const { toast } = useToast()
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<Proxy | undefined>()
  const [testingId, setTestingId] = useState<string | null>(null)
  const [testResults, setTestResults] = useState<Record<string, { reachable: boolean; latency_ms?: number }>>({})
  const [pendingDelete, setPendingDelete] = useState<Proxy | null>(null)

  const { data: proxies = [], isLoading, isError, refetch } = useQuery<Proxy[]>({
    queryKey: ["proxies"],
    queryFn: api.listProxies,
  })

  const createMut = useMutation({
    mutationFn: (p: Proxy) => api.createProxy(p),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["proxies"] }); setShowForm(false) },
    onError: (e: Error) => toast({ title: "添加失败", description: e.message, variant: "destructive" }),
  })

  const updateMut = useMutation({
    mutationFn: ({ oldId, p }: { oldId: string; p: Proxy }) => api.updateProxy(oldId, p),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["proxies"] })
      qc.invalidateQueries({ queryKey: ["listeners"] })
      setEditing(undefined)
    },
    onError: (e: Error) => toast({ title: "更新失败", description: e.message, variant: "destructive" }),
  })

  const deleteMut = useMutation({
    mutationFn: api.deleteProxy,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["proxies"] }); setPendingDelete(null) },
    onError: (e: Error) => { toast({ title: "删除失败", description: e.message, variant: "destructive" }); setPendingDelete(null) },
  })

  async function handleTest(proxy: Proxy) {
    setTestingId(proxy.name)
    try {
      const result = await api.testProxy(proxy.name)
      setTestResults(prev => ({ ...prev, [proxy.name]: result }))
      toast(result.reachable
        ? { title: `${proxy.name} 连通`, description: `延迟 ${result.latency_ms} ms` }
        : { title: `${proxy.name} 不可达`, description: result.error, variant: "destructive" })
    } catch {
      toast({ title: "测试失败", variant: "destructive" })
    } finally {
      setTestingId(null)
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-5">
        <div>
          <h1 className="text-lg font-semibold text-slate-800 dark:text-slate-100">上游代理</h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">代理服务器，可被多个本地端口复用</p>
        </div>
        <Button size="sm" onClick={() => setShowForm(true)}
          className="bg-indigo-600 hover:bg-indigo-700 text-white h-10 text-sm px-4">
          <Plus className="h-4 w-4 mr-1.5" />添加代理
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

        {!isLoading && !isError && proxies.length === 0 && (
          <div className="flex flex-col items-center justify-center py-24">
            <div className="h-12 w-12 rounded-xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center mb-4">
              <Server className="h-6 w-6 text-slate-400" />
            </div>
            <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">还没有上游代理</p>
            <Button variant="outline" size="sm" onClick={() => setShowForm(true)} className="text-xs">
              <Plus className="h-3.5 w-3.5 mr-1.5" />添加第一个
            </Button>
          </div>
        )}

        <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(480px, 1fr))" }}>
          {proxies.map(proxy => {
            const testResult = testResults[proxy.name]
            const isTesting  = testingId === proxy.name
            return (
              <div key={proxy.name}
                className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm hover:shadow-md transition-all">
                <div className="p-4">
                  <div className="flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2.5 flex-wrap mb-1.5">
                        <span className="font-bold text-slate-800 dark:text-slate-100 text-lg leading-tight">{proxy.name}</span>
                        <span className={`text-[11px] px-2 py-0.5 rounded-full font-semibold ${TYPE_COLOR[proxy.type] ?? "bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400"}`}>
                          {proxy.type.toUpperCase()}
                        </span>
                        {testResult && (
                          <span className={`text-xs flex items-center gap-1 font-medium
                            ${testResult.reachable ? "text-emerald-600 dark:text-emerald-400" : "text-red-500 dark:text-red-400"}`}>
                            {testResult.reachable
                              ? <><CheckCircle className="h-3 w-3" />{testResult.latency_ms} ms</>
                              : <><XCircle className="h-3 w-3" />不可达</>}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-slate-400 dark:text-slate-500 font-mono tracking-tight">
                        {proxy.server}{proxy.port ? `:${proxy.port}` : ""}
                        {proxy.extra?.username && <span className="ml-2 opacity-70">· {proxy.extra.username}</span>}
                      </p>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => handleTest(proxy)}
                        disabled={isTesting}
                        title="测试连通性"
                        className="h-8 w-8 flex items-center justify-center rounded-lg
                          text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-600 dark:hover:text-slate-300
                          transition-colors disabled:opacity-40">
                        {isTesting
                          ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          : <Wifi className="h-3.5 w-3.5" />}
                      </button>
                      <button
                        onClick={() => setEditing(proxy)}
                        className="h-8 w-8 flex items-center justify-center rounded-lg
                          text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-600 dark:hover:text-slate-300
                          transition-colors">
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => setPendingDelete(proxy)}
                        className="h-8 w-8 flex items-center justify-center rounded-lg
                          text-slate-400 hover:bg-red-50 dark:hover:bg-red-950 hover:text-red-500 dark:hover:text-red-400
                          transition-colors">
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

      <ProxyForm open={showForm}
        onSave={(p, _oldId) => createMut.mutate(p)}
        onClose={() => setShowForm(false)} />
      {editing && (
        <ProxyForm open initial={editing}
          onSave={(p, oldId) => updateMut.mutate({ oldId, p })}
          onClose={() => setEditing(undefined)} />
      )}
      <ConfirmDialog
        open={!!pendingDelete}
        title={`删除代理「${pendingDelete?.name}」`}
        description="此操作不可撤销，引用此代理的本地监听将失去关联。"
        onConfirm={() => pendingDelete && deleteMut.mutate(pendingDelete.name)}
        onClose={() => setPendingDelete(null)}
        loading={deleteMut.isPending}
      />
    </div>
  )
}
