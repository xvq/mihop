import { useState, useEffect } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { api, type DNSConfig } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Save, Loader2, Plus, X, AlertTriangle, RefreshCw } from "lucide-react"
import { useToast } from "@/hooks/use-toast"

type KVPair = { key: string; value: string }

interface DnsForm {
  enable: boolean
  default_nameserver: string[]
  nameserver: string[]
  enhanced_mode: string
  fake_ip_range: string
  fake_ip_filter: string[]
  nameserver_policy: KVPair[]
  hosts: KVPair[]
}

const EMPTY: DnsForm = {
  enable: false,
  default_nameserver: ["223.5.5.5", "119.29.29.29"],
  nameserver: [
    "https://doh.pub/dns-query",
    "https://dns.alidns.com/dns-query",
    "tls://dot.pub:853",
    "tls://dns.alidns.com:853",
  ],
  enhanced_mode: "redir-host",
  fake_ip_range: "198.18.0.1/16",
  fake_ip_filter: [],
  nameserver_policy: [],
  hosts: [],
}

function toForm(d: DNSConfig): DnsForm {
  return {
    ...d,
    nameserver_policy: Object.entries(d.nameserver_policy ?? {}).map(([key, value]) => ({ key, value })),
    hosts: Object.entries(d.hosts ?? {}).map(([key, value]) => ({ key, value })),
  }
}

function fromForm(f: DnsForm): DNSConfig {
  return {
    ...f,
    nameserver_policy: Object.fromEntries(
      f.nameserver_policy.filter(p => p.key.trim()).map(p => [p.key.trim(), p.value])
    ),
    hosts: Object.fromEntries(
      f.hosts.filter(p => p.key.trim()).map(p => [p.key.trim(), p.value])
    ),
  }
}

function TagList({ items, onChange, placeholder }: {
  items: string[]
  onChange: (items: string[]) => void
  placeholder?: string
}) {
  const [input, setInput] = useState("")

  function add() {
    const v = input.trim()
    if (v) { onChange([...items, v]); setInput("") }
  }

  return (
    <div className="space-y-2">
      {items.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {items.map((item, i) => (
            <span key={i}
              className="inline-flex items-center gap-1 pl-2.5 pr-1.5 py-1 rounded-full
                bg-slate-100 dark:bg-slate-800 text-xs font-mono
                text-slate-700 dark:text-slate-300">
              {item}
              <button
                onClick={() => onChange(items.filter((_, idx) => idx !== i))}
                className="text-slate-400 hover:text-red-500 transition-colors ml-0.5">
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <Input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); add() } }}
          placeholder={placeholder}
          className="h-8 text-sm font-mono"
        />
        <Button variant="outline" size="sm" onClick={add} className="h-8 w-8 p-0 shrink-0">
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  )
}

function KVEditor({ pairs, onChange, keyPlaceholder, valuePlaceholder }: {
  pairs: KVPair[]
  onChange: (pairs: KVPair[]) => void
  keyPlaceholder?: string
  valuePlaceholder?: string
}) {
  function update(i: number, field: keyof KVPair, v: string) {
    onChange(pairs.map((p, idx) => idx === i ? { ...p, [field]: v } : p))
  }
  function remove(i: number) {
    onChange(pairs.filter((_, idx) => idx !== i))
  }
  function add() {
    onChange([...pairs, { key: "", value: "" }])
  }

  return (
    <div className="space-y-1.5">
      {pairs.map((p, i) => (
        <div key={i} className="flex gap-2">
          <Input value={p.key} onChange={e => update(i, "key", e.target.value)}
            placeholder={keyPlaceholder} className="h-8 text-xs font-mono flex-1" />
          <Input value={p.value} onChange={e => update(i, "value", e.target.value)}
            placeholder={valuePlaceholder} className="h-8 text-xs font-mono flex-1" />
          <button onClick={() => remove(i)}
            className="h-8 w-8 shrink-0 flex items-center justify-center rounded-lg
              text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950 transition-colors">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <button onClick={add}
        className="flex items-center gap-1.5 text-xs text-indigo-600 dark:text-indigo-400
          hover:text-indigo-700 dark:hover:text-indigo-300 transition-colors py-1">
        <Plus className="h-3.5 w-3.5" />添加一行
      </button>
    </div>
  )
}

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm">
      <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800">
        <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{title}</p>
        {description && <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{description}</p>}
      </div>
      <div className="px-5 py-4 space-y-5">{children}</div>
    </div>
  )
}

function Field({ label, description, children }: { label: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div>
        <Label className="text-sm text-slate-700 dark:text-slate-300">{label}</Label>
        {description && <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{description}</p>}
      </div>
      {children}
    </div>
  )
}

export function DnsPage() {
  const { toast } = useToast()
  const qc = useQueryClient()
  const [form, setForm] = useState<DnsForm>(EMPTY)

  const { data, isLoading, isError, refetch } = useQuery<DNSConfig>({
    queryKey: ["dns"],
    queryFn: api.getDNS,
  })

  useEffect(() => { if (data) setForm(toForm(data)) }, [data])

  const saveMut = useMutation({
    mutationFn: (f: DnsForm) => api.setDNS(fromForm(f)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["dns"] })
      toast({ title: "DNS 设置已保存" })
    },
    onError: (e: Error) => toast({ title: "保存失败", description: e.message, variant: "destructive" }),
  })

  function set<K extends keyof DnsForm>(k: K, v: DnsForm[K]) {
    setForm(prev => ({ ...prev, [k]: v }))
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full text-slate-400 gap-2">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span className="text-sm">加载中...</span>
      </div>
    )
  }

  if (isError) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4">
        <div className="h-12 w-12 rounded-xl bg-red-50 dark:bg-red-950 flex items-center justify-center">
          <AlertTriangle className="h-6 w-6 text-red-400" />
        </div>
        <p className="text-sm text-slate-500 dark:text-slate-400">加载失败</p>
        <Button variant="outline" size="sm" onClick={() => refetch()} className="text-xs gap-1.5">
          <RefreshCw className="h-3.5 w-3.5" />重试
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-6 py-5">
        <div>
          <h1 className="text-lg font-semibold text-slate-800 dark:text-slate-100">DNS 设置</h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">配置 mihomo 的 DNS 解析行为</p>
        </div>
        <Button onClick={() => saveMut.mutate(form)} disabled={saveMut.isPending}
          className="bg-indigo-600 hover:bg-indigo-700 text-white h-10 text-sm px-4">
          {saveMut.isPending
            ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
            : <Save className="h-4 w-4 mr-1.5" />}
          保存
        </Button>
      </div>
      <div className="h-px bg-slate-200 dark:bg-slate-800 mx-6" />

      <div className="flex-1 overflow-auto p-6">
        <div className="max-w-3xl space-y-5">
          <Section title="基本配置">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-slate-700 dark:text-slate-300 font-medium">启用 DNS</p>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">由 mihomo 接管系统 DNS 解析</p>
              </div>
              <button
                onClick={() => set("enable", !form.enable)}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors
                  ${form.enable ? "bg-indigo-600" : "bg-slate-200 dark:bg-slate-700"}`}>
                <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform
                  ${form.enable ? "translate-x-6" : "translate-x-1"}`} />
              </button>
            </div>

            <div className="h-px bg-slate-100 dark:bg-slate-800" />

            <Field label="默认 DNS 服务器" description="用于解析 DNS 服务器域名本身，填纯 IP 服务器">
              <TagList items={form.default_nameserver} onChange={v => set("default_nameserver", v)} placeholder="如：223.5.5.5" />
            </Field>

            <Field label="DNS 服务器" description="正常域名解析使用的 DNS，支持 UDP / DoH / DoT 格式">
              <TagList items={form.nameserver} onChange={v => set("nameserver", v)} placeholder="如：https://doh.pub/dns-query" />
            </Field>
          </Section>

          <Section title="高级配置">
            <div className="grid grid-cols-2 gap-5">
              <Field label="增强模式（enhanced-mode）">
                <Select value={form.enhanced_mode || "redir-host"} onValueChange={v => set("enhanced_mode", v)}>
                  <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="redir-host">Redir Host</SelectItem>
                    <SelectItem value="fake-ip">Fake IP</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Fake IP 段">
                <Input value={form.fake_ip_range} onChange={e => set("fake_ip_range", e.target.value)}
                  placeholder="198.18.0.1/16" className="h-9 text-sm font-mono" />
              </Field>
            </div>

            <Field label="Fake IP 过滤" description="匹配这些域名时不使用 Fake IP，返回真实解析结果">
              <TagList items={form.fake_ip_filter} onChange={v => set("fake_ip_filter", v)} placeholder="如：*.lan 或 +.stun.*.*" />
            </Field>

            <div className="h-px bg-slate-100 dark:bg-slate-800" />

            <Field label="DNS 分流策略（nameserver-policy）"
              description="指定域名使用特定 DNS 服务器，键为域名规则，值为 DNS 地址">
              <KVEditor pairs={form.nameserver_policy} onChange={v => set("nameserver_policy", v)}
                keyPlaceholder="+.[google.com]" valuePlaceholder="https://dns.cloudflare.com/dns-query" />
            </Field>

            <div className="h-px bg-slate-100 dark:bg-slate-800" />

            <Field label="Hosts" description="静态域名映射，值为 IP 或域名，多个 IP 用逗号分隔">
              <KVEditor pairs={form.hosts} onChange={v => set("hosts", v)}
                keyPlaceholder="example.com" valuePlaceholder="1.1.1.1 或 1.1.1.1, 2.2.2.2" />
            </Field>
          </Section>
        </div>
      </div>
    </div>
  )
}
