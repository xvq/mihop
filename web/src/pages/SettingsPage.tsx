import { useState, useEffect } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { api, type AppSettings } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { useToast } from "@/hooks/use-toast"
import { RefreshCw, Loader2 } from "lucide-react"

export function SettingsPage() {
  const qc = useQueryClient()
  const { toast } = useToast()
  const [form, setForm] = useState<AppSettings>({
    mihomo_path: "mihomo",
    mihomo_api_url: "http://127.0.0.1:9090",
    mihomo_secret: "",
  })

  const { data, isLoading } = useQuery<AppSettings>({
    queryKey: ["settings"],
    queryFn: api.getSettings,
  })

  useEffect(() => { if (data) setForm(data) }, [data])

  const saveMut = useMutation({
    mutationFn: api.updateSettings,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings"] })
      toast({ title: "设置已保存" })
    },
    onError: (e: Error) => toast({ title: "保存失败", description: e.message, variant: "destructive" }),
  })

  const reloadMut = useMutation({
    mutationFn: api.reloadConfig,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["proxies"] })
      qc.invalidateQueries({ queryKey: ["listeners"] })
      toast({ title: "配置已从文件重新加载" })
    },
    onError: (e: Error) => toast({ title: "重载失败", description: e.message, variant: "destructive" }),
  })

  function set<K extends keyof AppSettings>(k: K, v: AppSettings[K]) {
    setForm(prev => ({ ...prev, [k]: v }))
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24 text-slate-400 gap-2">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span className="text-sm">加载中...</span>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 py-5">
        <h1 className="text-lg font-semibold text-slate-800 dark:text-slate-100">设置</h1>
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">mihomo 运行配置与数据管理</p>
      </div>
      <div className="h-px bg-slate-200 dark:bg-slate-800 mx-6" />

      <div className="px-6 py-5 max-w-2xl space-y-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">mihomo 运行配置</CardTitle>
            <CardDescription className="text-xs">mihomo 可执行文件路径及 API 连接信息</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <Field label="mihomo 可执行文件路径">
              <Input value={form.mihomo_path} onChange={e => set("mihomo_path", e.target.value)}
                placeholder="mihomo 或 /usr/local/bin/mihomo" />
              <p className="text-xs text-muted-foreground">命令名（已在 PATH 中）或完整路径</p>
            </Field>
            <Field label="API 地址">
              <Input value={form.mihomo_api_url} onChange={e => set("mihomo_api_url", e.target.value)}
                placeholder="http://127.0.0.1:9090" />
              <p className="text-xs text-muted-foreground">对应 mihomo 配置中的 external-controller</p>
            </Field>
            <Field label="API Secret（可选）">
              <Input type="password" value={form.mihomo_secret} onChange={e => set("mihomo_secret", e.target.value)} />
            </Field>
            <Button onClick={() => saveMut.mutate(form)} disabled={saveMut.isPending} className="w-fit">
              {saveMut.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              保存设置
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">配置文件</CardTitle>
            <CardDescription className="text-xs">
              代理和监听数据直接存储在 mihomo-config.yaml 中，支持手动编辑后热重载
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              手动编辑 <code className="bg-muted px-1 py-0.5 rounded text-xs">mihomo-config.yaml</code> 后，
              点击下方按钮将变更加载到 UI 中并热重载。
            </p>
            <Button variant="outline" onClick={() => reloadMut.mutate()} disabled={reloadMut.isPending} className="w-fit">
              {reloadMut.isPending
                ? <Loader2 className="h-4 w-4 animate-spin mr-2" />
                : <RefreshCw className="h-4 w-4 mr-2" />}
              从配置文件重新加载
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label className="text-sm text-muted-foreground">{label}</Label>
      {children}
    </div>
  )
}
