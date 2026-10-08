/* M4：服务详情页扩展面板 —— workbuddy 任务中心 / cline 对话测试 / cline 模型库 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { AreaChart, toast } from '../components/ui'

function useSvcApi(id: string) {
  return useCallback(async (path: string, opts?: RequestInit) => {
    const r = await fetch('/api/svc/' + id + path, opts)
    const j = await r.json().catch(() => null)
    if (!r.ok) throw new Error((j && j.error) || 'HTTP ' + r.status)
    if (j && j.error) throw new Error(j.error)
    return j
  }, [id])
}
/* 防御式取值：命中第一个存在的键就返回它。
   注意：找不到键时**必须返回 undefined**（与 ServicePage 的同名函数一致）。
   返回整个对象 o 会让 String(pick(x,'k') ?? fallback) 里的 ?? 永不生效
   —— 因为对象不是 nullish —— 于是界面渲染出 [object Object]。 */
function pick<T = any>(o: any, ...ks: string[]): T | undefined {
  for (const k of ks) if (o && o[k] != null) return o[k]
  return undefined
}
function fmtTok(n: number): string {
  if (!n) return '0'
  if (n >= 1e8) return (n / 1e8).toFixed(2) + '亿'
  if (n >= 1e4) return (n / 1e4).toFixed(2) + '万'
  return fmtInt(n)
}
function fmtNum(n: number): string {
  return Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })
}
function fmtInt(n: unknown): string {
  return Number(n || 0).toLocaleString('en-US')
}

/* ================= workbuddy 任务中心 ================= */
/** 开学季任务槽（真实 task_code 映射，摘自 workbuddy /panel/api/school/status） */
const SCHOOL_SLOTS: { code: string; label: string; tip: string; skip?: boolean }[] = [
  { code: 'share_invite', label: '分享', tip: '分享活动 +100c' },
  { code: 'desktop_chat_1_time', label: '桌面', tip: '桌面端体验 +100c（单次）' },
  { code: 'chat_3_times', label: '对话×3', tip: '和 AI 对话 3 次 +50c' },
  { code: 'expert_use', label: '专家', tip: '召唤开学季专家 +50c' },
  { code: 'task_student_verify', label: '认证', tip: '学生认证 +100c（需真实认证，不做）', skip: true },
]

function slotCell(t: any): { sym: string; txt: string; cls: string } {
  if (!t) return { sym: '·', txt: '—', cls: 'todo' }
  const st = String(t.status ?? '').toLowerCase()
  const prog = Number(t.progress ?? 0)
  const tgt = Number(t.target_count ?? 1)
  if (st === 'claimed' || st === 'done' || st === 'finished') return { sym: '✓', txt: '已领', cls: 'done' }
  if (st === 'claimable' || st === 'available') return { sym: '◆', txt: '可领', cls: 'avail' }
  if (prog > 0 && prog < tgt) return { sym: '◐', txt: `${prog}/${tgt}`, cls: 'part' }
  if (prog >= tgt) return { sym: '◆', txt: '可领', cls: 'avail' }
  return { sym: '○', txt: '未做', cls: 'todo' }
}

export function TasksPanel({ live }: { live: boolean }) {
  const api = useSvcApi('workbuddy')
  const [school, setSchool] = useState<any>(null)
  const [queue, setQueue] = useState<any>(null)
  const [conc, setConc] = useState('3')
  const [preview, setPreview] = useState<any[] | null>(null)
  const [err, setErr] = useState('')
  // 轮询的 setInterval 只创建一次，闭包里直接读 queue 会永远是初始的 null —— 用 ref 跟上最新值
  const queueRef = useRef<any>(null)
  queueRef.current = queue

  const loadSchool = useCallback(async () => {
    try {
      const j = await api('/panel/api/school/status')
      setSchool(j)
      setErr('')
      return j
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      return null
    }
  }, [api])
  const loadQueue = useCallback(async () => {
    try {
      setQueue(await api('/panel/api/tasks/queue'))
      setErr('')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [api])

  useEffect(() => {
    if (!live) return
    void loadSchool()
    void loadQueue()
    const t = setInterval(() => {
      void loadQueue()
      // 队列里会真的推进任务进度（成长任务 / 开学季闭环），
      // 执行期间同步回读开学季状态，否则五格一直停在旧值 —— 看起来就像「点了没反应」。
      if (pick(queueRef.current, 'running')) void loadSchool()
    }, 2500)
    return () => clearInterval(t)
  }, [live, loadSchool, loadQueue])

  async function scanNow() {
    try {
      const j = await api('/panel/api/tasks/scan_all', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      const accs = pick<any[]>(j, 'accounts') ?? []
      setPreview(accs)
      const pending = Number(pick(j, 'pending_count') ?? accs.reduce((n: number, a: any) => n + (a.growth?.length ?? 0), 0))
      toast(`扫描完成：${accs.length} 个账号 · ${pending} 项待办`, 'ok')
      void loadQueue()
    } catch (e) {
      toast('扫描失败：' + (e instanceof Error ? e.message : String(e)), 'err')
    }
  }

  async function post(path: string, body?: any, okMsg?: string) {
    try {
      const j: any = await api('/panel/api/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) })
      // 后端对「没有可执行待办」这类情况返回 started:false + message。
      // 以前这里把响应整个丢掉、一律报成功，于是用户看到「队列已启动」但其实什么都没发生。
      const started = pick(j, 'started')
      if (started === false) {
        toast(String(pick(j, 'message') ?? '后端未启动该动作'), 'err')
      } else if (okMsg) {
        toast(okMsg, 'ok')
      }
      void loadQueue()
      void loadSchool()
      return j
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err')
      return null
    }
  }

  /* 开学季闭环：school/run_all 是即发即忘（后端没有 job 句柄），
     所以前端自己回读几次状态，把真实结果报出来 —— 否则用户只看到一句
     「已开始」，然后界面毫无变化。 */
  async function runSchoolLoop() {
    const why = inPeriod ? '' : '（当前不在活动期，上游不会给这些任务计数，状态预计不会变）'
    if (!confirm(`将对全部账号执行开学季闭环（分享 / 桌面 / 对话 / 专家 + 抽奖），约 1-2 分钟。${why}确认继续？`)) return
    const j = await post('school/run_all', {})
    if (!j) return
    toast('闭环已触发，正在回读状态…')
    let total = 0
    let done = 0
    for (const wait of [1500, 3000, 4000]) {
      await new Promise((r) => setTimeout(r, wait))
      const snap: any = await loadSchool()
      const rows = pick<any[]>(snap, 'accounts') ?? []
      total = 0
      done = 0
      rows.forEach((row: any) => {
        ;(pick<any[]>(row, 'tasks') ?? []).forEach((t: any) => {
          total++
          const st = String(pick(t, 'status') ?? '')
          const prog = Number(pick(t, 'progress') ?? 0)
          const target = Number(pick(t, 'target_count') ?? 0)
          if (st === 'claimed' || (target > 0 && prog >= target)) done++
        })
      })
      if (total > 0 && done === total) break
    }
    if (total === 0) toast('闭环已执行，但没有读到开学季任务', 'err')
    else if (done === 0) toast(`闭环已执行：${done}/${total} 项完成${inPeriod ? '' : '（不在活动期，上游不计数）'}`, 'err')
    else toast(`闭环完成：${done}/${total} 项已完成`, 'ok')
  }

  if (!live) return <NotRunning />
  const schoolRows = pick<any[]>(school, 'accounts') ?? []
  const inPeriod = schoolRows.some((r: any) => r.in_period)
  /* 「今日全部完成」汇总（原面板 schoolSummary）：学生认证那格不算完成度，
     剩下 4 格全 claimed 才算该账号今日全部完成。 */
  const schoolDoneCount = schoolRows.filter((r: any) => {
    const ts: any[] = Array.isArray(r.tasks) ? r.tasks : []
    const by = new Map(ts.map((t: any) => [String(t.task_code ?? ''), t]))
    return SCHOOL_SLOTS.filter((sl) => !sl.skip).every((sl) => String(by.get(sl.code)?.status ?? '') === 'claimed')
  }).length
  const schoolDoneText = schoolRows.length > 0 && schoolDoneCount === schoolRows.length
    ? '今日全部完成'
    : `${schoolDoneCount}/${schoolRows.length} 个账号今日全部完成`
  const qItems = pick<any[]>(queue, 'items') ?? []
  const qTotal = Number(pick(queue, 'total') ?? qItems.length)
  const qDone = qItems.filter((it: any) => String(it.status ?? '') === 'done').length
  const qRunning = Boolean(pick(queue, 'running'))
  const pct = qTotal > 0 ? Math.round((qDone / qTotal) * 100) : 0

  return (
    <>
      <div className="sect" style={{ marginBottom: 14 }}>
        <div className="sect-head">
          <h3>开学季</h3>
          <span className="sub">每日重置 · 五格为各任务进度{schoolRows.length > 0 ? ` · ${schoolDoneText}` : ''}</span>
          {schoolRows.length > 0 && !inPeriod && <span className="chip">不在活动期 · 上游不计数</span>}
          <span className="sp" />
          <button className="btn xs" onClick={() => void loadSchool()}>刷新</button>
          <button className="btn xs pri" onClick={() => void runSchoolLoop()}>全部账号执行闭环</button>
        </div>
        {err && !school ? <div className="alertbar err"><span className="ico" /><span>{err}</span></div> : null}
        {schoolRows.length === 0 ? (
          <div className="empty"><b>暂无可用账号</b><span>添加账号并解冻后，这里会显示每个账号的活动完成情况。</span></div>
        ) : (
          <div className="tbox"><table>
            <thead>
              <tr>
                <th>账号</th>
                {SCHOOL_SLOTS.map((sl) => <th key={sl.code} title={sl.tip}>{sl.label}</th>)}
                <th className="num-r">剩余抽奖</th>
              </tr>
            </thead>
            <tbody>
              {schoolRows.map((r: any, i: number) => {
                const name = String(pick(r, 'nickname', 'name') ?? pick(r, 'uid') ?? i)
                const tasks: any[] = Array.isArray(r.tasks) ? r.tasks : []
                const chances = pick(r, 'chances', 'lottery', 'draws')
                const rowErr = String(pick(r, 'error') ?? '')
                return (
                  <tr key={String(pick(r, 'uid') ?? i)}>
                    <td style={{ fontWeight: 600 }}>{name}
                      {/* 行级错误：某账号这一轮抓取失败时，原面板会在行内写出原因 */}
                      {rowErr && <div className="muted" style={{ fontSize: 11, color: 'var(--bad)', marginTop: 2 }} title={rowErr}>{rowErr.length > 40 ? rowErr.slice(0, 40) + '…' : rowErr}</div>}
                    </td>
                    {SCHOOL_SLOTS.map((sl) => {
                      const t = tasks.find((x) => String(x.task_code ?? '') === sl.code)
                      const c = sl.skip ? { sym: '—', txt: '不做', cls: 'skip' } : slotCell(t)
                      return (
                        <td key={sl.code} title={sl.tip}>
                          <span className={`slot ${c.cls}`}><span className="s">{c.sym}</span>{c.txt}</span>
                        </td>
                      )
                    })}
                    <td className="num-r tok">{chances ?? '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table></div>
        )}
      </div>

      <div className="sect" style={{ marginBottom: 0 }}>
        <div className="sect-head">
          <h3>成长任务队列</h3>
          <span className="sub">{qTotal > 0 ? `${qTotal} 项 · 已完成 ${qDone}${qRunning ? ` · 并发 ${pick(queue, 'conc') ?? conc}` : ''}` : '尚未扫描'}</span>
          <span className="sp" />
          <label className="muted" style={{ fontSize: 12 }}>并发
            <select value={conc} onChange={(e) => setConc(e.target.value)} style={{ minWidth: 0, marginLeft: 6 }}>
              <option>1</option><option>2</option><option>3</option>
            </select>
          </label>
          <button className="btn xs" onClick={() => void scanNow()}>扫描待办</button>
          <button className="btn xs pri" onClick={() => {
            if (confirm(`扫描全部账号待办并排队执行（账号并发 ${conc}，账号内串行）。含真实对话的任务耗时较长，确认继续？`)) void post('tasks/run_queue', { concurrency: Number(conc) }, '队列已启动')
          }}>执行全部待办</button>
        </div>
        {preview && preview.length > 0 && (
          <div style={{ marginBottom: 18 }}>
            <div className="sect-head" style={{ marginBottom: 6 }}>
              <h3>待办预览</h3>
              <span className="sub">扫描结果（含真实对话类任务，逐条执行见下方队列）</span>
              <span className="sp" />
              <button className="btn xs" onClick={() => setPreview(null)}>清除预览</button>
            </div>
            {preview.map((acc: any) => {
              const growth: any[] = acc.growth ?? []
              /* 待办预览要把开学季任务也算进来（原面板 scan_all 预览两类都列）；
                 学生认证是「需真实认证、不做」，永不出现在待办里。 */
              const schoolItems: any[] = (Array.isArray(acc.school) ? acc.school : [])
                .filter((t: any) => String(t.task_code ?? '') !== 'task_student_verify')
              const total = growth.length + schoolItems.length
              if (total === 0) return null
              return (
                <div key={String(acc.uid)}>
                  <div className="q-group">{String(acc.nickname ?? acc.uid)} · {total} 项待办</div>
                  {growth.map((g: any) => (
                    <div key={String(g.task_code)} className="q-row">
                      <span className="m muted">{String(g.task_code ?? '')}</span>
                      <span>{String(g.title ?? '')}{g.tag ? <span className="chip">{String(g.tag)}</span> : null}</span>
                      <span className="tok">{g.target ? `${g.current ?? 0}/${g.target}` : '—'}</span>
                      <span className="tok">{g.credit ? `+${g.credit} 分` : ''}{g.energy ? ` +${g.energy} 能` : ''}</span>
                      <span className="muted" style={{ fontSize: 12 }} title={String(g.description ?? '')}>{String(g.task_desc ?? '').slice(0, 60)}</span>
                    </div>
                  ))}
                  {schoolItems.map((s: any) => (
                    <div key={String(s.task_code)} className="q-row">
                      <span className="m muted">{String(s.task_code ?? '')}</span>
                      <span>开学季<span className="chip">活动</span></span>
                      <span className="tok">{Number(s.target_count ?? 0) > 0 ? `${Number(s.progress ?? 0)}/${Number(s.target_count)}` : '—'}</span>
                      <span className="tok">—</span>
                      <span className="muted" style={{ fontSize: 12 }}>{String(pick(s, 'title') ?? '')}</span>
                    </div>
                  ))}
                </div>
              )
            })}
          </div>
        )}
        {qTotal > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
            <div className="bar slim" style={{ maxWidth: 320 }}><i style={{ width: pct + '%' }} /></div>
            <span className="muted tok" style={{ fontSize: 12 }}>{qRunning ? '执行中' : '已结束'} {qDone} / {qTotal}</span>
          </div>
        )}
        {qItems.length === 0 ? (
          <div className="empty">
            <b>还没有扫描过</b>
            <span>扫描所有账号的成长任务与开学季待办，把没做的排成一列，一键执行。</span>
          </div>
        ) : (
          <div>
            <div className="q-head q4"><span>账号</span><span>任务</span><span>状态</span><span>消息</span></div>
            {qItems.map((it: any, i: number) => {
              // 队列项的真实字段只有 {uid,nickname,kind,code,status,message}。
              // 这里必须显式取值：本文件的 pick() 在找不到键时会返回整个对象，
              // 用它取 name/progress 会渲染出 "[object Object]"。
              const st = String(it?.status ?? 'queued')
              const kind = String(it?.kind ?? '')
              const code = String(it?.code ?? '')
              const nick = String(it?.nickname ?? it?.uid ?? '')
              const msg = String(it?.message ?? '')
              const sqBg: Record<string, string> = {
                done: 'var(--ok)', running: 'var(--accent)', error: 'var(--bad)', fail: 'var(--bad)',
                skipped: 'var(--off)', queued: 'transparent', pending: 'transparent',
              }
              const label: Record<string, string> = {
                done: '完成', running: '执行中', error: '失败', fail: '失败',
                skipped: '跳过', queued: '排队', pending: '待执行',
              }
              const border = st === 'queued' || st === 'pending' ? '1px solid var(--line)' : 'none'
              return (
                <div key={i} className="q-row q4">
                  <span className="muted" title={String(it?.uid ?? '')}>{nick}</span>
                  <span>
                    <span className="mono" style={{ fontSize: 12 }}>{code}</span>
                    <span className="chip">{kind === 'school' ? '开学季' : '成长任务'}</span>
                  </span>
                  <span>
                    <span className="sq" style={{ background: sqBg[st] ?? 'transparent', border }} />
                    {label[st] ?? st}
                  </span>
                  <span className="muted" style={{ fontSize: 12, whiteSpace: 'normal' }}>{msg || '—'}</span>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </>
  )
}

/* ================= cline 对话测试（真流式） ================= */
interface ChatMsg {
  role: 'user' | 'assistant'
  content: string
  reasoning?: string
  stats?: string
  stopped?: boolean
}

export function ChatPanel({ live }: { live: boolean }) {
  const api = useSvcApi('cline')
  const [models, setModels] = useState<string[]>([])
  const [model, setModel] = useState('')
  const [stream, setStream] = useState(true)
  const [msgs, setMsgs] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [sys, setSys] = useState('')
  const [temp, setTemp] = useState('')
  const [topp, setTopp] = useState('')
  const abortRef = useRef<AbortController | null>(null)
  const threadRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!live) return
    api('/v1/models/enabled').then((j) => {
      const list = pick<any[]>(j, 'models', 'enabled', 'data') ?? []
      const ids = list.map((m) => (typeof m === 'string' ? m : String(pick(m, 'id', 'model') ?? ''))).filter(Boolean)
      setModels(ids)
      if (ids[0]) setModel((m) => m || ids[0])
    }).catch(() => {})
  }, [live, api])
  useEffect(() => {
    if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight
  }, [msgs])

  async function send() {
    const text = input.trim()
    if (!text || busy) return
    if (!model) { toast('还没有启用模型，先到「模型」页添加', 'err'); return }
    setInput('')
    const history = msgs.filter((m) => !m.stopped).map((m) => ({ role: m.role, content: m.content }))
    setMsgs((xs) => [...xs, { role: 'user', content: text }])
    const aiMsg: ChatMsg = { role: 'assistant', content: '' }
    setMsgs((xs) => [...xs, aiMsg])
    setBusy(true)

    const body: Record<string, unknown> = {
      model,
      messages: [...history, { role: 'user', content: text }],
      stream,
    }
    if (sys.trim()) body.messages = [{ role: 'system', content: sys.trim() }, ...body.messages as any[]]
    if (temp.trim() && !Number.isNaN(Number(temp))) body.temperature = Number(temp)
    if (topp.trim() && !Number.isNaN(Number(topp))) body.top_p = Number(topp)

    const t0 = Date.now()
    let ttft = 0
    const ctrl = new AbortController()
    abortRef.current = ctrl
    const patch = (fn: (m: ChatMsg) => ChatMsg) => setMsgs((xs) => xs.map((m, i) => (i === xs.length - 1 ? fn(m) : m)))

    try {
      const r = await fetch('/api/svc/cline/v1/chat/completions', {
        method: 'POST', signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!r.ok) {
        const j = await r.json().catch(() => null)
        throw new Error((j && j.error && (j.error.message || j.error)) || 'HTTP ' + r.status)
      }
      if (!stream) {
        const j = await r.json()
        const choice = pick<any[]>(j, 'choices')?.[0]
        const usage = pick<any>(j, 'usage')
        /* choice.message 是对象：pick(choice,'message','content') 在 message 命中时
           会把整个对象交给 String()，正文就渲染成 [object Object]。要分两层取。 */
        const msg = pick<any>(choice, 'message')
        const text = typeof msg === 'string' ? msg : String(pick(msg, 'content') ?? pick(choice, 'content') ?? '')
        const rs = msg && typeof msg === 'object' ? String(pick(msg, 'reasoning', 'reasoning_content') ?? '') : ''
        const ms = Date.now() - t0
        patch((m) => ({ ...m, content: text, reasoning: rs || m.reasoning, stats: `完成 · 总耗时 ${ms}ms` }))
        setMetrics(usage, t0, ms, false, Number(pick(usage, 'completion_tokens') ?? 0) || undefined, text, String(pick(choice, 'finish_reason') ?? 'stop'))
        return
      }
      const reader = r.body!.getReader()
      const dec = new TextDecoder()
      let buf = ''
      let gen = ''
      let reasoning = ''
      let usage: any = null
      let finish = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const parts = buf.split('\n\n')
        buf = parts.pop() ?? ''
        for (const part of parts) {
          const line = part.split('\n').find((l) => l.startsWith('data: '))
          if (!line) continue
          const payload = line.slice(6)
          if (payload === '[DONE]') continue
          try {
            const chunk = JSON.parse(payload)
            const delta = chunk.choices?.[0]?.delta ?? {}
            /* worker 透出的字段名是 reasoning（不是 OpenAI 第三方的 reasoning_content）；
               只认后者会让「思考过程」整段不显示。两个都收。 */
            const rk = pick<string>(delta, 'reasoning', 'reasoning_content')
            if (typeof rk === 'string' && rk) {
              reasoning += rk
              if (!ttft) ttft = Date.now() - t0
              patch((m) => ({ ...m, reasoning, stats: '思考中…' }))
            }
            if (typeof delta.content === 'string' && delta.content) {
              gen += delta.content
              if (!ttft) ttft = Date.now() - t0
              patch((m) => ({ ...m, content: gen, stats: `生成中 · ${Date.now() - t0}ms` }))
            }
            if (chunk.usage) usage = chunk.usage
            const fr = chunk.choices?.[0]?.finish_reason
            if (fr) finish = fr
          } catch { /* 忽略不完整片段 */ }
        }
      }
      const ms = Date.now() - t0
      const outTok = Number(usage?.completion_tokens ?? Math.round(gen.length * 0.6))
      patch((m) => ({
        ...m,
        stats: `完成 · 首字节 ${ttft}ms / 总耗时 ${ms}ms · ${finish || 'stop'}${reasoning ? ` · 思考 ${reasoning.length} 字` : ''}`,
      }))
      setMetrics(usage, t0, ttft, true, outTok, gen, finish)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg !== 'AbortError') {
        patch((m) => ({ ...m, content: m.content || `请求异常：${msg}`, stats: '异常' }))
        toast('对话失败：' + msg, 'err')
      }
    } finally {
      setBusy(false)
      abortRef.current = null
    }
    function setMetrics(usage: any, t0: number, ttft: number, isStream: boolean, outTok?: number, gen?: string, finish?: string) {
      const ms = Date.now() - t0
      const g = ms - ttft
      const to = Number(usage?.completion_tokens ?? outTok ?? 0)
      const inTok = Number(usage?.prompt_tokens ?? 0)
      setMsgs((xs) => xs.map((m, i) => (i === xs.length - 1 ? {
        ...m,
        stats: [
          `finish=${finish || 'stop'}`,
          `${fmtInt(inTok)}→${fmtInt(to)} token`,
          `首字节 ${ttft}ms`,
          isStream ? `≈${(to / Math.max(0.001, g / 1000)).toFixed(1)} tok/s` : '',
          `总计 ${ms}ms`,
        ].filter(Boolean).join(' · '),
      } : m)))
      const setMetric = (label: string, val: string) => {
        const el = document.querySelector(`.chat-side [data-metric="${label}"]`)
        if (el) el.textContent = val
      }
      setMetric('首字节', isStream ? ttft + 'ms' : '—')
      setMetric('生成耗时', isStream ? (ms - ttft) + 'ms' : ms + 'ms')
      setMetric('总耗时', ms + 'ms')
      /* 非流式拿不到首字节，用「总耗时」当生成窗口算出的速度会虚高一个数量级
         （实测 14 token 报 14000 tok/s），这种数字比不显示更糟。 */
      setMetric('输出速度', isStream ? (to / Math.max(0.001, g / 1000)).toFixed(1) + ' tok/s' : '—')
      setMetric('输入 token', fmtInt(inTok))
      setMetric('输出 token', fmtInt(to))
      setMetric('结束原因', finish || 'stop')
    }
  }
  function stopGen() { abortRef.current?.abort() }

  if (!live) {
    return <div className="wrap"><div className="empty"><b>服务未运行</b><span>对话测试需要服务在线。</span></div></div>
  }
  return (
    <div className="chat-grid">
      <div className="sect" style={{ marginBottom: 0, display: 'flex', flexDirection: 'column' }}>
        <div className="sect-head">
          <h3>对话</h3><span className="sub">多轮对话自动带上下文</span><span className="sp" />
          <button className="btn xs" onClick={() => { copyText(msgs.map((m) => `## ${m.role === 'user' ? '用户' : '助手'}\n${m.content}`).join('\n\n')) }}>导出记录</button>
          <button className="btn xs" onClick={() => setMsgs([])}>清空</button>
        </div>
        <div ref={threadRef} className="chat-thread">
          {msgs.length === 0 ? (
            <div className="empty"><b>还没有消息。</b><span>在下面输入内容开始测试，多轮对话会自动带上上下文。</span></div>
          ) : msgs.map((m, i) => (
            <div key={i} className={`bub ${m.role === 'user' ? '' : 'ai'}`}>
              <span className="av">{m.role === 'user' ? '我' : 'AI'}</span>
              <div className="bd">
                {m.reasoning && <div className="think">思考过程 · {m.reasoning.length} 字</div>}
                <div className="txt">{m.content || (m.stopped ? '(已停止)' : '…')}</div>
                {m.stats && <div className="stats">{m.stats}</div>}
              </div>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'flex-start' }}>
          <textarea
            rows={2} style={{ flex: 1 }} value={input}
            placeholder="输入消息，Enter 发送 / Shift+Enter 换行"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() } }}
          />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {busy ? <button className="btn" onClick={stopGen}>停止生成</button> : <button className="btn pri" onClick={() => void send()}>发送</button>}
          </div>
        </div>
      </div>

      <div className="sect chat-side" style={{ marginBottom: 0 }}>
        <div className="sect-head"><h3>模型与参数</h3></div>
        <label className="muted" style={{ fontSize: 12, display: 'block', marginBottom: 6 }}>模型</label>
        <select value={model} onChange={(e) => setModel(e.target.value)} style={{ width: '100%' }}>
          {models.length === 0 && <option value="">还没有启用模型</option>}
          {models.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <label className="check" style={{ marginTop: 12 }}><input type="checkbox" checked={stream} onChange={(e) => setStream(e.target.checked)} /> 流式输出</label>
        <details style={{ marginTop: 14 }}>
          <summary className="muted" style={{ fontSize: 12.5, cursor: 'pointer' }}>生成参数（可选）</summary>
          <div style={{ marginTop: 10 }}>
            <label className="muted" style={{ fontSize: 12, display: 'block' }}>system prompt</label>
            <textarea rows={3} placeholder="留空则不发送" style={{ marginTop: 4 }} onChange={(e) => setSys(e.target.value)} />
            <label className="muted" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>temperature</label>
            <input type="text" placeholder="留空则不发送" style={{ width: '100%', marginTop: 4 }} onChange={(e) => setTemp(e.target.value)} />
            <label className="muted" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>top_p</label>
            <input type="text" placeholder="留空则不发送" style={{ width: '100%', marginTop: 4 }} onChange={(e) => setTopp(e.target.value)} />
            <p className="faint" style={{ fontSize: 11, margin: '8px 0 0' }}>max_tokens 会被服务端剥离（上游收到会报错），输出长度由模型决定。</p>
          </div>
        </details>
        <div className="sect-head" style={{ marginTop: 20 }}><h3>本次指标</h3></div>
        <div className="tbox"><table><tbody>
          {[['首字节', '—'], ['生成耗时', '—'], ['总耗时', '—'], ['输出速度', '—'], ['输入 token', '—'], ['输出 token', '—'], ['结束原因', '—']].map(([k, v]) => (
            <tr key={k}><td className="muted">{k}</td><td className="num-r m" data-metric={k}>{v}</td></tr>
          ))}
        </tbody></table></div>
      </div>
    </div>
  )
}

function copyText(t: string) {
  navigator.clipboard.writeText(t).then(() => toast('已复制', 'ok')).catch(() => toast('复制失败，请手动选择', 'err'))
}

/* ================= cline 三段式模型库 ================= */
export function LibraryPanel({ live }: { live: boolean }) {
  const api = useSvcApi('cline')
  const [enabled, setEnabled] = useState<any[]>([])
  const [groups, setGroups] = useState<any[]>([])
  const [cat, setCat] = useState<any[]>([])
  const [q, setQ] = useState('')
  const [check, setCheck] = useState<Record<string, string>>({})
  const [err, setErr] = useState('')

  const loadEnabled = useCallback(async () => {
    try {
      const j = await api('/v1/models/enabled')
      const list = pick<any[]>(j, 'models', 'enabled', 'data') ?? []
      setEnabled(list.map((m) => (typeof m === 'string' ? { id: m } : m)))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [api])
  const loadLibrary = useCallback(async () => {
    try {
      const j = await api('/v1/models/library')
      setGroups(pick<any[]>(j, 'groups') ?? [])
    } catch { /* 库接口失败不阻塞 */ }
  }, [api])
  useEffect(() => {
    if (!live) return
    void loadEnabled()
    void loadLibrary()
  }, [live, loadEnabled, loadLibrary])

  async function batchAdd(ids: string[]) {
    try {
      await api('/v1/models/batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) })
      toast(`已添加 ${ids.length} 个`, 'ok')
      void loadEnabled()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err')
    }
  }
  async function remove(id: string) {
    try {
      await api('/v1/models/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })
      toast('已移除', 'ok')
      void loadEnabled()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err')
    }
  }
  async function setDefault(id: string) {
    try {
      await api('/v1/models/default', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })
      toast('已设为默认', 'ok')
      void loadEnabled()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err')
    }
  }

  // 检测：问上游这个模型此刻是否真能用（原面板的「检测」）。异步任务，按 jobId 轮询。
  async function checkModel(id: string) {
    setCheck((c) => ({ ...c, [id]: '检测中…' }))
    try {
      const j = await api('/v1/models/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })
      const jobId = String(pick<any>(j, 'job')?.id ?? pick(j, 'id') ?? '')
      if (!jobId) throw new Error('没有拿到检测任务 id')
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 1500))
        const s = await api(`/v1/models/check?jobId=${encodeURIComponent(jobId)}`)
        const job = pick<any>(s, 'job') ?? {}
        const status = String(pick(job, 'status') ?? '')
        if (status === 'running') { setCheck((c) => ({ ...c, [id]: '检测中…' })); continue }
        const res = pick<any>(job, 'result') ?? {}
        const ok = pick(res, 'ok') === true
        const errText = typeof job.error === 'string' ? job.error : ''
        const text = String(pick(res, 'text') ?? errText ?? (ok ? '可用' : '不可用'))
        setCheck((c) => ({ ...c, [id]: (ok ? '✓ ' : '✗ ') + text }))
        return
      }
      setCheck((c) => ({ ...c, [id]: '检测超时，稍后重试' }))
    } catch (e) {
      setCheck((c) => ({ ...c, [id]: '检测失败：' + (e instanceof Error ? e.message : String(e)) }))
    }
  }

  if (!live) return <NotRunning />
  const enabledIds = enabled.map((m) => String(pick(m, 'id') ?? ''))
  const catRows = q
    ? cat.filter((m) => String(pick(m, 'id', 'name') ?? '').toLowerCase().includes(q.toLowerCase()))
    : cat
  return (
    <>
      <div className="sect" style={{ marginBottom: 14 }}>
        <div className="sect-head"><h3>可用模型分组</h3><span className="sub">来自 api.cline.bot · 服务端缓存 30 分钟</span><span className="sp" /><button className="btn xs" onClick={() => void loadLibrary()}>刷新数据</button></div>
        {groups.length === 0 ? <div className="loading">加载中…</div> : groups.map((g, gi) => {
          /* 服务端把展示名放在 meta.title（meta = {title,sub,color}），顶层没有 name/title。
             注意本文件的 pick 找不到键时**返回整个对象**，直接 pick(g,'name','title') 会把 group
             对象本身渲染成 [object Object]；必须逐层显式取值。 */
          const meta = (g && typeof g.meta === 'object' && g.meta) ? g.meta : {}
          const gnameRaw = (typeof g?.name === 'string' && g.name) || (typeof g?.title === 'string' && g.title) || (typeof meta.title === 'string' && meta.title) || ''
          const gname = gnameRaw || `分组 ${gi + 1}`
          const gsub = typeof meta.sub === 'string' ? meta.sub : ''
          const models: any[] = Array.isArray(g?.models) ? g.models : []
          const pend = models.filter((m: any) => !enabledIds.includes(String(pick(m, 'id') ?? '')))
          return (
            <div key={gi}>
              <div className="grp-h">
                <span className="gdot" />
                <b style={{ fontSize: 13 }}>{gname}</b>
                <span className="faint" style={{ fontSize: 11.5 }}>共 {models.length} 个 · {pend.length === 0 ? '已全部添加' : `待添加 ${pend.length}`}{gsub ? ` · ${gsub}` : ''}</span>
                <span className="sp" />
                <button className="btn xs pri" disabled={pend.length === 0} onClick={() => void batchAdd(pend.map((m) => String(pick(m, 'id') ?? '')))}>
                  {pend.length === 0 ? '已全部添加' : `全部添加 (${pend.length})`}
                </button>
              </div>
              {models.map((m) => {
                const mid = String(pick(m, 'id') ?? '')
                const added = enabledIds.includes(mid)
                return (
                  <div key={mid} className="librow">
                    <span className="mid">{mid}</span>
                    <span className="sp" />
                    <button className="btn xs" disabled={check[mid] === '检测中…'} onClick={() => void checkModel(mid)}>{check[mid] === '检测中…' ? '检测中…' : '检测'}</button>{' '}
                    <button className="btn xs" onClick={() => { copyText(mid) }}>⧉ 复制</button>{' '}
                    <button className="btn xs pri" disabled={added} onClick={() => void batchAdd([mid])}>{added ? '已添加' : '＋ 添加'}</button>
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>

      <div className="sect" style={{ marginBottom: 14 }}>
        <details onToggle={(e) => {
          if ((e.target as HTMLDetailsElement).open && cat.length === 0) {
            api('/v1/models/catalog').then((j) => {
              const flat = pick<any[]>(j, 'models', 'catalog') ?? []
              if (flat.length === 0) {
                const groups = pick<any[]>(j, 'groups', 'providers') ?? []
                for (const g of groups) for (const m of pick<any[]>(g, 'models') ?? []) flat.push(m)
              }
              setCat(flat)
            }).catch((e) => setErr(e instanceof Error ? e.message : String(e)))
          }
        }}>
          <summary style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10, padding: '12px 2px', borderTop: '1px solid var(--line)' }}>
            <b style={{ fontSize: 13 }}>全部模型</b><span className="faint" style={{ fontSize: 11.5 }}>展开后抓取上游（含付费档）</span>
          </summary>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', margin: '10px 0' }}>
            <input type="search" placeholder="搜索名称或 ID（如 gpt、qwen、flash）" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1, maxWidth: 340 }} />
            <span className="faint" style={{ fontSize: 11.5 }}>{q ? `匹配 ${catRows.length} 个` : `${cat.length} 个已载入`}</span>
          </div>
          <div className="tbox"><table><tbody>
            {catRows.slice(0, 40).map((m, i) => {
              const mid = String(pick(m, 'id') ?? i)
              return (
                <tr key={mid + i}>
                  <td className="m">{mid}</td>
                  <td className="num-r"><button className="btn xs" onClick={() => void batchAdd([mid])}>＋ 添加</button>{' '}<button className="btn xs" onClick={() => copyText(mid)}>⧉ 复制</button></td>
                </tr>
              )
            })}
          </tbody></table></div>
          {catRows.length > 40 && <p className="faint" style={{ fontSize: 11.5, marginTop: 6 }}>仅显示前 40 个，继续输入缩小范围。</p>}
        </details>
      </div>

      <div className="sect" style={{ marginBottom: 0 }}>
        <div className="sect-head"><h3>已启用模型</h3><span className="sub">共 {enabled.length} 个 · 只有这里的模型会出现在 /v1/models 里</span></div>
        {enabled.length === 0 ? (
          <div className="empty"><b>还没有模型</b><span>从上面任一分组添加后，/v1/models 就以你的选择为准。</span></div>
        ) : (
          <div className="tbox"><table><tbody>
            {enabled.map((m, i) => {
              const mid = String(pick(m, 'id') ?? '')
              const isDefault = Boolean(pick(m, 'is_default', 'default'))
              const desc = String(pick(m, 'description', 'desc') ?? '')
              return (
                <tr key={mid + i}>
                  <td className="m">
                    {mid}{isDefault ? <> <span className="st ok"><i />默认</span></> : null}
                    {desc && <div className="faint" style={{ fontSize: 11, fontFamily: 'inherit', marginTop: 3, maxWidth: 620 }}>{desc}</div>}
                    {check[mid] && <div style={{ fontSize: 11.5, marginTop: 3, color: check[mid].startsWith('✗') || check[mid].startsWith('检测失败') ? 'var(--bad)' : 'var(--muted)' }}>{check[mid]}</div>}
                  </td>
                  <td className="num-r" style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn xs" disabled={check[mid] === '检测中…'} onClick={() => void checkModel(mid)}>{check[mid] === '检测中…' ? '检测中…' : '检测'}</button>{' '}
                    {!isDefault && <button className="btn xs" onClick={() => void setDefault(mid)}>设为默认</button>}{' '}
                    <button className="btn xs" onClick={() => copyText(mid)}>⧉ 复制</button>{' '}
                    <button className="btn xs dgr" onClick={() => { if (confirm(`从 /v1/models 撤下 ${mid}？`)) void remove(mid) }}>移除</button>
                  </td>
                </tr>
              )
            })}
          </tbody></table></div>
        )}
      </div>
      {err && <div className="alertbar err"><span className="ico" /><span>{err}</span></div>}
    </>
  )
}

function NotRunning() {
  return (
    <div className="empty">
      <b>服务未运行</b>
      <span>在页头打开开关后即可查看。</span>
    </div>
  )
}

/* ================= 用量（workbuddy / qoder，各自面板统计 API 同族） ================= */

/* 用量（workbuddy / qoder 各有自己的面板统计 API，形状同族，取值一律防御式） */
export function SvcUsagePanel({ id, live }: { id: string; live: boolean }) {
  const api = useSvcApi(id)
  const [range, setRange] = useState<'today' | '7d' | '30d'>('30d')
  const [data, setData] = useState<any>(null)
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    try {
      setData(await api(`/panel/api/stats?range=${range}`))
      setErr('')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [api, range])
  useEffect(() => { if (live) void load() }, [live, load])

  if (!live) return <NotRunning />
  if (err && !data) return <div className="alertbar err"><span className="ico" /><span>{err}</span></div>
  if (!data) return <div className="loading">读取统计中…</div>
  if (data.enabled === false) {
    return (
      <div className="sect" style={{ marginBottom: 0 }}>
        <div className="empty"><b>该服务的用量统计没有开启</b><span>到「设置」页签把「按天用量统计」打开即可。</span></div>
      </div>
    )
  }

  const tot = (data.totals ?? {}) as any
  const since = (data.since_start ?? data.grand ?? {}) as any
  const ser: any[] = Array.isArray(data.series) ? data.series : []
  const hourly = data.unit === 'hour'
  const labels = ser.map((s) => {
    const k = String(pick(s, 'key', 'day') ?? '')
    return hourly ? `${k} 时` : k.length >= 5 ? k.slice(5) : k
  })
  const dayTok = (s: any) => {
    const t = pick<number>(s, 'total_tokens')
    if (t != null) return Number(t)
    return Number(pick(s, 'prompt_tokens') ?? 0) + Number(pick(s, 'completion_tokens') ?? 0)
  }
  const tokens = ser.map(dayTok)
  const reqs = ser.map((s) => Number(pick(s, 'requests') ?? 0))
  const fails = ser.map((s) => Number(pick(s, 'failed', 'failures') ?? 0))
  const peakIdx = tokens.reduce((best, v, i) => (v > tokens[best] ? i : best), 0)
  const peakVal = tokens[peakIdx] ?? 0

  const byModel: any[] = Array.isArray(data.by_model) ? data.by_model : (Array.isArray(tot.by_model) ? tot.by_model : [])
  const byAcct: any[] = Array.isArray(data.by_account) ? data.by_account : (Array.isArray(tot.by_account) ? tot.by_account : [])
  const rowTok = (r: any) => {
    const t = pick<number>(r, 'total_tokens', 'tokens')
    return t != null ? Number(t) : Number(pick(r, 'prompt_tokens') ?? 0) + Number(pick(r, 'completion_tokens') ?? 0)
  }

  const rangeTok = (() => {
    const t = pick<number>(tot, 'total_tokens')
    return t != null ? Number(t) : Number(pick(tot, 'prompt_tokens') ?? 0) + Number(pick(tot, 'completion_tokens') ?? 0)
  })()
  const reqN = Number(pick(tot, 'requests') ?? 0)
  const failN = Number(pick(tot, 'failed', 'failures') ?? 0)
  const rate = Number(pick(tot, 'success_rate') ?? 0)
  const srPct = rate > 0 ? (rate <= 1 ? rate * 100 : rate) : (reqN > 0 ? (1 - failN / reqN) * 100 : 0)
  const sinceTok = (() => {
    const t = pick<number>(since, 'total_tokens')
    return t != null ? Number(t) : Number(pick(since, 'prompt_tokens') ?? 0) + Number(pick(since, 'completion_tokens') ?? 0)
  })()
  const accent = '#1c1c1a'
  const sinceLabel = since.since ? `自 ${String(since.since).slice(5)} 起累计，不随统计保留窗口缩减` : '服务自身的全部累计（进程重启会清零）'
  /* 覆盖度：后端给 covered_days（有数据的天数）与 keep_days（保留窗口）。
     只说「保留 30 天」会让人把「只有 2 天有数据」误读成故障。 */
  const coveredDays = Number(pick<any>(data, 'covered_days') ?? NaN)
  /* pool_total 是「池历史总账」对象（不受保留窗口影响的口径），原面板拿它做脚注 */
  const poolTotalTok = (() => {
    const p = pick<any>(data, 'pool_total')
    if (p && typeof p === 'object') return Number(pick(p, 'total_tokens') ?? 0)
    return 0
  })()
  const poolTotalReqs = (() => {
    const p = pick<any>(data, 'pool_total')
    return p && typeof p === 'object' ? Number(pick(p, 'requests') ?? 0) : 0
  })()

  return (
    <>
      <div className="sect">
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 34, flexWrap: 'wrap', padding: '6px 0 14px', borderBottom: '1px solid var(--line)', marginBottom: 14 }}>
          <div>
            <div style={{ fontSize: 34, fontWeight: 700, letterSpacing: '-0.02em' }} className="tok">
              {fmtTok(sinceTok)} <span style={{ fontSize: 14, color: 'var(--muted)', fontWeight: 600 }}>tok</span>
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>累计用量</div>
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 30 }} className="tok">
            <div><div style={{ fontSize: 17, fontWeight: 650 }}>{fmtTok(Number(since.prompt_tokens ?? 0))}</div><div className="faint" style={{ fontSize: 10.5 }}>输入 TOKEN</div></div>
            <div><div style={{ fontSize: 17, fontWeight: 650 }}>{fmtTok(Number(since.completion_tokens ?? 0))}</div><div className="faint" style={{ fontSize: 10.5 }}>输出 TOKEN</div></div>
            <div><div style={{ fontSize: 17, fontWeight: 650 }}>{fmtNum(Number(since.requests ?? 0))}</div><div className="faint" style={{ fontSize: 10.5 }}>请求次数</div></div>
            {since.active_accounts != null && (
              <div><div style={{ fontSize: 17, fontWeight: 650 }}>{fmtNum(Number(since.active_accounts))}</div><div className="faint" style={{ fontSize: 10.5 }}>活跃账号</div></div>
            )}
          </div>
        </div>
        <p className="faint" style={{ fontSize: 11.5, margin: 0 }}>{sinceTok > 0 ? sinceLabel : '尚未统计到请求：网关首次转发后开始累积'}</p>
      </div>

      <div className="sect">
        <div className="sect-head">
          <div className="seg">
            {([['today', '今日'], ['7d', '近 7 天'], ['30d', '近 30 天']] as const).map(([v, l]) => (
              <button key={v} className={range === v ? 'on' : ''} onClick={() => setRange(v)}>{l}</button>
            ))}
          </div>
          <span className="sp" />
          <span className="sub">
            {data.first_day
              ? <>统计自 {String(data.first_day).slice(5)} 起 · 保留 {data.keep_days ?? 30} 天{coveredDays != null ? ` · 覆盖 ${coveredDays}/${data.keep_days ?? 30} 天` : ''}</>
              : <>保留窗口 {data.keep_days ?? 30} 天</>}
          </span>
        </div>
        <div className="stat6">
          <div className="kpi"><h3>区间 TOKEN</h3><div className="v">{fmtTok(rangeTok)}</div></div>
          <div className="kpi"><h3>输入 TOKEN</h3><div className="v">{fmtTok(Number(tot.prompt_tokens ?? 0))}</div></div>
          <div className="kpi"><h3>输出 TOKEN</h3><div className="v">{fmtTok(Number(tot.completion_tokens ?? 0))}</div></div>
          <div className="kpi"><h3>请求次数</h3><div className="v">{fmtNum(reqN)}</div></div>
          <div className="kpi">
            <h3>{failN > 0 ? `失败 · 成功率 ${srPct.toFixed(1)}%` : '失败'}</h3>
            <div className="v" style={failN > 0 ? { color: 'var(--bad)' } : undefined}>{fmtNum(failN)}</div>
          </div>
          <div className="kpi">
            <h3>平均速率</h3>
            <div className="v">{Number(tot.avg_tokens_per_sec ?? 0) > 0 ? `${Number(tot.avg_tokens_per_sec).toFixed(1)} tok/s` : '—'}</div>
          </div>
        </div>
      </div>

      <div className="sect">
        <div className="sect-head">
          <h3>消费节律</h3>
          <span className="sub">token 用量</span>
          <span className="sub" style={{ color: 'var(--faint)' }}>▉ 请求次数</span>
          <span className="sp" />
          <span className="sub">{hourly ? '按小时（CST）' : '按自然日（CST）'}{peakVal > 0 ? ` · 峰值 ${fmtTok(peakVal)} @ ${labels[peakIdx]}` : ''}</span>
        </div>
        {tokens.every((v) => !isFinite(v) || v === 0) ? (
          <div className="empty"><b>区间内还没有请求记录</b><span>网关首次转发后开始累积。</span></div>
        ) : (
          <AreaChart
            series={[{ name: id, color: accent, data: tokens }]}
            mode="area"
            labels={labels}
            reqData={reqs}
            height={220}
            onHover={(i) => `<b>${labels[i]}</b>${fmtTok(tokens[i])} tok · ${fmtNum(reqs[i])} 次${fails[i] > 0 ? ` · <span style="color:var(--bad)">失败 ${fails[i]}</span>` : ''}`}
          />
        )}
        {/* 池历史总账：与上面「区间」不同，这个口径不受统计保留窗口影响 */}
        {poolTotalTok > 0 && (
          <p className="ovnote faint">池历史总账：{fmtTok(poolTotalTok)} tok · {fmtNum(poolTotalReqs)} 次请求（自池启用起，不随保留窗口缩减）</p>
        )}
      </div>

      <div className="stats-duo">
        <div className="sect" style={{ marginBottom: 0 }}>
          <div className="sect-head"><h3>模型分布</h3><span className="sub">{byModel.length} 个模型</span></div>
          {byModel.length === 0 ? (
            <div className="empty"><b>区间内没有调用记录</b><span>产生请求后这里会按模型聚合。</span></div>
          ) : (
            <div className="tbox"><table>
              <thead><tr><th>模型</th><th className="num-r">TOKEN</th><th style={{ width: 120 }}>占比</th><th className="num-r">请求</th><th className="num-r">输入 / 输出</th></tr></thead>
              <tbody>
                {byModel.map((m: any, i: number) => {
                  const name = String(pick(m, 'model', 'name', 'id', 'key') ?? i)
                  const tk = rowTok(m)
                  const pct = Number(pick(m, 'pct', 'percent') ?? (rangeTok > 0 ? (tk / rangeTok) * 100 : 0))
                  return (
                    <tr key={name + i}>
                      <td className="m" style={{ fontWeight: 600 }}>{name}</td>
                      <td className="num-r">{fmtTok(tk)}</td>
                      <td><div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><span className="tok muted" style={{ fontSize: 12 }}>{pct.toFixed(1)}%</span><div className="bar"><i style={{ width: Math.min(100, pct) + '%' }} /></div></div></td>
                      <td className="num-r">{fmtNum(Number(pick(m, 'requests') ?? 0))}</td>
                      <td className="num-r muted">{fmtTok(Number(pick(m, 'prompt_tokens') ?? 0))} / {fmtTok(Number(pick(m, 'completion_tokens') ?? 0))}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table></div>
          )}
        </div>
        <div className="sect" style={{ marginBottom: 0 }}>
          <div className="sect-head"><h3>账号用量</h3><span className="sub">{byAcct.length} 个账号</span></div>
          {byAcct.length === 0 ? (
            <div className="empty"><b>区间内没有调用记录</b><span>产生请求后这里会按账号聚合。</span></div>
          ) : (
            <div className="tbox"><table>
              <thead><tr><th>账号</th><th className="num-r">TOKEN</th><th style={{ width: 110 }}>占比</th><th className="num-r">请求</th><th className="num-r">失败</th></tr></thead>
              <tbody>
                {byAcct.map((a: any, i: number) => {
                  /* 后端 by_account[] 的展示名在 label（workbuddy 实测是手机号），
                     nickname/name 都不存在 —— 漏了 label 就只会显示 uid。 */
                  const name = String(pick(a, 'label', 'nickname', 'name', 'uid', 'key') ?? i)
                  const tk = rowTok(a)
                  const pct = Number(pick(a, 'pct', 'percent') ?? (rangeTok > 0 ? (tk / rangeTok) * 100 : 0))
                  const bad = Number(pick(a, 'failed', 'failures', 'fail_count') ?? 0)
                  return (
                    <tr key={name + i}>
                      <td style={{ fontWeight: 600 }}>{name}</td>
                      <td className="num-r">{fmtTok(tk)}</td>
                      <td><div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><span className="tok muted" style={{ fontSize: 12 }}>{pct.toFixed(1)}%</span><div className="bar"><i style={{ width: Math.min(100, pct) + '%' }} /></div></div></td>
                      <td className="num-r">{fmtNum(Number(pick(a, 'requests') ?? 0))}</td>
                      <td className="num-r" style={{ color: bad > 0 ? 'var(--bad)' : 'var(--faint)' }}>{fmtNum(bad)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table></div>
          )}
        </div>
      </div>
    </>
  )
}

/* cline 用量：服务端只给「每账号累计」，按天趋势取自面板聚合库（口径：累计快照差分） */
export function ClineUsagePanel({ live }: { live: boolean }) {
  const api = useSvcApi('cline')
  const [st, setSt] = useState<any>(null)
  const [agg, setAgg] = useState<any>(null)
  const [health, setHealth] = useState<any>(null)
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    try {
      const [s, a, h] = await Promise.all([
        api('/v1/status'),
        fetch('/api/stats?days=30').then((r) => r.json()),
        /* /v1/health 的 usage 块是服务自己维护的**上游视角**用量：
           客户端请求数、重试放大倍数、平均每次、按模型/按账号，全在这里。
           /v1/status 只有账号级累计，取不到这些。 */
        api('/v1/health').catch(() => null),
      ])
      setSt(s)
      setAgg(a)
      setHealth(h)
      setErr('')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [api])
  useEffect(() => { if (live) void load() }, [live, load])

  if (!live) return <NotRunning />
  if (err && !st) return <div className="alertbar err"><span className="ico" /><span>{err}</span></div>
  if (!st) return <div className="loading">读取用量中…</div>

  const accs: any[] = Array.isArray(pick(st, 'account_details')) ? pick<any[]>(st, 'account_details')! : []
  const sum = (k: string) => accs.reduce((a, x) => a + Number(pick(pick(x, 'usage') ?? {}, k) ?? 0), 0)
  const inTok = sum('input'), outTok = sum('output'), calls = sum('calls')
  const reasonTok = sum('reasoning')

  /* /v1/health.usage —— 上游调用口径 */
  const hu = pick<any>(health, 'usage') ?? {}
  const hTot = pick<any>(hu, 'total') ?? {}
  const clientReqs = Number(pick(hu, 'client_requests') ?? 0)
  const retryAmp = Number(pick(hu, 'retry_amplification') ?? 0)
  const avgPerCall = Number(pick(hu, 'avg_per_call') ?? 0)
  const missingRate = Number(pick(hu, 'missing_rate') ?? 0)
  const byModel: any[] = pick<any[]>(hu, 'by_model') ?? []
  const hTotalTok = Number(pick(hTot, 'total') ?? 0)

  const days: any[] = Array.isArray(agg?.days) ? agg.days : []
  const series = days.map((d) => {
    const e = pick<any>(d, 'services')?.['cline']
    return e ? Number(e.input ?? 0) + Number(e.output ?? 0) : 0
  })
  const labels = days.map((d) => String(d.date).slice(5))
  const reqs = days.map((d) => Number(pick<any>(d, 'services')?.['cline'] ?? {}).valueOf() ? Number((pick<any>(d, 'services')?.['cline'] as any).reqs ?? 0) : 0)
  const hasAgg = series.some((v) => v > 0)

  return (
    <>
      <div className="sect">
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 34, flexWrap: 'wrap', padding: '6px 0 14px', borderBottom: '1px solid var(--line)', marginBottom: 14 }}>
          <div>
            <div style={{ fontSize: 34, fontWeight: 700, letterSpacing: '-0.02em' }} className="tok">
              {fmtTok(inTok + outTok)} <span style={{ fontSize: 14, color: 'var(--muted)', fontWeight: 600 }}>tok</span>
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>全部账号累计（服务自身口径）</div>
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 30 }} className="tok">
            <div><div style={{ fontSize: 17, fontWeight: 650 }}>{fmtTok(inTok)}</div><div className="faint" style={{ fontSize: 10.5 }}>输入 TOKEN</div></div>
            <div><div style={{ fontSize: 17, fontWeight: 650 }}>{fmtTok(outTok)}</div><div className="faint" style={{ fontSize: 10.5 }}>输出 TOKEN</div></div>
            {reasonTok > 0 && <div><div style={{ fontSize: 17, fontWeight: 650 }}>{fmtTok(reasonTok)}</div><div className="faint" style={{ fontSize: 10.5 }}>其中思考</div></div>}
            <div><div style={{ fontSize: 17, fontWeight: 650 }}>{fmtNum(calls)}</div><div className="faint" style={{ fontSize: 10.5 }}>上游调用</div></div>
            <div><div style={{ fontSize: 17, fontWeight: 650 }}>{fmtNum(accs.length)}</div><div className="faint" style={{ fontSize: 10.5 }}>账号</div></div>
          </div>
        </div>
        <p className="faint" style={{ fontSize: 11.5, margin: 0 }}>累计值由服务进程维护，重启会清零；按天趋势见下（来自面板聚合库）</p>
        {/* 思考占比：原控制台用一个 meter 表示思考 token 占总量的比例 */}
        {reasonTok > 0 && (
          <div style={{ marginTop: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, marginBottom: 4 }}>
              <span className="muted">思考 token 占比</span>
              <span className="tok">{Math.round((reasonTok / Math.max(1, inTok + outTok)) * 100)}%</span>
            </div>
            <div className="bar slim"><i style={{ width: Math.min(100, Math.round((reasonTok / Math.max(1, inTok + outTok)) * 100)) + '%' }} /></div>
          </div>
        )}
      </div>

      {/* 上游调用口径：原控制台「用量总览」的重试放大 / 客户端请求 / 平均每次 / 无用量回报 */}
      {health && (
        <div className="sect">
          <div className="sect-head">
            <h3>上游调用口径</h3>
            <span className="sub">来自 /v1/health · 与上面的账号累计是两个视角</span>
          </div>
          <div className="stat6">
            <div className="kpi"><h3>客户端请求</h3><div className="v">{fmtNum(clientReqs)}</div>
              <div className="d">面板收到的请求数</div></div>
            <div className="kpi"><h3>上游调用</h3><div className="v">{fmtNum(Number(pick(hTot, 'calls') ?? 0))}</div>
              <div className="d">实际打到上游的次数</div></div>
            <div className="kpi"><h3>重试放大</h3><div className="v">{retryAmp.toFixed(2)}×</div>
              <div className="d">{retryAmp > 1.2 ? '多数请求需要重试' : '接近 1 = 基本一次成功'}</div></div>
            <div className="kpi"><h3>平均每次</h3><div className="v">{fmtNum(avgPerCall)}</div>
              <div className="d">token / 上游调用</div></div>
            <div className="kpi"><h3>无用量回报</h3><div className="v">{(missingRate * 100).toFixed(1)}%</div>
              <div className="d">上游没返回 usage 的比例</div></div>
            <div className="kpi"><h3>上游合计</h3><div className="v">{fmtTok(hTotalTok)}</div>
              <div className="d">含思考 token</div></div>
          </div>
          {byModel.length > 0 && (
            <>
              <p style={{ fontSize: 12, fontWeight: 650, margin: '16px 0 6px' }}>按模型</p>
              <div className="tbox"><table className="tight">
                <thead><tr><th>模型</th><th className="num-r">输入</th><th className="num-r">输出</th><th className="num-r">思考</th><th className="num-r">合计</th><th className="num-r">调用</th></tr></thead>
                <tbody>
                  {byModel.map((m: any, i: number) => (
                    <tr key={i}>
                      <td className="m" style={{ fontSize: 11.5 }}>{String(pick(m, 'name') ?? '—')}</td>
                      <td className="num-r">{fmtTok(Number(pick(m, 'input') ?? 0))}</td>
                      <td className="num-r">{fmtTok(Number(pick(m, 'output') ?? 0))}</td>
                      <td className="num-r">{fmtTok(Number(pick(m, 'reasoning') ?? 0))}</td>
                      <td className="num-r">{fmtTok(Number(pick(m, 'total') ?? 0))}</td>
                      <td className="num-r">{fmtNum(Number(pick(m, 'calls') ?? 0))}</td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            </>
          )}
        </div>
      )}

      <div className="sect">
        <div className="sect-head">
          <h3>按天用量</h3>
          <span className="sub">面板聚合库 · 近 30 天</span>
          <span className="sp" />
          <a className="enterlink" href="/?page=stats">去「统计」页看跨服务对比 →</a>
        </div>
        {hasAgg ? (
          <AreaChart
            series={[{ name: 'cline', color: '#1c1c1a', data: series }]}
            mode="area"
            labels={labels}
            reqData={reqs}
            height={220}
            onHover={(i) => `<b>${labels[i]}</b>${fmtTok(series[i])} tok · ${fmtNum(reqs[i])} 次`}
          />
        ) : (
          <div className="empty"><b>面板还没有收录到 cline 的按天数据</b><span>口径是「累计快照差分」：面板每 5 分钟记一次累计值，两次之间产生用量才会记到当天。</span></div>
        )}
        <p className="ovnote faint">口径说明：cline 只暴露每账号累计用量（不暴露按天），面板按日首尾差分推导；进程重启清零期间无法回补。</p>
      </div>

      <div className="sect" style={{ marginBottom: 0 }}>
        <div className="sect-head"><h3>按账号累计</h3><span className="sub">{accs.length} 个账号</span></div>
        <div className="tbox"><table>
          <thead><tr><th>账号</th><th>状态</th><th className="num-r">输入</th><th className="num-r">输出</th><th className="num-r">合计</th><th className="num-r">上游调用</th><th className="num-r">成功 / 失败</th><th>冷却模型</th></tr></thead>
          <tbody>
            {accs.map((a: any, i: number) => {
              const u = pick<any>(a, 'usage') ?? {}
              const s = pick<any>(a, 'stats') ?? {}
              const cd = pick<any[]>(a, 'cooldown_models') ?? []
              const bad = Number(pick(s, 'fail') ?? 0)
              return (
                <tr key={i}>
                  <td style={{ fontWeight: 600 }}>{String(pick(a, 'email', 'id') ?? '—')}</td>
                  <td>{pick(a, 'enabled') === false ? <span className="chip mute">已停用</span> : <span className="chip">可用</span>}</td>
                  <td className="num-r">{fmtTok(Number(pick(u, 'input') ?? 0))}</td>
                  <td className="num-r">{fmtTok(Number(pick(u, 'output') ?? 0))}</td>
                  <td className="num-r">{fmtTok(Number(pick(u, 'total') ?? 0))}</td>
                  <td className="num-r">{fmtNum(Number(pick(u, 'calls') ?? 0))}</td>
                  <td className="num-r">{fmtNum(Number(pick(s, 'ok') ?? 0))} / <span style={{ color: bad > 0 ? 'var(--bad)' : 'var(--faint)' }}>{fmtNum(bad)}</span></td>
                  <td className="m" style={{ fontSize: 11.5, color: cd.length ? 'var(--warn)' : 'var(--faint)' }}>{cd.length ? cd.join('、') : '—'}</td>
                </tr>
              )
            })}
            {accs.length === 0 && <tr><td colSpan={8} className="faint">还没有账号。</td></tr>}
          </tbody>
        </table></div>
      </div>
    </>
  )
}

/* cline「渠道」：按模型钉住上游渠道（对应原面板的「上游渠道」页签） */
export function UpstreamsPanel({ live }: { live: boolean }) {
  const api = useSvcApi('cline')
  const [items, setItems] = useState<any[]>([])
  const [models, setModels] = useState<string[]>([])
  const [draft, setDraft] = useState<Record<string, any>>({})
  const [probe, setProbe] = useState<Record<string, string>>({})
  const [addId, setAddId] = useState('')
  const [err, setErr] = useState('')

  const toDraft = (it: any) => ({
    upstreams: (pick<string[]>(it, 'upstreams') ?? []).join(', '),
    exclude: (pick<string[]>(it, 'exclude') ?? []).join(', '),
    pinMode: String(pick(it, 'pinMode') ?? 'strict'),
    redirect: String(pick(it, 'redirect') ?? ''),
    aliases: (pick<string[]>(it, 'aliases') ?? []).join(', '),
  })

  const load = useCallback(async () => {
    try {
      const j = await api('/v1/upstreams?action=list')
      const list = pick<any[]>(j, 'upstreams') ?? []
      setItems(list)
      setModels(pick<string[]>(j, 'models') ?? [])
      setDraft(Object.fromEntries(list.map((it) => [String(it.model_id), toDraft(it)])))
      setErr('')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [api])
  useEffect(() => { if (live) void load() }, [live, load])

  const splitList = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean)

  async function save(modelId: string) {
    const d = draft[modelId] ?? {}
    try {
      await api('/v1/upstreams?action=save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model_id: modelId,
          config: {
            upstreams: splitList(d.upstreams ?? ''),
            exclude: splitList(d.exclude ?? ''),
            pinMode: d.pinMode ?? 'strict',
            redirect: d.redirect ?? '',
            aliases: splitList(d.aliases ?? ''),
          },
        }),
      })
      toast('渠道配置已保存', 'ok')
      void load()
    } catch (e) {
      toast('保存失败：' + (e instanceof Error ? e.message : String(e)), 'err')
    }
  }

  async function del(modelId: string) {
    try {
      await api('/v1/upstreams?action=delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model_id: modelId }),
      })
      toast('已删除该模型的渠道配置', 'ok')
      void load()
    } catch (e) {
      toast('删除失败：' + (e instanceof Error ? e.message : String(e)), 'err')
    }
  }

  async function probeModel(modelId: string) {
    setProbe((p) => ({ ...p, [modelId]: '探测中…' }))
    try {
      const j = await api('/v1/upstreams?action=probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model_id: modelId }),
      })
      const job = pick<any>(j, 'job') ?? {}
      const jobId = String(job.id ?? pick(j, 'id') ?? '')
      if (!jobId) throw new Error('没有拿到探测任务 id')
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 1500))
        const s = await api(`/v1/upstreams?action=probe_status&jobId=${encodeURIComponent(jobId)}`)
        const job = pick<any>(s, 'job') ?? {}
        const status = String(pick(job, 'status') ?? '')
        if (status === 'running') { setProbe((p) => ({ ...p, [modelId]: '探测中…' })); continue }
        const res = pick<any>(job, 'result') ?? {}
        // 探测结果只给管道/渠道等元数据（没有 text 字段），按它的形状拼
        const pipeline = String(pick(res, 'pipeline') ?? '')
        const provider = String(pick(res, 'provider') ?? '')
        const avail = pick<string[]>(res, 'available') ?? []
        const ms = Number(pick(res, 'latencyMs') ?? 0)
        const note = String(pick(res, 'note') ?? '')
        const errText = typeof job.error === 'string' ? job.error : ''
        // providerMatch 默认就是 false，只有真的钉了渠道时才有意义
        const cur = items.find((x) => String(x.model_id) === modelId)
        const hasPins = (pick<string[]>(cur ?? {}, 'upstreams') ?? []).length > 0
        const matchHint = hasPins && pick(res, 'providerMatch') === false ? '（钉住未生效）' : ''
        const text = pipeline
          ? `管道 ${pipeline} · 实际渠道 ${provider || '未知'}${matchHint} · 可用渠道 ${avail.length} 个${ms > 0 ? ` · ${(ms / 1000).toFixed(1)}s` : ''}${note ? ` · ${note}` : ''}`
          : (note || errText || '探测未得出结论，稍后重试')
        setProbe((p) => ({ ...p, [modelId]: text }))
        void load()
        return
      }
      setProbe((p) => ({ ...p, [modelId]: '探测超时，稍后重试' }))
    } catch (e) {
      setProbe((p) => ({ ...p, [modelId]: '探测失败：' + (e instanceof Error ? e.message : String(e)) }))
    }
  }

  if (!live) return <NotRunning />

  return (
    <>
      <div className="sect">
        <div className="sect-head">
          <h3>按模型钉住上游渠道</h3>
          <span className="sub">留空 = 自动路由。只有探测过才知道这个模型实际走哪条管道</span>
          <span className="sp" />
          <button className="btn xs" onClick={() => void load()}>刷新</button>
        </div>
        <div className="opsbar">
          <select value={addId} onChange={(e) => setAddId(e.target.value)} style={{ maxWidth: 360 }}>
            <option value="">选择一个已启用模型…</option>
            {models.filter((m) => !items.some((it) => String(it.model_id) === m)).map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <button
            className="btn pri"
            disabled={!addId}
            onClick={() => {
              setItems((xs) => [...xs, { model_id: addId }])
              setDraft((d) => ({ ...d, [addId]: { upstreams: '', exclude: '', pinMode: 'strict', redirect: '', aliases: '' } }))
              setAddId('')
            }}
          >＋ 添加配置</button>
          <span className="faint" style={{ fontSize: 11.5 }}>可配 {models.length} 个已启用模型</span>
        </div>
      </div>

      {err && <div className="alertbar err"><span className="ico" /><span>{err}</span></div>}

      {items.length === 0 && !err && (
        <div className="sect" style={{ marginBottom: 0 }}>
          <div className="empty"><b>还没有钉住任何渠道</b><span>所有模型都在自动路由（按上游实际返回选择）。需要固定走某个渠道时才在上面添加。</span></div>
        </div>
      )}

      {items.map((it) => {
        const mid = String(it.model_id)
        const d = draft[mid] ?? toDraft(it)
        const set = (k: string, v: string) => setDraft((x) => ({ ...x, [mid]: { ...d, [k]: v } }))
        const available = pick<string[]>(it, 'available') ?? []
        const pipeline = String(pick(it, 'pipeline') ?? '')
        const last = String(pick(it, 'lastProvider') ?? '')
        const probedAt = Number(pick(it, 'probedAt') ?? 0)
        return (
          <div className="sect" key={mid}>
            <div className="sect-head">
              <b className="m" style={{ fontSize: 13.5 }}>{mid}</b>
              <span className="sp" />
              <button className="btn xs" onClick={() => void probeModel(mid)}>探测</button>
              <button className="btn xs dgr" onClick={() => void del(mid)}>删除配置</button>
              <button className="btn xs pri" onClick={() => void save(mid)}>保存</button>
            </div>
            <p className="muted" style={{ fontSize: 11.5, margin: '0 0 12px' }}>
              管道：{pipeline || '未探测'} · 实际渠道：{last || '未探测'}
              {available.length > 0 && <> · 可用渠道：{available.slice(0, 4).join('、')}{available.length > 4 ? ` 等 ${available.length} 个` : ''}</>}
              {probedAt > 0 && <> · 探测于 {new Date(probedAt).toLocaleString()}</>}
            </p>
            {probe[mid] && <div className="alertbar" style={{ marginBottom: 12 }}><span className="ico" /><span>{probe[mid]}</span></div>}
            <div className="cfggrid">
              <div className="cfgitem">
                <span className="lb">钉住的渠道</span>
                <input value={d.upstreams} onChange={(e) => set('upstreams', e.target.value)} placeholder="逗号分隔；留空 = 不钉" />
                <span className="hint">填渠道 slug（探测结果里的名字）</span>
              </div>
              <div className="cfgitem">
                <span className="lb">排除的渠道</span>
                <input value={d.exclude} onChange={(e) => set('exclude', e.target.value)} placeholder="逗号分隔；留空 = 不排除" />
              </div>
              <div className="cfgitem">
                <span className="lb">钉住模式</span>
                <select value={d.pinMode} onChange={(e) => set('pinMode', e.target.value)}>
                  <option value="strict">strict — 只走钉住的渠道</option>
                  <option value="preferred">preferred — 优先走，失败再换</option>
                </select>
              </div>
              <div className="cfgitem">
                <span className="lb">重定向到</span>
                <input value={d.redirect} onChange={(e) => set('redirect', e.target.value)} placeholder="留空 = 不重定向" />
                <span className="hint">把该模型的请求指到另一个模型 ID</span>
              </div>
              <div className="cfgitem">
                <span className="lb">别名</span>
                <input value={d.aliases} onChange={(e) => set('aliases', e.target.value)} placeholder="逗号分隔；这些名字会走本模型" />
              </div>
            </div>
          </div>
        )
      })}
    </>
  )
}
