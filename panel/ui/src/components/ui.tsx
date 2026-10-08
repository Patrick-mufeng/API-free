import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'
import { fmtTok } from '../data/format'

/* ---------- 弹层（渲染到 body） ----------
   为什么必须 Portal：`.veil` 用的是 `position: fixed; inset: 0`，而 CSS 规范里
   只要**任意祖先**的计算 transform 不是 none，fixed 就改为相对那个祖先定位。
   视图进入动画（.wrap > * 的 rise）曾用 fill-mode: both 收尾，把计算值停在
   恒等矩阵 matrix(1,0,0,1,0,0) 上——那不等于 none ——于是遮罩被压在它所在的那个
   `.sect` 里，实测只剩 52px 高，弹层被页面内容盖住。
   挂到 body 下就与内容区的动画/变换彻底解耦，不再受这类意外影响。 */
export function Veil({ onClose, children, width }: { onClose?: () => void; children: ReactNode; width?: string }) {
  // SSR / 测试环境下没有 document，则退回原位渲染（本项目是纯 SPA，正常都会有）
  if (typeof document === 'undefined') return null
  return createPortal(
    <div className="veil" style={{ display: 'flex' }} onClick={(e) => { if (onClose && e.target === e.currentTarget) onClose() }}>
      <div className="modal" style={width ? { width } : undefined}>{children}</div>
    </div>,
    document.body,
  )
}

/* ---------- 徽标 ---------- */
export function Badge({ kind, children }: { kind: string; children: ReactNode }) {
  return (
    <span className={`st ${kind}`}>
      <i />
      {children}
    </span>
  )
}

/* ---------- 开关 ---------- */
export function Switch({
  checked,
  disabled,
  onChange,
  label,
}: {
  checked: boolean
  disabled?: boolean
  onChange?: (next: boolean) => void
  label?: string
}) {
  return (
    <button
      className="sw"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => !disabled && onChange?.(!checked)}
    />
  )
}

/* ---------- 分段控件 ---------- */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { v: T; label: string }[]
  value: T
  onChange: (v: T) => void
}) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button key={o.v} className={o.v === value ? 'on' : ''} onClick={() => onChange(o.v)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

/* ---------- 页头 ---------- */
export function PageHead({ title, sub, children }: { title: string; sub?: string; children?: ReactNode }) {
  return (
    <div className="pagehead">
      <h1>{title}</h1>
      {sub && <span className="sub">{sub}</span>}
      <span className="sp" />
      {children}
    </div>
  )
}

/* ---------- Toast（window 事件总线，轻量实现） ---------- */
export function toast(msg: string, kind?: 'ok' | 'err') {
  window.dispatchEvent(new CustomEvent('panel-toast', { detail: { msg, kind } }))
}

export function Toaster() {
  const [items, setItems] = useState<{ id: number; msg: string; kind?: string; out?: boolean }[]>([])
  useEffect(() => {
    let seq = 0
    const onToast = (e: Event) => {
      const { msg, kind } = (e as CustomEvent).detail ?? {}
      const id = ++seq
      setItems((xs) => [...xs, { id, msg, kind }])
      setTimeout(() => setItems((xs) => xs.map((x) => (x.id === id ? { ...x, out: true } : x))), 2900)
      setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), 3200)
    }
    window.addEventListener('panel-toast', onToast)
    return () => window.removeEventListener('panel-toast', onToast)
  }, [])
  return (
    <div id="toasts">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.kind ?? ''}${t.out ? ' out' : ''}`}>
          {t.msg}
        </div>
      ))}
    </div>
  )
}

/* ---------- 面积图（平滑曲线 + 渐变 + 悬停读数 + 请求量细条） ---------- */
export interface Series {
  name: string
  color: string
  data: number[]
}

/* 轴刻度专用格式：整数，或万级缩写。fmtTok 在 <1e4 时原样输出，
   刻度上会出现 922.32 这种小数，很脏。 */
function axisNum(v: number): string {
  if (v >= 100000) return (v / 10000).toFixed(0) + '万'
  if (v >= 10000) return (v / 10000).toFixed(1) + '万'
  return String(Math.round(v))
}

export function AreaChart({
  series,
  mode,
  labels,
  reqData,
  height,
  barStyle = 'tick',
  startIdx,
  onHover,
}: {
  series: Series[]
  mode: 'area' | 'split'
  labels: string[]
  reqData?: number[]
  /** 不传则用 .chartbox 的 CSS 高度（默认 250px）；传 '100%' 可让它撑满弹性容器 */
  height?: number | string
  barStyle?: 'tick' | 'pill'
  /** 首批有数据的下标：在它左侧表示“尚未收录”，画一条虚线起点标记 */
  startIdx?: number
  onHover?: (i: number) => string
}) {  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null)
  const W = 1000
  const H = 250
  const padL = 46            // 左侧刻度栏：纵轴数值用 HTML 画，不放进被拉伸的 SVG
  const padB = reqData ? 40 : 22
  const padT = 10
  const n = series[0].data.length
  const max = Math.max(1, ...series.flatMap((s) => s.data)) * 1.12
  const x = (i: number) => padL + (i / (n - 1)) * (W - padL)
  const y = (v: number) => padT + (1 - v / max) * (H - padT - padB)

  function smooth(pts: [number, number][]): string {
    if (pts.length < 3) return 'M' + pts.map((p) => `${p[0]} ${p[1]}`).join(' L')
    let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)]
      const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6
      const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6
      d += ` C${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`
    }
    return d
  }

  const grid = [1, 2, 3, 4].map((gi) => {
    const gy = padT + (H - padT - padB) * (gi / 4)
    return <line key={gi} className="grid-line" x1={padL} y1={gy} x2={W} y2={gy} vectorEffect="non-scaling-stroke" />
  })
  // 轴标签用 HTML 渲染：SVG 是 preserveAspectRatio="none" 拉伸的，
  // 放在里面的 <text> 会跟着横向变形，字距被拉坏。
  const marks = [0, Math.round((n - 1) / 2), n - 1]

  const gid = 'grad-' + series[0].name.replace(/\W/g, '')
  let paths: ReactNode
  if (mode === 'area') {
    const pts = series[0].data.map((v, i) => [x(i), y(v)] as [number, number])
    const d = smooth(pts)
    paths = (
      <>
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={series[0].color} stopOpacity=".22" />
            <stop offset="1" stopColor={series[0].color} stopOpacity=".03" />
          </linearGradient>
        </defs>
        <path d={`${d} L${W} ${H - padB} L${padL} ${H - padB} Z`} fill={`url(#${gid})`} />
        <path d={d} fill="none" stroke={series[0].color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      </>
    )
  } else {
    paths = series.map((s) => {
      const d = smooth(s.data.map((v, i) => [x(i), y(v)] as [number, number]))
      return <path key={s.name} d={d} fill="none" stroke={s.color} strokeWidth="1.6" strokeLinecap="round" opacity=".9" vectorEffect="non-scaling-stroke" />
    })
  }
  const bars = reqData
    ? reqData.map((v, i) => {
        const rMax = Math.max(1, ...reqData)
        const isMax = v === rMax
        if (barStyle === 'pill') {
          // 薄荷风格：圆头药丸柱，最高一根用强调色（参考 Quixotic 柱图）
          const h = Math.max(v > 0 ? 6 : 3, (v / rMax) * 34)
          return (
            <rect
              key={i} x={x(i) - 7} y={H - padB + 14 - h} width={14} height={h} rx={7}
              fill={isMax ? 'var(--accent)' : 'var(--bar-fill)'}
            />
          )
        }
        const h = Math.max(v > 0 ? 2 : 1, (v / rMax) * 22)
        return <rect key={i} x={x(i) - 3} y={H - padB + 14 - h} width={6} height={h} rx={1.5} fill="var(--bar-fill)" />
      })
    : null

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    const r = e.currentTarget.getBoundingClientRect()
    const px = ((e.clientX - r.left) / r.width) * W
    const i = Math.max(0, Math.min(n - 1, Math.round((px - padL) / ((W - padL) / (n - 1)))))
    const vals = series.map((s) => s.data[i])
    const top = mode === 'split' ? vals[0] : vals.reduce((a, b) => a + b, 0)
    setHover({ i, x: (x(i) / W) * r.width, y: (y(top) / H) * r.height })
  }

  const tipHtml = hover ? (onHover ? onHover(hover.i) : `<b>${labels[hover.i]}</b>合计 ${fmtTok(series[0].data[hover.i])}`) : ''

  // 记录起点：左侧的平坦段是「还没开始收录」，不是「用量为 0」
  const markStart = startIdx !== undefined && startIdx > 0 && startIdx < n
  const startAtRight = markStart && startIdx > n * 0.72

  return (
    <div className="chartbox" style={height !== undefined ? { height } : undefined}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        {grid}
        {markStart && (
          <>
            <line
              x1={x(startIdx)} y1={padT} x2={x(startIdx)} y2={H - padB}
              stroke="var(--faint)" strokeWidth="1" strokeDasharray="3 4" opacity=".8"
              vectorEffect="non-scaling-stroke"
            />
          </>
        )}
        {paths}
        {bars}
        {hover && (
          <>
            <line className="guide" x1={x(hover.i)} y1={padT} x2={x(hover.i)} y2={H - padB} stroke="var(--muted)" strokeWidth="1" opacity=".35" vectorEffect="non-scaling-stroke" />
            <circle cx={x(hover.i)} cy={y(series[0].data[hover.i])} r={3.5} fill={series[0].color} stroke="#fff" strokeWidth={2} vectorEffect="non-scaling-stroke" />
          </>
        )}
      </svg>
      <div className="chart-axis" aria-hidden>
        <span>{labels[marks[0]]}</span>
        <span>{labels[marks[1]]}</span>
        <span>{labels[marks[2]]}</span>
      </div>
      <div className="chart-y" aria-hidden>
        {[1, 2, 3, 4].map((gi) => (
          <span key={gi} style={{ top: `${((padT + (H - padT - padB) * (gi / 4)) / H) * 100}%` }}>
            {axisNum(max * (1 - gi / 4))}
          </span>
        ))}
      </div>
      {markStart && (
        <div
          className="chart-start"
          style={{ left: `${(x(startIdx) / W) * 100}%`, transform: startAtRight ? 'translateX(calc(-100% - 6px))' : 'translateX(6px)' }}
        >
          记录起点
        </div>
      )}
      {hover && (
        <div className="chart-tip" style={{ left: hover.x, top: hover.y, opacity: 1 }} dangerouslySetInnerHTML={{ __html: tipHtml }} />
      )}
    </div>
  )
}
