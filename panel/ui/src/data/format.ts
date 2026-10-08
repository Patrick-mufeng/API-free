/* 数字格式化（纯函数，不含任何数据） */

export function fmtInt(n: number): string {
  return Number(n || 0).toLocaleString('en-US')
}

export function fmtTok(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—'
  if (n >= 1e12) return (n / 1e12).toFixed(2) + '万亿'
  if (n >= 1e8) return (n / 1e8).toFixed(2) + '亿'
  if (n >= 1e4) return (n / 1e4).toFixed(2) + '万'
  return fmtInt(n)
}

/** 秒数 → 「1.2s」/「840ms」 */
export function fmtDur(sec: number | null | undefined): string {
  if (sec == null || Number.isNaN(sec) || sec <= 0) return '—'
  return sec < 1 ? Math.round(sec * 1000) + 'ms' : sec.toFixed(2) + 's'
}
