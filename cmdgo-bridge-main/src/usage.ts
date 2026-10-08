// 只读用量统计（/api/usage）：内存累计 + 定期落盘 dataDir/usage.json。
// 记账点：/v1/chat/completions 每次成功完成（流式最终 usage / 非流式 ok）。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface UsageDay {
  date: string
  requests: number
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

interface UsageFile {
  total: Omit<UsageDay, 'date'>
  daily: Record<string, Omit<UsageDay, 'date'>>
}

function zero(): Omit<UsageDay, 'date'> {
  return { requests: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
}

let dataDir = '.'
let cur: UsageFile = { total: zero(), daily: {} }
let loaded = false
let flushTimer: ReturnType<typeof setTimeout> | null = null

export function initUsage(dir: string): void {
  dataDir = dir
  loaded = false
  load()
}

function load(): void {
  if (loaded) return
  loaded = true
  try {
    const raw = JSON.parse(readFileSync(join(dataDir, 'usage.json'), 'utf8')) as UsageFile
    if (raw && typeof raw === 'object' && raw.total && raw.daily) cur = raw
  } catch {
    /* 首次或损坏时从零开始 */
  }
}

function flush(): void {
  try {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(join(dataDir, 'usage.json'), JSON.stringify(cur, null, 2))
  } catch {
    /* 磁盘问题不阻塞主流程 */
  }
}

function scheduleFlush(): void {
  if (flushTimer !== null) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    flush()
  }, 2000)
}

export function recordUsage(promptTokens: number, completionTokens: number): void {
  load()
  const key = localDay()
  const d = cur.daily[key] ?? (cur.daily[key] = zero())
  d.requests += 1
  d.prompt_tokens += promptTokens
  d.completion_tokens += completionTokens
  d.total_tokens += promptTokens + completionTokens
  cur.total.requests += 1
  cur.total.prompt_tokens += promptTokens
  cur.total.completion_tokens += completionTokens
  cur.total.total_tokens += promptTokens + completionTokens
  scheduleFlush()
}

export function usageSnapshot(): { total: Omit<UsageDay, 'date'>; days: UsageDay[] } {
  load()
  flush()
  const days = Object.keys(cur.daily)
    .sort()
    .map((date) => ({ date, ...(cur.daily[date] ?? zero()) }))
  return { total: cur.total, days }
}

function localDay(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
