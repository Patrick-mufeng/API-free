/* 服务视图：真实名称/端口/状态一律来自 /api/services（注册表口径）。
   这里只保留属于界面身份的东西（配色、展示顺序），避免与注册表脱节。 */
import type { SvcSnapshot } from '../api'

export const SVC_COLOR: Record<string, string> = {
  workbuddy: '#2f9e5f',
  qoder: '#3d6fd0',
  cline: '#c07427',
  cmdgo: '#cc4b44',
  zen: '#6b5bd2',
}

const SVC_ORDER = ['workbuddy', 'qoder', 'zen', 'cline', 'cmdgo']

/** 固定展示顺序：注册表里多出来的服务排在已认识的四个之后。 */
export function orderIndex(id: string): number {
  const i = SVC_ORDER.indexOf(id)
  return i < 0 ? SVC_ORDER.length : i
}

export function svcColor(id: string): string {
  return SVC_COLOR[id] ?? 'var(--muted)'
}

export type SvcStatus = 'running' | 'booting' | 'stopped'

export interface SvcView {
  id: string
  name: string
  port: number
  color: string
  status: SvcStatus
  pid: number
  managed: boolean
  restarts: number
  lastError?: string
}

export function toView(s: SvcSnapshot): SvcView {
  return {
    id: s.id,
    name: s.name,
    port: s.port,
    color: svcColor(s.id),
    status: s.status === 'running' ? 'running' : s.status === 'starting' ? 'booting' : 'stopped',
    pid: s.pid,
    managed: s.managed,
    restarts: s.restarts,
    lastError: s.lastError,
  }
}

/** 视图列表：按固定顺序，注册表里多出来的服务排在后面。 */
export function toViews(list: SvcSnapshot[]): SvcView[] {
  return list
    .map(toView)
    .sort((a, b) => orderIndex(a.id) - orderIndex(b.id))
}

/** 服务短名（KPI 小字用）：workbuddy / qoder / cline / cmdgo */
export function shortName(view: { id: string; name: string }): string {
  return view.id
}
