import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog"
import { Plus, X } from "lucide-react"
import type { Proxy } from "@/lib/api"

interface KVPair { key: string; value: string }

interface FormState {
  name: string
  type: string
  server: string
  port: number
  extras: KVPair[]
}

function defaultExtras(type: string): KVPair[] {
  if (type === "http" || type === "socks5") {
    return [{ key: "username", value: "" }, { key: "password", value: "" }]
  }
  return []
}

function proxyToForm(p: Proxy): FormState {
  return {
    name: p.name,
    type: p.type,
    server: p.server,
    port: p.port,
    extras: Object.entries(p.extra ?? {}).map(([key, value]) => ({ key, value })),
  }
}

function formToProxy(f: FormState): Proxy {
  const extra: Record<string, string> = {}
  for (const { key, value } of f.extras) {
    if (key.trim()) extra[key.trim()] = value
  }
  return {
    name: f.name,
    type: f.type,
    server: f.server,
    port: f.port,
    extra: Object.keys(extra).length > 0 ? extra : undefined,
  }
}

const EMPTY_FORM: FormState = {
  name: "", type: "socks5", server: "", port: 1080,
  extras: defaultExtras("socks5"),
}

interface Props {
  open: boolean
  initial?: Proxy
  onSave: (p: Proxy, oldName: string) => void
  onClose: () => void
}

export function ProxyForm({ open, initial, onSave, onClose }: Props) {
  const [form, setForm] = useState<FormState>(initial ? proxyToForm(initial) : EMPTY_FORM)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const isEdit = !!initial

  function setField<K extends keyof FormState>(k: K, v: FormState[K]) {
    setForm(prev => ({ ...prev, [k]: v }))
    setErrors(prev => { const n = { ...prev }; delete n[k as string]; return n })
  }

  function handleTypeChange(type: string) {
    setForm(prev => ({ ...prev, type, extras: defaultExtras(type) }))
    setErrors(prev => { const n = { ...prev }; delete n.type; return n })
  }

  function setExtra(idx: number, field: "key" | "value", val: string) {
    setForm(prev => {
      const extras = prev.extras.map((kv, i) => i === idx ? { ...kv, [field]: val } : kv)
      return { ...prev, extras }
    })
  }

  function addExtra() {
    setForm(prev => ({ ...prev, extras: [...prev.extras, { key: "", value: "" }] }))
  }

  function removeExtra(idx: number) {
    setForm(prev => ({ ...prev, extras: prev.extras.filter((_, i) => i !== idx) }))
  }

  function validate(): boolean {
    const errs: Record<string, string> = {}
    if (!form.name.trim()) errs.name = "请填写名称"
    if (!form.server.trim()) errs.server = "请填写服务器地址"
    if (form.port < 1 || form.port > 65535) errs.port = "端口范围 1-65535"
    setErrors(errs)
    return Object.keys(errs).length === 0
  }

  function handleSave() {
    if (!validate()) return
    onSave(formToProxy(form), initial?.name ?? "")
  }

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? "编辑上游代理" : "添加上游代理"}</DialogTitle>
          {isEdit && (
            <DialogDescription>
              修改名称会自动更新所有引用此代理的本地监听
            </DialogDescription>
          )}
        </DialogHeader>

        <div className="grid grid-cols-[2fr_3fr] gap-6 py-2">
          {/* 左列：固定字段 */}
          <div className="flex flex-col gap-4">
            <Field label="名称（唯一标识）" error={errors.name}>
              <Input
                value={form.name}
                onChange={e => setField("name", e.target.value)}
                placeholder="如：Proxy-01"
                maxLength={15}
              />
            </Field>

            <Field label="协议">
              <Select value={form.type} onValueChange={handleTypeChange}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="http">HTTP</SelectItem>
                  <SelectItem value="socks5">SOCKS5</SelectItem>
                  <SelectItem value="ss">Shadowsocks</SelectItem>
                  <SelectItem value="ssr">ShadowsocksR</SelectItem>
                  <SelectItem value="snell">Snell</SelectItem>
                  <SelectItem value="vmess">VMess</SelectItem>
                  <SelectItem value="vless">VLESS</SelectItem>
                  <SelectItem value="trojan">Trojan</SelectItem>
                  <SelectItem value="anytls">AnyTLS</SelectItem>
                  <SelectItem value="mieru">Mieru</SelectItem>
                  <SelectItem value="sudoku">Sudoku</SelectItem>
                  <SelectItem value="hysteria">Hysteria</SelectItem>
                  <SelectItem value="hysteria2">Hysteria2</SelectItem>
                  <SelectItem value="tuic">TUIC</SelectItem>
                  <SelectItem value="wireguard">WireGuard</SelectItem>
                  <SelectItem value="ssh">SSH</SelectItem>
                  <SelectItem value="masque">MASQUE</SelectItem>
                  <SelectItem value="trusttunnel">TrustTunnel</SelectItem>
                </SelectContent>
              </Select>
            </Field>

            <Field label="服务器" error={errors.server}>
              <Input
                value={form.server}
                onChange={e => setField("server", e.target.value)}
                placeholder="1.2.3.4 或 example.com"
              />
            </Field>

            <Field label="端口" error={errors.port}>
              <Input
                type="number" min={1} max={65535}
                value={form.port}
                onChange={e => setField("port", +e.target.value)}
              />
            </Field>
          </div>

          {/* 右列：动态 KV */}
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <Label className="text-sm text-muted-foreground">扩展参数</Label>
              <Button type="button" variant="ghost" size="sm"
                className="h-6 text-xs px-2 gap-1 text-muted-foreground hover:text-foreground"
                onClick={addExtra}>
                <Plus className="h-3 w-3" />添加
              </Button>
            </div>

            {form.extras.length === 0 && (
              <p className="text-xs text-muted-foreground italic py-2">
                暂无参数，点击「添加」新增键值对
              </p>
            )}

            <div className="flex flex-col gap-2 overflow-y-auto max-h-[272px] p-1 -m-1">
              {form.extras.map((kv, idx) => (
                <div key={idx} className="flex items-center gap-1.5">
                  <Input
                    className="h-8 text-xs font-mono flex-1"
                    placeholder="key"
                    value={kv.key}
                    onChange={e => setExtra(idx, "key", e.target.value)}
                  />
                  <Input
                    className="h-8 text-xs font-mono flex-1"
                    placeholder="value"
                    value={kv.value}
                    onChange={e => setExtra(idx, "value", e.target.value)}
                  />
                  <button
                    type="button"
                    onClick={() => removeExtra(idx)}
                    className="h-8 w-8 flex items-center justify-center rounded-md
                      text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors shrink-0">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
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
    <div className="grid gap-1.5">
      <Label className="text-sm text-muted-foreground">{label}</Label>
      {children}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
