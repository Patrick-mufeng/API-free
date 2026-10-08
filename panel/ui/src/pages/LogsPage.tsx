/* 日志页：面板事件流 + 各服务运行日志。
   服务清单来自 /api/services；有没有日志接口靠实际请求判定，不写死能力表。 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { PageHead } from '../components/ui'
import { fetchServices } from '../api'
import { toViews, type SvcView } from '../data/services'

interface PEvent {
  t: string
  msg: string
}

/** 没有日志接口的服务：说明日志实际在哪里（这些是各服务自身的行为，不是占位文案） */
const NO_API_NOTE: Record<string, string> = {
  cline: 'cline 的请求日志只存在内存里（原控制台同样如此）；统计数据见「统计」页。',
  cmdgo: 'cmdgo 的访问日志在服务终端输出；面板侧事件见上方。',
}
const NO_API_FALLBACK = '该服务没有暴露日志接口。'

export function LogsPage() {
  const [events, setEvents] = useState<PEvent[]>([])
  const [svcs, setSvcs] = useState<SvcView[]>([])
  const [svc, setSvc] = useState('')
  const [lines, setLines] = useState<string[]>([])
  const [auto, setAuto] = useState(true)
  const [err, setErr] = useState('')
  const evRef = useRef<HTMLPreElement>(null)
  const svcRef = useRef<HTMLPreElement>(null)
  const afterRef = useRef(0)

  // 服务清单
  useEffect(() => {
    let alive = true
    fetchServices()
      .then((l) => {
        if (!alive) return
        const v = toViews(l)
        setSvcs(v)
        setSvc((cur) => cur || v[0]?.id || '')
      })
      .catch(() => { /* 后端未起：下面显示空态 */ })
    return () => { alive = false }
  }, [])

  // 面板事件流
  useEffect(() => {
    let alive = true
    async function poll() {
      try {
        const r = await fetch('/api/events')
        const j = await r.json()
        if (alive) setEvents(j.events ?? [])
      } catch { /* 后端未起 */ }
    }
    poll()
    const t = setInterval(poll, 3000)
    return () => { alive = false; clearInterval(t) }
  }, [])

  /* 服务运行日志。两个服务的形状不同，不能都按增量处理：
     - workbuddy → {entries:[{ts,ch,text}]} 是**整环快照**（无 after 参数），整段替换；
       当增量 append 会每 3 秒把同一批再叠一遍。
     - qoder → {entries:[{id,ch,text,ts}]} 是**增量**，用最后一条 id 作下次游标。 */
  const loadSvcLog = useCallback(async () => {
    if (!svc) return
    const snapshot = svc !== 'qoder'
    try {
      const q = snapshot ? '' : `?after=${afterRef.current}`
      const r = await fetch(`/api/svc/${svc}/panel/api/logs${q}`)
      if (!r.ok) throw new Error('HTTP ' + r.status)
      const j = await r.json().catch(() => { throw new Error('接口没有返回 JSON') })
      if (j && j.error) throw new Error(j.error)
      const items: any[] = j.entries ?? j.logs ?? j.lines ?? []
      const add = items.map((l: any) => {
        if (typeof l === 'string') return l
        const ch = String(l.ch ?? l.channel ?? '')
        const time = String(l.ts ?? l.time ?? '').replace('T', ' ').slice(0, 19)
        const text = String(l.text ?? l.message ?? l.line ?? JSON.stringify(l))
        // 有的服务（qoder）文本本身就以时间开头，不再重复加前缀
        const dupTime = /^\d{4}[-/]\d{2}[-/]\d{2}[ T]\d{2}:\d{2}/.test(text)
        return (ch ? `[${ch}] ` : '') + (time && !dupTime ? time + ' ' : '') + text
      })
      if (!snapshot) afterRef.current = Number(items[items.length - 1]?.id ?? afterRef.current) || afterRef.current
      if (snapshot) setLines(add.slice(-800))
      else if (add.length) setLines((xs) => [...xs, ...add].slice(-800))
      setErr('')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [svc])

  useEffect(() => {
    afterRef.current = 0
    setLines([])
    setErr('')
    void loadSvcLog()
    const t = setInterval(() => void loadSvcLog(), 3000)
    return () => clearInterval(t)
  }, [loadSvcLog])

  useEffect(() => { if (auto && evRef.current) evRef.current.scrollTop = evRef.current.scrollHeight }, [events, auto])
  useEffect(() => { if (auto && svcRef.current) svcRef.current.scrollTop = svcRef.current.scrollHeight }, [lines, auto])

  const meta = svcs.find((s) => s.id === svc)
  const stopped = meta?.status === 'stopped'
  const noApi = !stopped && !!err

  return (
    <div className="wrap">
      <PageHead title="日志" sub="面板事件流 + 各服务运行日志">
        <button className="btn" onClick={() => setAuto(!auto)}>自动滚动：{auto ? '开' : '关'}</button>
      </PageHead>

      <div className="sect">
        <div className="sect-head"><h3>面板事件</h3><span className="sub">启停 / 崩溃拉起 / 统计拉取 · 3s 刷新</span></div>
        <pre className="logpre" ref={evRef} style={{ maxHeight: 260 }}>
          {events.length === 0 ? '暂无事件（后端未连接或刚启动）。' : events.map((e, i) => `${e.t}  ${e.msg}`).join('\n')}
        </pre>
      </div>

      <div className="sect" style={{ marginBottom: 0 }}>
        <div className="sect-head">
          <h3>服务运行日志</h3>
          <span className="sp" />
          <div className="seg">
            {svcs.map((s) => (
              <button key={s.id} className={s.id === svc ? 'on' : ''} onClick={() => setSvc(s.id)}>{s.name}</button>
            ))}
          </div>
        </div>
        {svcs.length === 0 ? (
          <div className="empty"><b>读不到服务列表</b><span>面板后端未连接，或注册表为空。</span></div>
        ) : stopped ? (
          <div className="empty">
            <b>{meta?.name} 未运行</b>
            <span>运行日志由服务进程产生；在总览页把它启动后，这里会显示它 /panel/api/logs 的内容。</span>
          </div>
        ) : noApi ? (
          <div className="empty">
            <b>{meta?.name} 没有历史日志接口</b>
            <span>{NO_API_NOTE[svc] ?? NO_API_FALLBACK}（接口返回：{err}）</span>
          </div>
        ) : (
          <pre className="logpre" ref={svcRef}>
            {lines.length === 0 ? '暂无日志（服务刚启动或还没有产生记录）。' : lines.join('\n')}
          </pre>
        )}
      </div>
    </div>
  )
}
