import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, SelectSeparator } from "@/components/ui/select"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Plus, X } from "lucide-react"
import type { Listener, Proxy, SubRule, UserEntry } from "@/lib/api"

interface Props {
  open: boolean
  initial?: Listener
  proxies: Proxy[]
  subRules: SubRule[]
  onSave: (l: Listener, oldPort: number) => void
  onClose: () => void
}

type Mode = "proxy" | "rule"

function detectMode(initial?: Listener): Mode {
  if (initial?.rule_id) return "rule"
  return "proxy"
}

export function ListenerForm({ open, initial, proxies, subRules, onSave, onClose }: Props) {
  const [mode, setMode] = useState<Mode>(detectMode(initial))
  const [form, setForm] = useState<Listener>(
    initial ?? {
      name: "",
      local_port: 10800,
      type: "mixed",
      listen: "",
      proxy_id: proxies[0]?.name ?? "DIRECT",
      rule_id: "",
      enabled: true,
      users: [],
    }
  )
  const [errors, setErrors] = useState<Partial<Record<keyof Listener | "mode", string>>>({})

  function set<K extends keyof Listener>(k: K, v: Listener[K]) {
    setForm(prev => ({ ...prev, [k]: v }))
    setErrors(prev => ({ ...prev, [k]: undefined, mode: undefined }))
  }

  function switchMode(m: Mode) {
    setMode(m)
    setErrors({})
    if (m === "proxy") {
      setForm(prev => ({ ...prev, rule_id: "", proxy_id: prev.proxy_id || proxies[0]?.name || "DIRECT" }))
    } else {
      setForm(prev => ({ ...prev, proxy_id: "", rule_id: prev.rule_id || subRules[0]?.name || "" }))
    }
  }

  // ── 用户列表操作 ──────────────────────────────────────────────────────────
  const users: UserEntry[] = form.users ?? []

  function addUser() {
    set("users", [...users, { username: "", password: "" }])
  }

  function updateUser(i: number, field: keyof UserEntry, val: string) {
    const next = users.map((u, idx) => idx === i ? { ...u, [field]: val } : u)
    set("users", next)
  }

  function removeUser(i: number) {
    set("users", users.filter((_, idx) => idx !== i))
  }

  // ── 校验 ──────────────────────────────────────────────────────────────────
  function validate(): boolean {
    const errs: typeof errors = {}
    if (form.local_port < 1 || form.local_port > 65535) errs.local_port = "端口范围 1-65535"
    if (mode === "proxy" && !form.proxy_id) errs.proxy_id = "请选择上游代理"
    if (mode === "rule" && !form.rule_id) errs.mode = "请选择规则集"
    setErrors(errs)
    return Object.keys(errs).length === 0
  }

  function handleSave() {
    if (!validate()) return
    // 过滤掉 username 为空的行，空列表则不传 users 字段
    const validUsers = (form.users ?? []).filter(u => u.username.trim() !== "")
    const saved: Listener = {
      ...form,
      proxy_id: mode === "proxy" ? form.proxy_id : "",
      rule_id:  mode === "rule"  ? form.rule_id  : "",
      users: validUsers.length > 0 ? validUsers : undefined,
    }
    onSave(saved, initial?.local_port ?? form.local_port)
  }

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{initial ? "编辑本地监听" : "添加本地监听"}</DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-x-6 gap-y-4 py-2">
          {/* ── 左列 ── */}
          <div className="flex flex-col gap-4 min-w-0">
            <Field label="名称（可选）">
              <Input
                value={form.name ?? ""}
                onChange={e => set("name", e.target.value)}
                placeholder={`留空则自动生成 mihop-${form.local_port}`}
                maxLength={15}
              />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="本地端口" error={errors.local_port}>
                <Input type="number" min={1} max={65535} value={form.local_port}
                  onChange={e => set("local_port", +e.target.value)} />
              </Field>
              <Field label="协议类型">
                <Select value={form.type || "mixed"} onValueChange={v => set("type", v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="mixed">Mixed</SelectItem>
                    <SelectItem value="http">HTTP</SelectItem>
                    <SelectItem value="socks">SOCKS</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </div>

            <Field label="监听地址">
              <Input
                value={form.listen ?? ""}
                onChange={e => set("listen", e.target.value)}
                placeholder="0.0.0.0"
                className="text-sm"
              />
            </Field>

            <Field label="流量模式">
              <div className="flex rounded-lg border border-slate-200 dark:border-slate-700 p-0.5 bg-slate-50 dark:bg-slate-900">
                <button
                  type="button"
                  onClick={() => switchMode("proxy")}
                  className={`flex-1 py-1.5 text-sm font-medium rounded-md transition-all
                    ${mode === "proxy"
                      ? "bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 shadow-sm"
                      : "text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300"}`}
                >
                  上游代理
                </button>
                <button
                  type="button"
                  onClick={() => switchMode("rule")}
                  className={`flex-1 py-1.5 text-sm font-medium rounded-md transition-all
                    ${mode === "rule"
                      ? "bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 shadow-sm"
                      : "text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300"}`}
                >
                  规则集
                </button>
              </div>
            </Field>

            {mode === "proxy" && (
              <Field label="上游代理" error={errors.proxy_id}>
                <Select value={form.proxy_id} onValueChange={v => set("proxy_id", v)}>
                  <SelectTrigger className="min-w-0"><SelectValue placeholder="选择代理服务器" /></SelectTrigger>
                  <SelectContent position="popper" className="w-[--radix-select-trigger-width]">
                    <SelectItem value="DIRECT">
                      <span className="flex items-center gap-2 min-w-0">
                        <span className="font-medium">DIRECT</span>
                        <span className="text-xs text-muted-foreground">内置直连</span>
                      </span>
                    </SelectItem>
                    {proxies.length > 0 && <SelectSeparator />}
                    {proxies.map(p => (
                      <SelectItem key={p.name} value={p.name}>
                        <span className="flex items-center gap-2 min-w-0">
                          <span className="font-medium truncate">{p.name}</span>
                          <span className="text-xs text-muted-foreground shrink-0">
                            {p.type.toUpperCase()}
                          </span>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )}

            {mode === "rule" && (
              <Field label="规则集" error={errors.mode}>
                {subRules.length === 0 ? (
                  <p className="text-xs text-amber-600 dark:text-amber-400 py-2">
                    暂无规则集，请先在「规则集」页面创建
                  </p>
                ) : (
                  <Select value={form.rule_id} onValueChange={v => set("rule_id", v)}>
                    <SelectTrigger className="min-w-0"><SelectValue placeholder="选择规则集" /></SelectTrigger>
                    <SelectContent position="popper" className="w-[--radix-select-trigger-width]">
                      {subRules.map(r => (
                        <SelectItem key={r.name} value={r.name}>
                          <span className="flex items-center gap-2 min-w-0">
                            <span className="font-medium truncate">{r.name}</span>
                            <span className="text-xs text-muted-foreground shrink-0">
                              {r.entries.length} 条规则
                            </span>
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </Field>
            )}
          </div>

          {/* ── 分隔线 ── */}
          <div className="col-span-2 -mx-6 h-px bg-slate-100 dark:bg-slate-800 hidden" />

          {/* ── 右列：认证用户 ── */}
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <Label className="text-sm text-muted-foreground">认证用户</Label>
              <Button type="button" variant="ghost" size="sm"
                className="h-6 text-xs px-2 gap-1 text-muted-foreground hover:text-foreground"
                onClick={addUser}>
                <Plus className="h-3 w-3" />添加
              </Button>
            </div>

            {users.length === 0 ? (
              <div className="flex-1 flex items-center justify-center rounded-lg border border-dashed
                border-slate-200 dark:border-slate-700 py-8">
                <p className="text-xs text-slate-400 dark:text-slate-500">无认证，所有客户端均可连接</p>
              </div>
            ) : (
              <div className="flex flex-col gap-2 overflow-y-auto max-h-[352px] p-1 -m-1">
                {users.map((u, i) => (
                  <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-2 items-center">
                    <Input
                      value={u.username}
                      onChange={e => updateUser(i, "username", e.target.value)}
                      placeholder="用户名"
                      className="h-8 text-xs"
                    />
                    <Input
                      value={u.password}
                      onChange={e => updateUser(i, "password", e.target.value)}
                      placeholder="密码"
                      className="h-8 text-xs"
                      type="password"
                    />
                    <button
                      onClick={() => removeUser(i)}
                      className="h-7 w-7 flex items-center justify-center rounded-lg
                        text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950 transition-colors"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
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

function Field({ label, children, error }: { label: string; children: React.ReactNode; error?: string }) {
  return (
    <div className="grid gap-1.5 min-w-0">
      <Label className="text-sm text-muted-foreground">{label}</Label>
      {children}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
