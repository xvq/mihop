import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { api, auth } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Loader2 } from "lucide-react"

export function LoginPage() {
  const navigate = useNavigate()
  const [password, setPassword] = useState("")
  const [error, setError]       = useState("")
  const [loading, setLoading]   = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!password) return
    setLoading(true)
    setError("")
    try {
      const { token } = await api.login(password)
      auth.setToken(token)
      navigate("/", { replace: true })
    } catch {
      setError("密码错误，请重试")
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        {/* Logo 区域 */}
        <div className="flex flex-col items-center mb-8">
          <div className="h-20 w-20 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 flex items-center justify-center mb-4 shadow-lg shadow-slate-200 dark:shadow-slate-950">
            <img src="/logo.png" alt="Mihop" className="h-14 w-14 object-contain" />
          </div>
          <h1 className="text-2xl font-bold text-slate-800 dark:text-slate-100 tracking-tight">Mihop</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">代理管理面板</p>
        </div>

        {/* 登录卡片 */}
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm p-6">
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="grid gap-1.5">
              <Label className="text-sm text-muted-foreground">用户名</Label>
              <Input value="admin" disabled className="bg-slate-50 dark:bg-slate-800 text-slate-400 cursor-not-allowed" />
            </div>

            <div className="grid gap-1.5">
              <Label className="text-sm text-muted-foreground">访问密码</Label>
              <Input
                type="password"
                value={password}
                onChange={e => { setPassword(e.target.value); setError("") }}
                placeholder="输入访问密码"
                autoFocus
              />
              {error && (
                <p className="text-xs text-destructive">{error}</p>
              )}
            </div>

            <Button type="submit" disabled={loading || !password} className="mt-1">
              {loading
                ? <><Loader2 className="h-4 w-4 animate-spin" />登录中...</>
                : "登录"}
            </Button>
          </form>
        </div>

      </div>
    </div>
  )
}
