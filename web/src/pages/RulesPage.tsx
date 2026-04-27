import { useState } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { api, type SubRule, type RuleEntry, type Proxy } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { Plus, Pencil, Trash2, Loader2, Waypoints, AlertTriangle, RefreshCw, X } from "lucide-react"
import { useToast } from "@/hooks/use-toast"

// ─── 规则类型配置 ─────────────────────────────────────────────────────────────

const RULE_TYPE_GROUPS = [
  { label: "域名", types: ["DOMAIN", "DOMAIN-SUFFIX", "DOMAIN-KEYWORD", "DOMAIN-WILDCARD", "DOMAIN-REGEX", "GEOSITE"] },
  { label: "IP", types: ["IP-CIDR", "IP-CIDR6", "IP-SUFFIX", "IP-ASN", "GEOIP"] },
  { label: "来源 IP", types: ["SRC-IP-CIDR", "SRC-IP-SUFFIX", "SRC-IP-ASN", "SRC-GEOIP"] },
  { label: "端口", types: ["DST-PORT", "SRC-PORT", "IN-PORT"] },
  { label: "入站", types: ["IN-TYPE", "IN-NAME"] },
  { label: "网络", types: ["NETWORK"] },
  { label: "兜底", types: ["MATCH"] },
]

const NO_VALUE_TYPES = new Set(["MATCH"])
const NO_RESOLVE_TYPES = new Set([
  "IP-CIDR", "IP-CIDR6", "IP-SUFFIX", "IP-ASN", "GEOIP",
  "SRC-IP-CIDR", "SRC-IP-SUFFIX", "SRC-IP-ASN", "SRC-GEOIP",
])
const SELECT_VALUE_OPTIONS: Record<string, string[]> = {
  NETWORK: ["tcp", "udp"],
  "IN-TYPE": ["http", "socks", "socks5", "mixed"],
}

const EMPTY_ENTRY: RuleEntry = { type: "DOMAIN", value: "", target: "DIRECT", no_resolve: false }

// ─── 文本 ↔ 结构化 互转 ───────────────────────────────────────────────────────

function entriesToText(entries: RuleEntry[]): string {
  return entries.map(e => {
    const parts = e.value ? [e.type, e.value, e.target] : [e.type, e.target]
    if (e.no_resolve) parts.push("no-resolve")
    return parts.join(",")
  }).join("\n")
}

function textToEntries(text: string): RuleEntry[] {
  return text.split("\n")
    .map(l => l.trim())
    .filter(l => l && !l.startsWith("#"))
    .flatMap(l => {
      const parts = l.split(",").map(p => p.trim())
      const noResolve = parts[parts.length - 1] === "no-resolve"
      if (noResolve) parts.pop()
      if (parts.length === 2) return [{ type: parts[0], value: "", target: parts[1], no_resolve: noResolve }]
      if (parts.length >= 3) return [{ type: parts[0], value: parts[1], target: parts[2], no_resolve: noResolve }]
      return []
    })
}

// ─── 单条规则行 ───────────────────────────────────────────────────────────────

function RuleRow({ entry, proxies, onChange, onDelete }: {
  entry: RuleEntry
  proxies: Proxy[]
  onChange: (e: RuleEntry) => void
  onDelete: () => void
}) {
  const noValue = NO_VALUE_TYPES.has(entry.type)
  const hasNoResolve = NO_RESOLVE_TYPES.has(entry.type)
  const selectOpts = SELECT_VALUE_OPTIONS[entry.type]

  return (
    <div className="flex gap-2 items-center">
      {/* 类型 */}
      <div className="w-44 shrink-0">
        <Select value={entry.type} onValueChange={v => onChange({ ...entry, type: v, value: "" })}>
          <SelectTrigger className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-h-72">
            {RULE_TYPE_GROUPS.map(g => (
              <SelectGroup key={g.label}>
                <SelectLabel className="text-[10px] text-slate-400 py-1">{g.label}</SelectLabel>
                {g.types.map(t => (
                  <SelectItem key={t} value={t} className="text-xs">{t}</SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* 值 */}
      <div className="flex-1 min-w-0">
        {!noValue && (
          selectOpts ? (
            <Select value={entry.value || selectOpts[0]} onValueChange={v => onChange({ ...entry, value: v })}>
              <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {selectOpts.map(o => <SelectItem key={o} value={o} className="text-xs">{o}</SelectItem>)}
              </SelectContent>
            </Select>
          ) : (
            <Input
              value={entry.value}
              onChange={e => onChange({ ...entry, value: e.target.value })}
              placeholder="值"
              className="h-8 text-xs font-mono"
            />
          )
        )}
      </div>

      {/* 目标 */}
      <div className="w-36 shrink-0">
        <Select value={entry.target} onValueChange={v => onChange({ ...entry, target: v })}>
          <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="DIRECT" className="text-xs">DIRECT</SelectItem>
            <SelectItem value="REJECT" className="text-xs">REJECT</SelectItem>
            {proxies.length > 0 && (
              <SelectGroup>
                <SelectLabel className="text-[10px] text-slate-400 py-1">上游代理</SelectLabel>
                {proxies.map(p => (
                  <SelectItem key={p.name} value={p.name} className="text-xs">{p.name}</SelectItem>
                ))}
              </SelectGroup>
            )}
          </SelectContent>
        </Select>
      </div>

      {/* no-resolve */}
      <div className="w-8 shrink-0 flex items-center justify-center">
        {hasNoResolve && (
          <input
            type="checkbox"
            checked={entry.no_resolve}
            onChange={e => onChange({ ...entry, no_resolve: e.target.checked })}
            title="no-resolve"
            className="h-3.5 w-3.5 rounded accent-indigo-600 cursor-pointer"
          />
        )}
      </div>

      {/* 删除 */}
      <button
        onClick={onDelete}
        className="h-8 w-8 shrink-0 flex items-center justify-center rounded-lg
          text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950 transition-colors">
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

// ─── 规则集编辑对话框 ─────────────────────────────────────────────────────────

function SubRuleDialog({ open, initial, proxies, onSave, onClose }: {
  open: boolean
  initial?: SubRule
  proxies: Proxy[]
  onSave: (r: SubRule, oldName: string) => void
  onClose: () => void
}) {
  const [name, setName] = useState(initial?.name ?? "")
  const [entries, setEntries] = useState<RuleEntry[]>(initial?.entries ?? [])
  const [viewMode, setViewMode] = useState<"structured" | "raw">("structured")
  const [rawText, setRawText] = useState(() => entriesToText(initial?.entries ?? []))

  function switchTo(mode: "structured" | "raw") {
    if (mode === "raw") {
      setRawText(entriesToText(entries))
    } else {
      setEntries(textToEntries(rawText))
    }
    setViewMode(mode)
  }

  function handleSave() {
    const finalEntries = viewMode === "raw" ? textToEntries(rawText) : entries
    onSave({ name, entries: finalEntries }, initial?.name ?? "")
  }

  function updateEntry(i: number, e: RuleEntry) {
    setEntries(prev => prev.map((x, idx) => idx === i ? e : x))
  }
  function removeEntry(i: number) {
    setEntries(prev => prev.filter((_, idx) => idx !== i))
  }
  function addEntry() {
    setEntries(prev => [...prev, { ...EMPTY_ENTRY }])
  }

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="sm:max-w-3xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{initial ? "编辑规则集" : "添加规则集"}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4 flex-1 min-h-0">
          {/* 名称 */}
          <div className="grid gap-1.5 px-0.5">
            <Label className="text-sm text-muted-foreground">规则集名称</Label>
            <Input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="如：Rule-01"
              maxLength={15}
            />
          </div>

          {/* 视图切换 */}
          <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg w-fit">
            {(["structured", "raw"] as const).map(m => (
              <button
                key={m}
                onClick={() => switchTo(m)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors
                  ${viewMode === m
                    ? "bg-white dark:bg-slate-700 text-slate-800 dark:text-slate-100 shadow-sm"
                    : "text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"}`}>
                {m === "structured" ? "结构化" : "文本"}
              </button>
            ))}
          </div>

          {/* 内容区 */}
          <div className="flex-1 overflow-auto min-h-0 px-0.5 -mx-0.5">
            {viewMode === "structured" ? (
              <div className="space-y-1.5">
                {/* 列头 */}
                {entries.length > 0 && (
                  <div className="flex gap-2 items-center px-0.5">
                    <div className="w-44 shrink-0 text-[10px] font-medium text-slate-400 uppercase">类型</div>
                    <div className="flex-1 text-[10px] font-medium text-slate-400 uppercase">值</div>
                    <div className="w-36 shrink-0 text-[10px] font-medium text-slate-400 uppercase">目标</div>
                    <div className="w-8 shrink-0 text-[10px] font-medium text-slate-400 uppercase text-center" title="no-resolve">NR</div>
                    <div className="w-8 shrink-0" />
                  </div>
                )}
                {entries.map((e, i) => (
                  <RuleRow
                    key={i}
                    entry={e}
                    proxies={proxies}
                    onChange={ne => updateEntry(i, ne)}
                    onDelete={() => removeEntry(i)}
                  />
                ))}
                <button
                  onClick={addEntry}
                  className="flex items-center gap-1.5 text-xs text-indigo-600 dark:text-indigo-400
                    hover:text-indigo-700 dark:hover:text-indigo-300 transition-colors py-1 mt-1">
                  <Plus className="h-3.5 w-3.5" />添加规则
                </button>
              </div>
            ) : (
              <div className="space-y-1.5">
                <p className="text-xs text-slate-400">每行一条规则，格式：<span className="font-mono">TYPE,VALUE,TARGET</span> 或 <span className="font-mono">MATCH,TARGET</span>，IP 类可追加 <span className="font-mono">,no-resolve</span></p>
                <textarea
                  value={rawText}
                  onChange={e => setRawText(e.target.value)}
                  rows={14}
                  placeholder={"DOMAIN-SUFFIX,cn,DIRECT\nIP-CIDR,192.168.0.0/16,DIRECT,no-resolve\nMATCH,Proxy-01"}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700
                    bg-white dark:bg-slate-900 text-xs font-mono leading-relaxed
                    px-3 py-2.5 resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500
                    text-slate-800 dark:text-slate-200 placeholder:text-slate-300 dark:placeholder:text-slate-600"
                />
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button onClick={handleSave} disabled={!name.trim()}>保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── 规则集卡片 ───────────────────────────────────────────────────────────────

function SubRuleCard({ rule, onEdit, onDelete }: {
  rule: SubRule
  onEdit: () => void
  onDelete: () => void
}) {
  return (
    <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm hover:shadow-md transition-all">
      <div className="flex items-center gap-3 px-4 py-4">
        <div className="h-9 w-9 rounded-lg bg-violet-50 dark:bg-violet-950 flex items-center justify-center shrink-0">
          <Waypoints className="h-4 w-4 text-violet-500 dark:text-violet-400" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-bold text-slate-800 dark:text-slate-100 text-lg leading-tight truncate">{rule.name}</p>
          <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5">{rule.entries.length} 条规则</p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={onEdit}
            className="h-8 w-8 flex items-center justify-center rounded-lg
              text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-600 dark:hover:text-slate-300 transition-colors">
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={onDelete}
            className="h-8 w-8 flex items-center justify-center rounded-lg
              text-slate-400 hover:bg-red-50 dark:hover:bg-red-950 hover:text-red-500 dark:hover:text-red-400 transition-colors">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── 主组件 ───────────────────────────────────────────────────────────────────

export function RulesPage() {
  const qc = useQueryClient()
  const { toast } = useToast()
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<SubRule | undefined>()
  const [pendingDelete, setPendingDelete] = useState<SubRule | null>(null)

  const { data: rules = [], isLoading, isError, refetch } = useQuery<SubRule[]>({
    queryKey: ["rules"],
    queryFn: api.listSubRules,
  })

  const { data: proxies = [] } = useQuery<Proxy[]>({
    queryKey: ["proxies"],
    queryFn: api.listProxies,
  })

  const createMut = useMutation({
    mutationFn: (r: SubRule) => api.createSubRule(r),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["rules"] }); setShowForm(false) },
    onError: (e: Error) => toast({ title: "添加失败", description: e.message, variant: "destructive" }),
  })

  const updateMut = useMutation({
    mutationFn: ({ oldName, r }: { oldName: string; r: SubRule }) => api.updateSubRule(oldName, r),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["rules"] }); setEditing(undefined) },
    onError: (e: Error) => toast({ title: "更新失败", description: e.message, variant: "destructive" }),
  })

  const deleteMut = useMutation({
    mutationFn: api.deleteSubRule,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["rules"] }); setPendingDelete(null) },
    onError: (e: Error) => { toast({ title: "删除失败", description: e.message, variant: "destructive" }); setPendingDelete(null) },
  })

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-5">
        <div>
          <h1 className="text-lg font-semibold text-slate-800 dark:text-slate-100">规则集</h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">管理 mihomo sub-rules，供本地监听引用</p>
        </div>
        <Button size="sm" onClick={() => setShowForm(true)}
          className="bg-indigo-600 hover:bg-indigo-700 text-white h-10 text-sm px-4">
          <Plus className="h-4 w-4 mr-1.5" />添加规则集
        </Button>
      </div>
      <div className="h-px bg-slate-200 dark:bg-slate-800 mx-6" />

      {/* Content */}
      <div className="flex-1 overflow-auto p-6">
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

        {!isLoading && !isError && rules.length === 0 && (
          <div className="flex flex-col items-center justify-center py-24">
            <div className="h-12 w-12 rounded-xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center mb-4">
              <Waypoints className="h-6 w-6 text-slate-400" />
            </div>
            <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">还没有规则集</p>
            <Button variant="outline" size="sm" onClick={() => setShowForm(true)} className="text-xs">
              <Plus className="h-3.5 w-3.5 mr-1.5" />添加第一个
            </Button>
          </div>
        )}

        <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(480px, 1fr))" }}>
          {rules.map(rule => (
            <SubRuleCard
              key={rule.name}
              rule={rule}
              onEdit={() => setEditing(rule)}
              onDelete={() => setPendingDelete(rule)}
            />
          ))}
        </div>
      </div>

      <SubRuleDialog
        open={showForm}
        proxies={proxies}
        onSave={(r) => createMut.mutate(r)}
        onClose={() => setShowForm(false)}
      />

      {editing && (
        <SubRuleDialog
          open
          initial={editing}
          proxies={proxies}
          onSave={(r, oldName) => updateMut.mutate({ oldName, r })}
          onClose={() => setEditing(undefined)}
        />
      )}

      <ConfirmDialog
        open={!!pendingDelete}
        title={`删除规则集「${pendingDelete?.name}」`}
        description="此操作不可撤销，引用此规则集的本地监听将失去关联。"
        onConfirm={() => pendingDelete && deleteMut.mutate(pendingDelete.name)}
        onClose={() => setPendingDelete(null)}
        loading={deleteMut.isPending}
      />
    </div>
  )
}
