/* 服务 logo 与面板主标。
 *
 * 服务 logo：四家上游产品的**官方图形**（取自各自官网的 favicon / brand 资产），
 * 见 logos.ts 的来源说明。按品牌资产原样使用（含官方底板与配色），不再用自制的像素标记，
 * 也不要按主题着色。
 *
 * 面板主标：「两个梯子搭成的一个 A」——每条腿画成一把梯子（两条平行轨 + 垂直于轨的横档），
 * 两梯在顶点相靠，上半档两两对齐自然连成 A 的横杠，脚底沿水平线切平。单色走 currentColor。
 */
import type { CSSProperties } from 'react'
import { SERVICE_LOGOS, MARK_INNER } from './logos'

/** 服务官方 logo。容器需自行给出尺寸与圆角；官方底板已含背景。
 *
 * 没有官方图形的服务（自建服务，如 zen）退化为中性字母牌：不伪造任何第三方
 * 品牌资产，也不让页头的图标位空成一个洞。 */
export function ServiceLogo({
  id,
  size = 18,
  style,
}: {
  id: string
  size?: number
  style?: CSSProperties
}) {
  const src = SERVICE_LOGOS[id]
  const radius = Math.max(3, Math.round(size * 0.28))
  if (!src) {
    return (
      <span
        aria-hidden
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: size,
          height: size,
          borderRadius: radius,
          flex: 'none',
          background: 'var(--line)',
          color: 'var(--muted)',
          fontSize: Math.max(9, Math.round(size * 0.52)),
          fontWeight: 700,
          lineHeight: 1,
          textTransform: 'uppercase',
          ...style,
        }}
      >
        {id.slice(0, 1)}
      </span>
    )
  }
  return (
    <img
      src={src}
      width={size}
      height={size}
      alt=""
      aria-hidden
      style={{ display: 'block', borderRadius: radius, flex: 'none', ...style }}
    />
  )
}

/** 面板主标（单色，随 currentColor）。 */
export function PanelMark({ size = 22, style }: { size?: number; style?: CSSProperties }) {
  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      aria-hidden
      fill="currentColor"
      stroke="currentColor"
      strokeLinejoin="miter"
      style={{ display: 'block', flex: 'none', ...style }}
      dangerouslySetInnerHTML={{ __html: MARK_INNER }}
    />
  )
}

/* 兼容旧调用点：以前是 16×16 像素 glyph，现在统一返回官方 logo。 */
export const ServiceGlyph = ServiceLogo
