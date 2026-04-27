import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { useNavigate, useLocation } from "react-router-dom"
import { api, auth, type MihomoStatus } from "@/lib/api"
import { ChevronsLeftRightEllipsis, Server, Settings, Play, Square, Loader2, Sun, Moon, UserCircle2, LogOut, Globe, Waypoints, Route } from "lucide-react"
import { useToast } from "@/hooks/use-toast"

const NAV = [
  { path: "/listeners", label: "本地监听", icon: ChevronsLeftRightEllipsis },
  { path: "/tunnels",   label: "流量隧道", icon: Route },
  { path: "/proxies",   label: "上游代理", icon: Server },
  { path: "/rules",     label: "规则集",   icon: Waypoints },
  { path: "/dns",       label: "DNS",      icon: Globe },
  { path: "/settings",  label: "设置",     icon: Settings },
]

interface Props {
  dark: boolean
  onToggleDark: () => void
}

export function Sidebar({ dark, onToggleDark }: Props) {
  const navigate     = useNavigate()
  const { pathname } = useLocation()
  const qc           = useQueryClient()
  const { toast }    = useToast()

  const { data: status } = useQuery<MihomoStatus>({
    queryKey: ["status"],
    queryFn: api.getStatus,
    refetchInterval: 3000,
  })

  const startMut = useMutation({
    mutationFn: api.startMihomo,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["status"] }) },
    onError: (e: Error) => toast({ title: "启动失败", description: e.message, variant: "destructive" }),
  })

  const stopMut = useMutation({
    mutationFn: api.stopMihomo,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["status"] }) },
    onError: (e: Error) => toast({ title: "停止失败", description: e.message, variant: "destructive" }),
  })

  const running = status?.running ?? false
  const busy    = startMut.isPending || stopMut.isPending

  return (
    <aside className="w-64 shrink-0 flex flex-col h-screen
      bg-white dark:bg-slate-900
      border-r border-slate-200 dark:border-slate-800
      z-20">

      {/* Logo */}
      <div className="px-4 py-5 flex items-center gap-2.5">
        <img src="/logo.png" alt="Mihop" className="h-8 w-8 rounded-lg shrink-0 object-contain" />
        <span className="font-bold text-slate-800 dark:text-slate-100 tracking-tight text-[15px] select-none">
          Mihop
        </span>
      </div>

      <div className="h-px bg-slate-100 dark:bg-slate-800 mx-3" />

      {/* Nav items */}
      <nav className="flex-1 px-3 py-3 flex flex-col gap-0.5">
        {NAV.map(({ path, label, icon: Icon }) => (
          <button
            key={path}
            onClick={() => navigate(path)}
            className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm font-medium transition-all text-left
              ${pathname === path
                ? "bg-indigo-600 text-white shadow-sm"
                : "text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-800 dark:hover:text-slate-100"
              }`}
          >
            <Icon className="h-4 w-4 shrink-0" />
            {label}
          </button>
        ))}
      </nav>

      <div className="h-px bg-slate-100 dark:bg-slate-800 mx-3" />

      {/* mihomo 状态 + 控制 */}
      <div className="px-4 py-4 flex flex-col gap-3">
        {/* 状态指示 */}
        <div className="flex items-center justify-center gap-2">
          <span className="relative flex h-2 w-2 shrink-0">
            {running && (
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
            )}
            <span className={`relative inline-flex rounded-full h-2 w-2 ${running ? "bg-emerald-500" : "bg-slate-300 dark:bg-slate-600"}`} />
          </span>
          <span className={`text-xs font-medium ${running ? "text-emerald-600 dark:text-emerald-400" : "text-slate-400 dark:text-slate-500"}`}>
            {running ? "运行中" : "已停止"}
          </span>
        </div>

        {/* 启动 / 停止 */}
        {running ? (
          <button
            onClick={() => stopMut.mutate()}
            disabled={busy}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-lg text-sm font-medium
              bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300
              hover:bg-slate-200 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700
              transition-colors disabled:opacity-50"
          >
            {stopMut.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3.5 w-3.5" />}
            停止
          </button>
        ) : (
          <button
            onClick={() => startMut.mutate()}
            disabled={busy}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-lg text-sm font-medium
              bg-indigo-600 text-white hover:bg-indigo-700
              transition-colors disabled:opacity-50 shadow-sm"
          >
            {startMut.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
            启动
          </button>
        )}
      </div>

      <div className="h-px bg-slate-100 dark:bg-slate-800 mx-3" />

      {/* 底部工具栏 */}
      <div className="px-3 py-3 flex items-center justify-between">
        {/* 深色模式 */}
        <button
          onClick={onToggleDark}
          title={dark ? "切换浅色模式" : "切换深色模式"}
          className="h-8 w-8 flex items-center justify-center rounded-lg
            text-slate-400 hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300
            hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
        >
          {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </button>

        {/* 用户菜单 */}
        <div className="relative group">
          <button
            className="h-8 w-8 flex items-center justify-center rounded-lg
              text-slate-400 hover:text-indigo-600 dark:text-slate-500 dark:hover:text-indigo-400
              hover:bg-indigo-50 dark:hover:bg-indigo-950 transition-colors"
          >
            <UserCircle2 className="h-5 w-5" />
          </button>
          <div className="absolute left-0 bottom-full mb-1.5 w-36
            opacity-0 invisible translate-y-1
            group-hover:opacity-100 group-hover:visible group-hover:translate-y-0
            transition-all duration-150 z-50">
            <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 shadow-lg overflow-hidden py-1">
              <button
                onClick={async () => {
                  try { await api.logout() } catch { /* ignore */ }
                  auth.clearToken()
                  navigate("/login")
                }}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-slate-600 dark:text-slate-300
                  hover:bg-red-50 dark:hover:bg-red-950 hover:text-red-600 dark:hover:text-red-400 transition-colors"
              >
                <LogOut className="h-3.5 w-3.5" />
                退出登录
              </button>
            </div>
          </div>
        </div>
      </div>
    </aside>
  )
}
