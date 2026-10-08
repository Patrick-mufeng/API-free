/* 面板 API 封装 —— M1：服务监督（列表/启停）；统计与日志在 M2/M3 扩展 */

export type SvcStatus = 'stopped' | 'starting' | 'running'

export interface SvcSnapshot {
  id: string
  name: string
  port: number
  status: SvcStatus
  pid: number
  managed: boolean
  restarts: number
  lastError?: string
}

export async function fetchServices(): Promise<SvcSnapshot[]> {
  const r = await fetch('/api/services')
  if (!r.ok) throw new Error('HTTP ' + r.status)
  const j = await r.json()
  return j.services as SvcSnapshot[]
}

export async function ctlService(
  id: string,
  action: 'start' | 'stop' | 'restart',
): Promise<SvcSnapshot[]> {
  const r = await fetch(`/api/services/${id}/${action}`, { method: 'POST' })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status)
  return j.services as SvcSnapshot[]
}

/* ---------- M3：统计 ---------- */
export interface SvcDay {
  input: number
  output: number
  reqs: number
}
export interface StatsDay {
  date: string
  services: Record<string, SvcDay>
  total: SvcDay
}
export interface StatsData {
  days: StatsDay[]
  totals: Record<string, SvcDay>
  today: SvcDay
  cmdgoPending: boolean
  lastPull: string
  lastPullErr: string
}

export async function fetchStats(days = 30): Promise<StatsData> {
  const r = await fetch(`/api/stats?days=${days}`)
  if (!r.ok) throw new Error('HTTP ' + r.status)
  return (await r.json()) as StatsData
}

export async function refreshStats(): Promise<void> {
  const r = await fetch('/api/stats/refresh', { method: 'POST' })
  if (!r.ok) throw new Error('HTTP ' + r.status)
}

/* ---------- 跨服务运行时信息（冷却告警 + 服务卡片） ---------- */
export interface CoolStat {
  svc: string
  n: number
  unit: string // 账号 | 模型 | ''
  ok: boolean
  err?: string
}
export interface AlertItem {
  svc: string
  kind: 'cooling' | 'breaker'
  text: string
  until: string
}
export interface SvcTask {
  name: string
  done: number
  total: number
  note?: string
}
export interface SvcCard {
  svc: string
  ok: boolean
  err?: string
  accounts?: number
  healthy?: number
  cooling?: number
  cool_unit?: string
  credits?: { remaining: number; total: number }
  models?: number
  tasks?: SvcTask[]
  note?: string
}
export interface SvcInfo {
  at: string
  total: number
  cooling: CoolStat[]
  alerts: AlertItem[]
  services: SvcCard[]
}

export async function fetchSvcInfo(): Promise<SvcInfo> {
  const r = await fetch('/api/svcinfo')
  if (!r.ok) throw new Error('HTTP ' + r.status)
  return (await r.json()) as SvcInfo
}

/* ---------- 面板事件流 ---------- */
export interface PanelEvent {
  t: string
  msg: string
}

export async function fetchEvents(): Promise<PanelEvent[]> {
  const r = await fetch('/api/events')
  if (!r.ok) throw new Error('HTTP ' + r.status)
  const j = await r.json()
  return (j.events ?? []) as PanelEvent[]
}

/* ---------- 接入信息（「接入」页签：地址 / 密钥 / 模型 / 代码片段） ---------- */
export interface AccessModel {
  id: string
  label?: string
  note?: string
}
export interface SvcAccess {
  svc: string
  name: string
  port: number
  panel_base: string
  local_base: string
  has_key: boolean
  key_masked: string
  protocols: string[] // openai | anthropic
  models: AccessModel[]
  models_err?: string
  running: boolean
}
export interface AccessReport {
  at: string
  services: SvcAccess[]
}

export async function fetchAccess(): Promise<AccessReport> {
  const r = await fetch('/api/access')
  if (!r.ok) throw new Error('HTTP ' + r.status)
  return (await r.json()) as AccessReport
}

/** 明文密钥：后端只对来自本机的请求返回，其他情况会 403。 */
export async function fetchKey(id: string): Promise<string> {
  const r = await fetch(`/api/access/${id}/key`)
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status)
  return String(j.key ?? '')
}

/* ---------- 单个服务自身的用量统计 ----------
   workbuddy / qoder 的 /panel/api/stats 形状；这两个服务是唯一提供
   「按模型 / 按账号 / 小时粒度 / 延迟 / 成功率」的口径，cline 与 cmdgo 都没有。
   range=today 时 unit 会变成 hour，series 是 24 个桶。 */
export interface SvcStatBucket {
  key: string
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  requests?: number
  usage_count?: number
  latency_ms_sum?: number
  latency_count?: number
  failures?: number
}
export interface SvcStatRow extends SvcStatBucket {
  label?: string
  share?: number
}
export interface SvcStatTotals {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  requests?: number
  usage_count?: number
  failed?: number
  avg_latency_ms?: number
  avg_tokens_per_sec?: number
  avg_tokens_per_request?: number
  success_rate?: number
}
export interface SvcStats {
  range: string
  unit: 'day' | 'hour'
  series: SvcStatBucket[]
  totals: SvcStatTotals
  by_model: SvcStatRow[]
  by_account: SvcStatRow[]
  pool_total?: SvcStatTotals & { active_accounts?: number }
  since_start?: SvcStatTotals & { since?: string; active_accounts?: number }
  covered_days?: number
  first_day?: string
  last_day?: string
  keep_days?: number
}

export async function fetchSvcStats(id: string, range: 'today' | '7d' | '30d'): Promise<SvcStats> {
  // 经面板代理：鉴权由服务端注入，前端不需要密钥
  const r = await fetch(`/api/svc/${id}/panel/api/stats?range=${range}`)
  if (!r.ok) throw new Error('HTTP ' + r.status)
  return (await r.json()) as SvcStats
}

/* ---------- cline 的 /v1/status（账号级累计） ---------- */
export interface ClineAccountStat {
  id: string
  email: string
  enabled?: boolean
  available?: boolean
  usage?: { input?: number; output?: number; reasoning?: number; total?: number; calls?: number }
  stats?: { ok?: number; fail?: number; last_used_at?: number }
}
export interface ClineStatus {
  account_count: number
  accounts_available: number
  models_available?: number
  account_details: ClineAccountStat[]
  strategy?: string
  default_model?: string
}

export async function fetchClineStatus(): Promise<ClineStatus> {
  const r = await fetch('/api/svc/cline/v1/status')
  if (!r.ok) throw new Error('HTTP ' + r.status)
  return (await r.json()) as ClineStatus
}
