export type Route =
  | 'overview'
  | 'stats'
  | 'logs'
  | 'settings'
  | { svc: string }

/* 图标栏用的线性图标（16×16，stroke=currentColor）。
   图标一律 1.5 线宽，与表格里的细线同一个语言。 */
const ICONS: Record<string, JSX.Element> = {
  overview: (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
      <rect x="1.9" y="1.9" width="5" height="5" /><rect x="9.1" y="1.9" width="5" height="5" />
      <rect x="1.9" y="9.1" width="5" height="5" /><rect x="9.1" y="9.1" width="5" height="5" />
    </svg>
  ),
  stats: (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M2.2 13.6h11.6" /><path d="M4.6 13.6V8.4" /><path d="M8 13.6V3.4" /><path d="M11.4 13.6V6.2" />
    </svg>
  ),
  logs: (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M2.4 3.6h11.2" /><path d="M2.4 8h11.2" /><path d="M2.4 12.4h7.6" />
    </svg>
  ),
  settings: (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M2.4 4.6h11.2" /><circle cx="6" cy="4.6" r="1.7" />
      <path d="M2.4 11.4h11.2" /><circle cx="10.4" cy="11.4" r="1.7" />
    </svg>
  ),
}

export function Logo(_props: { center?: string }) {
  return <PanelMark size={26} style={{ color: 'var(--text)' }} />
}

import { ServiceGlyph, PanelMark } from './ServiceIcons'

const PAGE_LABEL: Record<string, string> = { overview: '总览', stats: '统计', logs: '日志', settings: '设置' }

export function Sidebar({
  route,
  services,
  onNav,
}: {
  route: Route
  services: { id: string; name: string; status: string; color?: string }[]
  onNav: (r: Route) => void
}) {
  const isPage = (p: string) => route === p
  const isSvc = (id: string) => !(typeof route === 'string') && route.svc === id
  return (
    <aside className="side">
      <div className="brand" title="API-free 统一面板">
        <Logo />
      </div>
      <nav>
        {(['overview', 'stats', 'logs', 'settings'] as const).map((p) => (
          <button
            key={p}
            className={`nitem${isPage(p) ? ' on' : ''}`}
            onClick={() => onNav(p)}
            title={PAGE_LABEL[p]}
          >
            {ICONS[p]}
            {/* 标签保留在 DOM 里给读屏用，视觉上由 CSS 收起 */}
            <span className="nlbl">{PAGE_LABEL[p]}</span>
          </button>
        ))}
      </nav>
      <div className="grp">服务</div>
      <nav>
        {services.map((s) => (
          <button
            key={s.id}
            className={`nitem${isSvc(s.id) ? ' on' : ''}`}
            onClick={() => onNav({ svc: s.id })}
            title={`${s.name}${s.status === 'stopped' ? ' · 已停止' : ''}`}
          >
            <span className="ava">
              <ServiceGlyph id={s.id} size={22} />
            </span>
            <span className="nlbl">{s.name}</span>
            <span className={`dot ${s.status === 'stopped' ? 'stop' : 'run'}`} />
          </button>
        ))}
      </nav>
      <div className="spacer" />
    </aside>
  )
}
