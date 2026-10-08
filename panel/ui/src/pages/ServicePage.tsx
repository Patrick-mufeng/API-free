/* 服务详情页：信息头（真状态/开关/重启）+ 页签。
   账号池页签 M2 已接各服务真 API（走 /api/svc/{id} 代理）；
   模型/用量/日志/设置按里程碑逐页迁入。 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Badge, PageHead, Segmented, Switch, Veil, toast } from '../components/ui'
import { ctlService, fetchServices, type SvcSnapshot } from '../api'
import { svcColor } from '../data/services'
import { fmtTok } from '../data/format'
import { ServiceGlyph } from '../components/ServiceIcons'

/* M4：任务中心 / 对话测试 / 模型库 */
import { TasksPanel, ChatPanel, LibraryPanel, SvcUsagePanel, ClineUsagePanel, UpstreamsPanel } from './ServiceExtras'
/* 接入信息（地址/密钥/模型/调用代码） */
import { ServiceAccess } from './ServiceAccess'

type TabId = 'acct' | 'tasks' | 'library' | 'chat' | 'models' | 'upstreams' | 'usage' | 'logs' | 'access' | 'conf'

const TABS_FOR: Record<string, [TabId, string][]> = {
  workbuddy: [['acct', '账号'], ['tasks', '任务中心'], ['models', '模型'], ['usage', '用量'], ['logs', '日志'], ['access', '接入'], ['conf', '设置']],
  cline: [['acct', '账号'], ['library', '模型库'], ['chat', '对话测试'], ['models', '模型'], ['upstreams', '渠道'], ['usage', '用量'], ['logs', '日志'], ['access', '接入'], ['conf', '设置']],
  qoder: [['acct', '账号'], ['models', '模型'], ['usage', '用量'], ['logs', '日志'], ['access', '接入'], ['conf', '设置']],
  cmdgo: [['acct', '账号'], ['models', '模型'], ['usage', '用量'], ['logs', '日志'], ['access', '接入'], ['conf', '设置']],
  /* zen 没有账号池也没有积分：不摆一个永远空着的「账号」页签，
     首屏直接是模型表。第一项不再是 acct，所以初始页签按服务自己的列表取。 */
  zen: [['models', '模型'], ['usage', '用量'], ['logs', '日志'], ['access', '接入'], ['conf', '设置']],
}

function tabsFor(id: string): [TabId, string][] {
  return TABS_FOR[id] ?? TABS_FOR.qoder
}

export function ServicePage({ id }: { id: string }) {
  const [snap, setSnap] = useState<SvcSnapshot | null>(null)
  /* 初始页签取本服务自己的第一项：四个老服务的首项都是 acct，行为不变；
     zen 的首项是 models（它没有账号页签）。 */
  const [tab, setTab] = useState<TabId>(() => tabsFor(id)[0][0])
  const [confirmStop, setConfirmStop] = useState(false)
  const [meta, setMeta] = useState<any>(null)

  useEffect(() => { setTab(tabsFor(id)[0][0]) }, [id])

  useEffect(() => {
    let alive = true
    async function poll() {
      try {
        const list = await fetchServices()
        const s = list.find((x) => x.id === id)
        if (alive && s) setSnap(s)
      } catch { /* 后端未起 */ }
    }
    poll()
    const t = setInterval(poll, 2500)
    return () => { alive = false; clearInterval(t) }
  }, [id])

  /* 服务自身的版本与运行时长（原面板侧栏有「v1.0.0 · 运行 3h」）。
     workbuddy/qoder/zen 的 overview 提供这两个字段，cline/cmdgo 没有这个口径。 */
  const api = useSvcApi(id)
  useEffect(() => {
    if (id !== 'workbuddy' && id !== 'qoder' && id !== 'zen') { setMeta(null); return }
    let alive = true
    const load = () => api('/panel/api/overview')
      .then((j) => { if (alive) setMeta(j) })
      .catch(() => { if (alive) setMeta(null) })
    void load()
    const t = setInterval(load, 15000)
    return () => { alive = false; clearInterval(t) }
  }, [api, id])

  async function restart() {
    try {
      await ctlService(id, 'restart')
      toast('重启指令已下发', 'ok')
    } catch (e) {
      toast('重启失败：' + (e instanceof Error ? e.message : e), 'err')
    }
  }
  async function stop() {
    setConfirmStop(false)
    try {
      await ctlService(id, 'stop')
      toast('已停止')
    } catch (e) {
      toast('停止失败：' + (e instanceof Error ? e.message : e), 'err')
    }
  }

  if (!snap) {
    return (
      <div className="wrap">
        <div className="loading">加载服务状态中…</div>
      </div>
    )
  }
  const running = snap.status === 'running'
  const originalPanel = `/api/svc/${id}/${id === 'qoder' || id === 'workbuddy' ? 'panel/' : ''}`

  return (
    <div className="wrap">
      <div className="pagehead">
        <span className="svc-ava">
          <ServiceGlyph id={id} size={26} />
        </span>
        <div>
          <h1 style={{ margin: 0, fontSize: 19, fontWeight: 700 }}>{snap.name}</h1>
          <div className="sub">
            端口 {snap.port} · 常驻进程 · 累计自动重启 {snap.restarts} 次{snap.lastError ? ` · ${snap.lastError}` : ''}
            {meta && pick(meta, 'version') ? ` · v${String(pick(meta, 'version'))}` : ''}
            {meta && uptimeText(Number(pick(meta, 'uptime_sec', 'uptime_s') ?? 0)) ? ` · 已运行 ${uptimeText(Number(pick(meta, 'uptime_sec', 'uptime_s') ?? 0))}` : ''}
            {meta && pick(meta, 'redis_mode') ? ` · Redis ${String(pick(meta, 'redis_mode'))}` : ''}
          </div>
        </div>
        <Badge kind={running ? 'run' : snap.status === 'starting' ? 'boot' : 'stop'}>
          {running ? '运行中' : snap.status === 'starting' ? '启动中…' : '已停止'}
        </Badge>
        <span className="sp" />
        <div className="acts">
          <a className="enterlink" href={originalPanel} target="_blank" rel="noreferrer">打开原面板 ↗</a>
          <button className="btn" onClick={() => void restart()}>重启</button>
          <Switch
            checked={running}
            disabled={snap.status === 'starting'}
            onChange={() => {
              if (running) setConfirmStop(true)
              else void ctlService(id, 'start').then(() => toast('启动指令已下发', 'ok')).catch((e) => toast(String(e.message ?? e), 'err'))
            }}
            label={`${snap.name} 开关`}
          />
        </div>
      </div>
      {confirmStop && (
        <div className="alertbar err" role="alert">
          <span className="ico" />
          <span>停止后该服务将不可用，进行中的请求会失败。</span>
          <span style={{ flex: 1 }} />
          <button className="btn ghost xs" onClick={() => setConfirmStop(false)}>取消</button>
          <button className="btn dgr xs" onClick={() => void stop()}>确认停止</button>
        </div>
      )}

      <div className="tabs">
        {tabsFor(id).map(([v, label]) => (
          <button key={v} className={tab === v ? 'on' : ''} onClick={() => setTab(v)}>{label}</button>
        ))}
      </div>

      {tab === 'acct' && <AccountPanel id={id} live={running} />}
      {tab === 'tasks' && <TasksPanel live={running} />}
      {tab === 'library' && <LibraryPanel live={running} />}
      {tab === 'chat' && <ChatPanel live={running} />}
      {tab === 'models' && <ModelsPanel id={id} live={running} />}
      {tab === 'upstreams' && <UpstreamsPanel live={running} />}
      {tab === 'usage' && (id === 'cline' ? <ClineUsagePanel live={running} /> : id === 'cmdgo' ? <UsagePanel id={id} live={running} /> : <SvcUsagePanel id={id} live={running} />)}
      {tab === 'logs' && <LogsPanel id={id} live={running} />}
      {tab === 'access' && <ServiceAccess id={id} />}
      {tab === 'conf' && <SettingsPanel id={id} live={running} onGoAccess={() => setTab('access')} />}
    </div>
  )
}

/* ================= 账号池（按服务分实现） ================= */

function cAny(arr: any[], f: (a: any) => boolean): number {
  return arr.filter(f).length
}
function sumK(arr: any[], a: string, b: string, c?: string): string {
  const cur = arr.reduce((x, i) => x + (Number(pick(i, a) ?? 0) || 0), 0)
  const max = arr.reduce((x, i) => x + (Number(pick(i, b, c ?? b) ?? 0) || 0), 0)
  if (cur === 0 && max === 0) return '—'
  return `${fmtNum(cur)} / ${fmtNum(max)}`
}
function fmtInt(n: unknown): string {
  return Number(n || 0).toLocaleString('en-US')
}
function pick<T = any>(o: any, ...ks: string[]): T | undefined {
  for (const k of ks) if (o && o[k] != null) return o[k]
  return undefined
}

/** 经面板代理调用服务 API */
function useSvcApi(id: string) {
  return useCallback(async (path: string, opts?: RequestInit) => {
    const r = await fetch('/api/svc/' + id + path, opts)
    const j = await r.json().catch(() => null)
    if (!r.ok) throw new Error((j && j.error) || 'HTTP ' + r.status)
    if (j && j.error) throw new Error(j.error)
    return j
  }, [id])
}

function AccountPanel({ id, live }: { id: string; live: boolean }) {
  if (id === 'workbuddy') return <WorkbuddyAccounts live={live} />
  if (id === 'qoder') return <QoderAccounts live={live} />
  if (id === 'cline') return <ClineAccounts live={live} />
  if (id === 'cmdgo') return <CmdgoAccounts live={live} />
  return null
}

function NotRunning() {
  return (
    <div className="empty">
      <b>服务未运行</b>
      <span>在页头打开开关后即可看到账号池。</span>
    </div>
  )
}

/* ---------- WorkBuddy ---------- */
function WorkbuddyAccounts({ live }: { live: boolean }) {
  const api = useSvcApi('workbuddy')
  const [accts, setAccts] = useState<any[]>([])
  const [ov, setOv] = useState<any>(null)
  const [err, setErr] = useState('')
  const [taskUid, setTaskUid] = useState<string | null>(null)
  const load = useCallback(async () => {
    try {
      const j = await api('/panel/api/overview')
      setOv(j)
      setAccts(pick<any[]>(j, 'accounts', 'Accounts') ?? [])
      setErr('')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [api])
  /* 原面板是 5s 轮询：额度/在途/最近成功这些读数不刷新就会长期停在旧值。
     qoder/cmdgo 各自都有轮询，workbuddy 之前唯独只在挂载时拉一次。 */
  useEffect(() => {
    if (!live) return
    void load()
    const t = setInterval(() => void load(), 5000)
    return () => clearInterval(t)
  }, [live, load])

  async function act(uid: string, action: string, okMsg: string) {
    try {
      await api(`/panel/api/accounts/${uid}/${action}`, { method: 'POST' })
      toast(okMsg, 'ok')
      void load()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err')
    }
  }
  /* 批量动作是「下发即返回」（后端在 goroutine 里跑），结果要过后看日志；
     但余额刷新是同步的，且原面板刷完就重载列表——所以这里也 load()。 */
  async function batch(path: string, msg: string) {
    try {
      await api('/panel/api/' + path, { method: 'POST' })
      toast(msg, 'ok')
      void load()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err')
    }
  }

  if (!live) return <NotRunning />
  return (
    <>
      <div className="stat6">
        <div className="kpi"><h3>账号总数</h3><div className="v">{String(pick(ov, 'total') ?? accts.length)}</div></div>
        <div className="kpi"><h3>可用</h3><div className="v" style={{ color: 'var(--ok)' }}>{String(pick(ov, 'healthy') ?? cAny(accts, (a) => !a.disabled && !a.cooling && !a.cool_kind && a.coolKind == null))}</div></div>
        <div className="kpi"><h3>冷却中</h3><div className="v" style={{ color: 'var(--warn)' }}>{String(pick(ov, 'cooling') ?? cAny(accts, (a) => a.cooling || a.cool_kind || a.coolKind))}</div></div>
        <div className="kpi"><h3>已禁用</h3><div className="v" style={{ color: 'var(--bad)' }}>{String(pick(ov, 'disabled') ?? cAny(accts, (a) => a.disabled))}</div></div>
        <div className="kpi"><h3>积分剩余 / 总额</h3><div className="v" style={{ fontSize: 19 }}>{sumK(accts, 'credits', 'credits_max', 'credits_total')}</div></div>
        <div className="kpi"><h3>粘性会话</h3><div className="v">{String(pick(ov, 'sticky_sessions') ?? '—')}</div></div>
      </div>
      <div className="sect" style={{ padding: 14, marginBottom: 14 }}>
        <div className="opsbar">
          <span className="lbl">批量操作</span>
          <button className="btn xs" onClick={() => void batch('checkin_all', '全部签到已开始，结果见日志')}>全部签到</button>
          <button className="btn xs" onClick={() => void batch('travel_all', '旅行巡检已开始（含领养链路），结果见日志')}>旅行巡检</button>
          <button className="btn xs" onClick={() => void batch('activity_all', '活跃上报已开始，结果见日志')}>活跃上报</button>
          <button className="btn xs" onClick={() => void batch('keepalive_all', '全部保活已开始，结果见日志')}>全部保活</button>
          <span style={{ flex: 1 }} />
          <button className="btn xs" onClick={() => void batch('balance_all', '余额已从上游刷新')}>刷新余额</button>
          <AddAccount service="workbuddy" onDone={() => void load()} />
        </div>
      </div>
      {err ? <div className="alertbar err"><span className="ico" /><span>{err}</span></div> : null}
      <div className="sect" style={{ marginBottom: 0 }}>
        {accts.length === 0 ? (
          <div className="empty"><b>账号池是空的</b><span>点击右上角「添加账号」，用浏览器登录一个 WorkBuddy 账号</span></div>
        ) : (
          <div className="tbox"><table>
            <thead><tr>
              <th style={{ width: 6 }}></th><th>账号</th><th style={{ width: 150 }}>状态</th><th style={{ width: 140 }}>积分</th>
              <th style={{ width: 90 }}>成功 / 失败</th><th style={{ width: 60 }}>在途</th><th style={{ width: 110 }}>用量</th><th style={{ width: 100 }}>最近成功</th><th style={{ width: 210 }}></th>
            </tr></thead>
            <tbody>
              {accts.map((a, i) => {
                const uid = String(pick(a, 'uid', 'id', 'key') ?? i)
                const name = String(pick(a, 'nickname', 'name') ?? uid)
                const disabled = a.disabled === true || a.enabled === false
                /* 冷却三件套按原面板口径（app.js 的 render 段）：
                   cool_remaining_sec 与 breaker_until 取大者，谁大就报谁的类型，
                   再带上上游给的 reason 注记——只显示「冷却中」丢掉了「为什么、还要多久」。 */
                const untilTs = parseTs(a.until)
                const breakerTs = parseTs(a.breaker_until)
                const coolSec = Number(pick(a, 'cool_remaining_sec') ?? 0)
                const untilSec = untilTs != null && untilTs > Date.now() ? Math.round((untilTs - Date.now()) / 1000) : 0
                const breakerSec = breakerTs != null && breakerTs > Date.now() ? Math.round((breakerTs - Date.now()) / 1000) : 0
                const coolLeft = Math.max(coolSec, untilSec, breakerSec)
                const cooling = a.cooling === true || coolLeft > 0
                const isBreaker = breakerSec > coolSec && breakerSec > untilSec
                const coolKind = String(pick(a, 'cool_kind') ?? '')
                const reason = String(pick(a, 'reason') ?? '')
                const credits = pick<number>(a, 'credits')
                const creditsMax = pick<number>(a, 'credits_max', 'credits_total')
                const ok = pick<number>(a, 'success_count', 'success') ?? 0
                const bad = pick<number>(a, 'err_total', 'fail_count', 'failures') ?? 0
                const inflight = pick(a, 'in_flight', 'inflight') ?? 0
                const last = pick(a, 'last_success', 'last_success_at')
                const pct = credits != null && creditsMax ? Math.max(2, Math.min(100, Math.round(credits / creditsMax * 100))) : null
                const rowCls = disabled ? 'off-row' : cooling ? 'cool-row' : ''
                const coolLabel = isBreaker ? '熔断' : coolKind === 'hard_credit' ? '积分冷却' : '限流冷却'
                const statusTxt = disabled ? '已禁用' : cooling ? `${coolLabel} · ${durText(coolLeft)}` : '可用'
                const statusKind = disabled ? 'dis' : isBreaker ? 'bad' : cooling ? 'rate' : 'ok'
                return (
                  <tr key={uid} className={rowCls}>
                    <td><span className="mark" style={disabled ? { background: 'var(--bad)' } : cooling ? { background: 'var(--warn)' } : {}} /></td>
                    <td><b style={{ fontSize: 13 }}>{name}</b>{pick(a, 'realm') === 'global' ? <> <span className="chip">国际版</span></> : null}<div className="faint mono" style={{ fontSize: 11 }}>{uid.slice(0, 16)}…</div></td>
                    <td><span className={`st ${statusKind}`}><i />{statusTxt}</span>
                      {reason && <div className="muted" style={{ fontSize: 11, marginTop: 3 }} title={reason}>{reason.length > 40 ? reason.slice(0, 40) + '…' : reason}</div>}
                    </td>
                    <td>{credits != null ? (
                      <><span className="tok" style={{ fontSize: 12.5 }}>{fmtNum(credits)}</span>{creditsMax ? <span className="faint"> / {fmtNum(creditsMax)}</span> : null}
                        {pct != null && <div className="bar slim" style={{ maxWidth: 92, marginTop: 4 }}><i style={{ width: pct + '%' }} /></div>}
                      </>
                    ) : '—'}</td>
                    <td>{ok} / <span style={{ color: bad ? 'var(--bad)' : 'inherit' }}>{bad}</span></td>
                    <td>{String(inflight)}</td>
                    <td>
                      {(() => {
                        const tu = pick<any>(a, 'token_usage') ?? {}
                        const tk = Number(pick(tu, 'total_tokens') ?? 0)
                        const reqn = Number(pick(tu, 'request_count', 'usage_count') ?? 0)
                        if (tk <= 0) return <span className="faint">—</span>
                        const mdl = String(pick(tu, 'last_model') ?? '')
                        const lat = Number(pick(tu, 'last_latency_ms') ?? 0)
                        /* 原面板这格是「次数 / token / 延迟 / 速率」四读数；速率是独立字段 */
                        const rate = Number(pick(tu, 'last_tokens_per_second') ?? 0)
                        const tip = `最近一次：${fmtNum(reqn)} 次 / ${fmtTok(tk)} tok / 延迟 ${lat > 0 ? lat + 'ms' : '—'} / ${rate > 0 ? rate.toFixed(1) + ' tok/s' : '—'}${mdl ? ` · 模型 ${mdl}` : ''}`
                        return (
                          <span title={tip}>
                            <b className="tok" style={{ fontSize: 12.5 }}>{fmtTok(tk)}</b>
                            <span className="faint"> tok</span>
                            {rate > 0 && <div className="faint" style={{ fontSize: 10.5, marginTop: 2 }}>{rate.toFixed(1)} tok/s</div>}
                          </span>
                        )
                      })()}
                    </td>
                    <td className="muted">{relTime(last)}</td>
                    <td className="num-r" style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn xs" onClick={() => void act(uid, 'checkin', '签到完成')}>签到</button>{' '}
                      <button className="btn xs" onClick={() => void act(uid, 'balance', '余额已更新')}>余额</button>{' '}
                      <button className="btn xs" onClick={() => setTaskUid(uid)}>任务</button>{' '}
                      {disabled
                        ? <button className="btn xs pri" onClick={() => void act(uid, 'revive', '已解冻')}>解冻</button>
                        : <button className="btn xs" onClick={() => void act(uid, 'disable', '已禁用')}>禁用</button>}{' '}
                      <button className="btn xs dgr" onClick={() => { if (confirm('移除账号将删除池状态与凭证文件，不可恢复。确认移除？')) void act(uid, 'remove', '已移除') }}>移除</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table></div>
        )}
      </div>
      {taskUid && <WorkbuddyTaskModal uid={taskUid} onClose={() => setTaskUid(null)} />}
    </>
  )
}

/* ---------- Qoder ---------- */
function QoderAccounts({ live }: { live: boolean }) {
  const api = useSvcApi('qoder')
  const [accts, setAccts] = useState<any[]>([])
  const [ov, setOv] = useState<any>(null)
  const [err, setErr] = useState('')
  const [quota, setQuota] = useState<{ id: string; name: string; data: any } | null>(null)
  const load = useCallback(async () => {
    try {
      const j = await api('/panel/api/overview')
      setOv(j)
      setAccts(pick<any[]>(j, 'accounts') ?? [])
      setErr('')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [api])
  useEffect(() => {
    if (!live) return
    void load()
    const t = setInterval(() => void load(), 5000)
    return () => clearInterval(t)
  }, [live, load])

  async function act(id2: string, action: string, okMsg: string) {
    try {
      await api(`/panel/api/accounts/${id2}/${action}`, { method: 'POST' })
      toast(okMsg, 'ok')
      void load()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err')
    }
  }
  /* 强制刷新必须带账号 id（不是名字）——state 里两个都存着。 */
  async function loadQuota(id2: string, name: string, refresh = false) {
    try {
      const j = await api(`/panel/api/accounts/${id2}/quota${refresh ? '?refresh=1' : ''}`)
      setQuota({ id: id2, name, data: pick(j, 'quota') ?? j })
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err')
    }
  }

  /* 存量账号重新授权：login/start 返回的 authUrl 必须显示出来（原面板的弹层就是这么做的），
     否则点了「登录」只有一句 toast、用户拿不到授权链接。 */
  const [login, setLogin] = useState<{ name: string; url: string; msg: string; done: boolean } | null>(null)
  async function startLogin(id2: string, name: string) {
    try {
      const j = await api(`/panel/api/accounts/${id2}/login/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      const url = String(pick(j, 'authUrl', 'url', 'verification_url') ?? '')
      if (!url) throw new Error(String(pick(j, 'message') ?? '未返回授权链接'))
      setLogin({ name, url, msg: '', done: false })
      const t = window.setInterval(async () => {
        try {
          const st = await api(`/panel/api/accounts/${id2}/login/poll`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
          if (pick(st, 'status') === 'ok' || pick(st, 'done') === true) {
            window.clearInterval(t)
            setLogin((cur) => (cur ? { ...cur, done: true, msg: '登录成功，worker 将自动就绪。' } : cur))
            void load()
          } else if (pick(st, 'message')) {
            setLogin((cur) => (cur ? { ...cur, msg: String(pick(st, 'message')) } : cur))
          }
        } catch { /* 轮询失败继续 */ }
      }, 3000)
    } catch (e) {
      toast('发起登录失败：' + (e instanceof Error ? e.message : String(e)), 'err')
    }
  }
  /* 额度弹窗：qoder 后端原样返回上游 /admin/quota 的三桶结构
     {userQuota,addOnQuota,orgResourcePackage,isQuotaExceeded}，每桶 {total,used,remaining,percentage,unit,available}。
     剩余 = 可用桶之和（与原面板 quotaBlocks 同一算法）。 */
  const QUOTA_BUCKETS: [string, string][] = [['userQuota', '基础额度'], ['addOnQuota', '加量包'], ['orgResourcePackage', '组织包']]
  const quotaAgg = useMemo(() => {
    const d = quota?.data
    if (!d) return null
    let total = 0
    let remaining = 0
    let any = false
    for (const [k] of QUOTA_BUCKETS) {
      const b = d[k]
      if (!b || b.available === false) continue
      total += Number(b.total) || 0
      remaining += Number(b.remaining) || 0
      any = true
    }
    return { total, remaining, pct: total > 0 ? Math.round((remaining / total) * 100) : 0, ok: any }
  }, [quota])

  if (!live) return <NotRunning />
  return (
    <>
      <div className="stat6">
        <div className="kpi"><h3>账号总数</h3><div className="v">{String(pick(ov, 'total') ?? accts.length)}</div></div>
        <div className="kpi"><h3>可用</h3><div className="v" style={{ color: 'var(--ok)' }}>{String(pick(ov, 'healthy') ?? cAny(accts, (a) => a.enabled !== false && !a.cool_kind && a.ready))}</div></div>
        <div className="kpi"><h3>冷却中</h3><div className="v" style={{ color: 'var(--warn)' }}>{String(pick(ov, 'cooling') ?? cAny(accts, (a) => a.cool_kind))}</div></div>
        <div className="kpi"><h3>已禁用</h3><div className="v" style={{ color: 'var(--bad)' }}>{String(pick(ov, 'disabled') ?? cAny(accts, (a) => a.enabled === false))}</div></div>
        <div className="kpi"><h3>积分剩余 / 总额</h3><div className="v" style={{ fontSize: 19 }}>{sumK(accts, 'credits', 'credits_total')}</div></div>
        <div className="kpi"><h3>粘性会话</h3><div className="v">{String(pick(ov, 'sticky_count') ?? '—')}</div></div>
      </div>
      <div className="sect" style={{ padding: 14, marginBottom: 14 }}><div className="opsbar" style={{ justifyContent: 'flex-end' }}>
        <AddAccount service="qoder" onDone={() => void load()} />
      </div></div>
      {err ? <div className="alertbar err"><span className="ico" /><span>{err}</span></div> : null}
      <div className="sect" style={{ marginBottom: 0 }}>
        {accts.length === 0 ? (
          <div className="empty"><b>账号池是空的</b><span>点右上角「添加账号」，用 Qoder 账号完成设备授权。</span></div>
        ) : (
          <div className="tbox"><table>
            <thead><tr>
              <th style={{ width: 6 }}></th><th>账号</th><th style={{ width: 130 }}>状态</th><th style={{ width: 180 }}>额度</th>
              <th style={{ width: 90 }}>成功 / 失败</th><th style={{ width: 60 }}>在途</th><th style={{ width: 100 }}>最近成功</th><th style={{ width: 220 }}></th>
            </tr></thead>
            <tbody>
              {accts.map((a, i) => {
                const id2 = String(pick(a, 'id', 'key') ?? i)
                const name = String(pick(a, 'name') ?? id2)
                const region = String(pick(a, 'region') ?? '').toUpperCase().startsWith('CN') ? 'CN' : 'GL'
                const enabled = pick(a, 'enabled') !== false
                const coolKind = String(pick(a, 'cool_kind') ?? '')
                const ready = Boolean(pick(a, 'ready'))
                const stTxt = !enabled ? '已禁用' : coolKind === 'quota' ? '额度冷却' : coolKind === 'soft' ? '限流冷却' : coolKind === 'breaker' ? '熔断' : ready ? '就绪' : '启动中'
                const stKind = !enabled ? 'dis' : coolKind === 'quota' || coolKind === 'breaker' ? 'bad' : coolKind === 'soft' ? 'rate' : ready ? 'ok' : 'boot'
                const credits = pick<number>(a, 'credits')
                const creditsTotal = pick<number>(a, 'credits_total')
                const okN = pick<number>(a, 'success_count') ?? 0
                const badN = pick<number>(a, 'err_total') ?? 0
                const infl = pick(a, 'in_flight') ?? 0
                const maxInf = pick(a, 'max_inflight') ?? 4
                const last = pick(a, 'last_success')
                const uid = String(pick(a, 'uid') ?? '')
                const lastErr = String(pick(a, 'last_err') ?? '')
                const authType = String(pick(a, 'auth_type') ?? '')
                return (
                  <tr key={id2} className={!enabled ? 'off-row' : coolKind ? 'cool-row' : ''}>
                    <td><span className="mark" style={!enabled ? { background: 'var(--bad)' } : coolKind ? { background: 'var(--warn)' } : {}} /></td>
                    <td><b style={{ fontSize: 13 }}>{name}</b> <span className="chip">{region}</span>
                      <div className="muted mono" style={{ fontSize: 10.5, marginTop: 2 }} title={id2}>{id2.length > 22 ? id2.slice(0, 22) + '…' : id2}</div>
                      {lastErr ? <div style={{ fontSize: 11, color: 'var(--bad)', marginTop: 3 }} title={lastErr}>{lastErr.slice(0, 72)}</div> : null}
                    </td>
                    <td><span className={`st ${stKind}`}><i />{stTxt}</span>
                      {uid ? <div className="muted mono" style={{ fontSize: 10.5, marginTop: 3 }} title={uid}>{uid.length > 18 ? uid.slice(0, 18) + '…' : uid}</div> : null}
                    </td>
                    <td>{credits != null ? (
                      <><span className="tok" style={{ fontSize: 12.5 }}>{fmtNum(credits)}</span><span className="faint"> / {fmtNum(creditsTotal)}</span>
                        <div className="bar slim" style={{ maxWidth: 150, marginTop: 4 }}><i style={{ width: creditsTotal ? Math.max(2, credits / creditsTotal * 100) + '%' : '0%' }} /></div>
                      </>
                    ) : '—'}</td>
                    <td>{okN} / <span style={{ color: badN ? 'var(--bad)' : 'inherit' }}>{badN}</span></td>
                    <td>{String(infl)}/{String(maxInf)}</td>
                    <td className="muted">{relTime(last)}</td>
                    <td className="num-r" style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn xs" onClick={() => void loadQuota(id2, name)}>额度</button>{' '}
                      {region === 'CN' && enabled && <button className="btn xs" onClick={() => void act(id2, 'checkin', '签到完成')}>签到</button>}{' '}
                      {authType === 'oauth'
                        ? <button className="btn xs" onClick={() => void act(id2, 'rewarm', '已请求重建上下文')}>重建</button>
                        : <button className="btn xs pri" onClick={() => void startLogin(id2, name)}>登录</button>}{' '}
                      {enabled
                        ? <button className="btn xs" onClick={() => void act(id2, 'disable', '已禁用')}>禁用</button>
                        : <button className="btn xs" onClick={() => void act(id2, 'enable', '已启用')}>启用</button>}{' '}
                      <button className="btn xs dgr" onClick={() => { if (confirm(`删除账号「${name}」？（仅移除注册信息，凭证目录 data/homes 保留）`)) void act(id2, 'delete', '已删除') }}>删除</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table></div>
        )}
      </div>

      {login && (
        <Veil onClose={() => setLogin(null)} width="min(520px, calc(100vw - 40px))">
            <h3>登录 <span className="muted" style={{ fontSize: 12.5, fontWeight: 500 }}>· {login.name}</span></h3>
            <p className="sub">浏览器完成 Qoder 设备授权；本页每 3 秒自动检测结果，成功后 worker 自动就绪。</p>
            {login.done ? (
              <div style={{ textAlign: 'center', padding: '6px 0' }}>
                <div className="okbig">✓</div>
                <p style={{ fontSize: 13.5, fontWeight: 600, margin: 0 }}>{login.msg || '登录成功。'}</p>
              </div>
            ) : (
              <>
                <div className="linkbox">{login.url}</div>
                <div className="acts center">
                  <a className="btn pri" href={login.url} target="_blank" rel="noreferrer">打开授权页 ↗</a>
                  <button className="btn" onClick={() => { navigator.clipboard.writeText(login.url).then(() => toast('链接已复制', 'ok')) }}>复制链接</button>
                </div>
                {login.msg && <p className="muted" style={{ fontSize: 12.5, textAlign: 'center' }}>{login.msg}</p>}
              </>
            )}
            <div className="acts"><button className="btn pri" onClick={() => setLogin(null)}>关闭</button></div>
        </Veil>
      )}

      {quota && (
        <Veil onClose={() => setQuota(null)} width="min(480px, calc(100vw - 40px))">
            <h3>额度 <span className="muted" style={{ fontSize: 12.5, fontWeight: 500 }}>· {quota.name}</span></h3>
            <p className="sub">来自 worker 实时查询；剩余 = 可用桶之和（基础 + 加量包 + 组织包）。</p>
            {quotaAgg?.ok ? (
              <div className="tbox"><table><tbody>
                <tr><td style={{ width: 110 }}><b>剩余 / 总额</b></td>
                    <td><span className="tok">{fmtNum(quotaAgg.remaining)} / {fmtNum(quotaAgg.total)}</span>
                        <span className="faint">（{quotaAgg.pct}%）</span>
                        <div className="bar slim" style={{ marginTop: 4 }}><i style={{ width: quotaAgg.pct + '%' }} /></div></td></tr>
                {QUOTA_BUCKETS.map(([k, label]) => {
                  const b = quota.data?.[k]
                  if (!b) return null
                  const t = Number(b.total) || 0
                  const r = Number(b.remaining) || 0
                  const pct = t > 0 ? Math.round((r / t) * 100) : 0
                  return (
                    <tr key={k}><td className="muted">{label}{b.available === false ? '（不可用）' : ''}</td>
                        <td className="tok">{fmtNum(r)} / {fmtNum(t)} <span className="faint">{String(b.unit ?? '')}</span>
                            <div className="bar slim" style={{ marginTop: 4 }}><i style={{ width: pct + '%' }} /></div></td></tr>
                  )
                })}
              </tbody></table></div>
            ) : (
              <div className="empty"><b>上游没有返回额度数据</b><span>账号刚重建上下文时可能取不到，点「强制刷新」重试。</span></div>
            )}
            {quota.data?.isQuotaExceeded && <p style={{ color: 'var(--bad)', fontSize: 12.5, marginTop: 8 }}>上游标记额度已用尽</p>}
            <div className="acts">
              <button className="btn" onClick={() => void loadQuota(quota.id, quota.name, true)}>强制刷新</button>
              <button className="btn pri" onClick={() => setQuota(null)}>关闭</button>
            </div>
        </Veil>
      )}
    </>
  )
}

/* ---------- Cline ---------- */
function ClineAccounts({ live }: { live: boolean }) {
  const api = useSvcApi('cline')
  const [accts, setAccts] = useState<any[]>([])
  const [err, setErr] = useState('')
  const [detailId, setDetailId] = useState<string | null>(null)
  const load = useCallback(async () => {
    try {
      const j = await api('/v1/status')
      setAccts(pick<any[]>(j, 'accounts', 'account_details', 'runtime_accounts') ?? [])
      setErr('')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [api])
  useEffect(() => { if (live) void load() }, [live, load])

  async function act(id2: string, action: string, okMsg: string) {
    try {
      await api('/v1/accounts/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, id: id2 }) })
      toast(okMsg, 'ok')
      void load()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err')
    }
  }

  if (!live) return <NotRunning />
  /* 原面板账号页顶部有「可用 / 冷却中 / 已停用 / 总数」四格汇总，统一前端此前只有按钮。 */
  const nDisabled = accts.filter((a) => Boolean(pick(a, 'disabled')) || pick(a, 'enabled') === false).length
  const nCooling = accts.filter((a) => (pick<any[]>(a, 'cooldown_models') ?? []).length > 0).length
  const nAvail = accts.length - nDisabled - nCooling
  return (
    <>
      <div className="stat6" style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}>
        <div className="kpi"><h3>可用</h3><div className="v" style={{ color: 'var(--ok)' }}>{nAvail}</div></div>
        <div className="kpi"><h3>冷却中</h3><div className="v" style={{ color: nCooling ? 'var(--warn)' : undefined }}>{nCooling}</div></div>
        <div className="kpi"><h3>已停用</h3><div className="v" style={{ color: nDisabled ? 'var(--bad)' : undefined }}>{nDisabled}</div></div>
        <div className="kpi"><h3>总数</h3><div className="v">{accts.length}</div></div>
      </div>
      <div className="sect" style={{ padding: 14, marginBottom: 14 }}><div className="opsbar" style={{ justifyContent: 'flex-end' }}>
        <button className="btn xs" onClick={() => { void api('/v1/accounts/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'resetAll' }) }).then(() => toast('已重置全部冷却', 'ok')).catch((e) => toast(String(e.message ?? e), 'err')) }}>重置全部冷却</button>
        <button className="btn xs" onClick={() => { void api('/v1/accounts/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'enableAll' }) }).then(() => toast('已全部启用', 'ok')).catch((e) => toast(String(e.message ?? e), 'err')) }}>全部启用</button>
        <AddAccount service="cline" onDone={() => void load()} />
      </div></div>
      {err ? <div className="alertbar err"><span className="ico" /><span>{err}</span></div> : null}
      <div className="sect" style={{ marginBottom: 0 }}>
        {accts.length === 0 ? (
          <div className="empty"><b>还没有账号</b><span>点「登录新账号」完成 WorkOS 设备授权，或把 refreshToken 填进环境变量。</span></div>
        ) : (
          <div className="tbox"><table>
            <thead><tr>
              <th>账号</th><th style={{ width: 130 }}>来源</th><th style={{ width: 110 }}>状态</th><th>冷却</th>
              <th style={{ width: 90 }}>成功 / 失败</th><th style={{ width: 96 }}>最后使用</th><th style={{ width: 230 }}></th>
            </tr></thead>
            <tbody>
              {accts.map((a, i) => {
                const id2 = String(pick(a, 'id') ?? i)
                const mail = String(pick(a, 'email') ?? `账号 #${i + 1}`)
                /* worker /v1/status 给的是 runtime: true=运行时账号（可存盘/可移除），
                   false=来自 CLINE_REFRESH_TOKEN 环境变量（移除必然 400，原面板也隐藏该按钮）。 */
                const fromEnv = pick(a, 'runtime') === false
                const disabled = Boolean(pick(a, 'disabled')) || pick(a, 'enabled') === false
                const coolModels = pick<any[]>(a, 'cooldown_models') ?? []
                const cooling = Number(pick(a, 'coolingCount', 'cooling') ?? coolModels.length)
                const coolTxt = disabled ? '—' : cooling > 0 ? `${cooling} 个模型冷却中` : '无'
                const stats = pick<any>(a, 'stats') ?? {}
                const okN = pick<number>(a, 'successCount', 'success') ?? Number(pick(stats, 'ok') ?? 0)
                const badN = pick<number>(a, 'failCount', 'failures') ?? Number(pick(stats, 'fail') ?? 0)
                const last = pick(a, 'lastUsedAt', 'last_used') ?? pick(stats, 'last_used_at')
                const st = disabled ? ['dis', '已停用'] : cooling > 0 ? ['rate', '冷却中'] : ['ok', '可用']
                const cached = pick(a, 'token_cached', 'tokenCached') === true
                return (
                  <tr key={id2} className={disabled ? 'off-row' : cooling > 0 ? 'cool-row' : ''}>
                    <td><b style={{ fontSize: 13 }}>{mail}</b>
                      <div className="muted mono" style={{ fontSize: 10.5, marginTop: 2 }} title={id2}>{id2.length > 22 ? id2.slice(0, 22) + '…' : id2}</div>
                    </td>
                    <td>{fromEnv ? <span className="chip">环境变量</span> : <span className="chip">控制台登录</span>}</td>
                    <td><span className={`st ${st[0]}`}><i />{st[1]}</span>
                      <div className="faint" style={{ fontSize: 10.5, marginTop: 3 }}>token {cached ? '已缓存' : '未缓存'}</div>
                    </td>
                    <td className="muted">{coolTxt}</td>
                    <td>{okN} / <span style={{ color: badN ? 'var(--bad)' : 'inherit' }}>{badN}</span></td>
                    <td className="muted">{relTime(last)}</td>
                    <td className="num-r" style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn xs pri" onClick={() => setDetailId(id2)}>详情</button>{' '}
                      <button className="btn xs" onClick={() => void act(id2, 'reset', '已清除该账号冷却与 token 缓存')}>重置冷却</button>{' '}
                      {disabled
                        ? <button className="btn xs pri" onClick={() => void act(id2, 'enable', '已启用')}>启用</button>
                        : <button className="btn xs" onClick={() => void act(id2, 'disable', '已停用')}>停用</button>}{' '}
                      {!fromEnv && <button className="btn xs dgr" onClick={() => { if (confirm('移除这个账号？移除后需要重新登录才能恢复。')) void act(id2, 'remove', '已移除') }}>移除</button>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table></div>
        )}
      </div>
      {detailId && <ClineDetail id2={detailId} onClose={() => setDetailId(null)} />}
    </>
  )
}

/* ---------- Cline 账号详情弹层 ---------- */
function ClineDetail({ id2, onClose }: { id2: string; onClose: () => void }) {
  const api = useSvcApi('cline')
  const [d, setD] = useState<any>(null)
  const [err, setErr] = useState('')
  const [revealed, setRevealed] = useState('')
  const [bal, setBal] = useState<any>(null)
  useEffect(() => {
    api(`/v1/accounts/detail?id=${encodeURIComponent(id2)}`)
      .then((j) => setD(j))
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
  }, [api, id2])
  async function reveal() {
    try {
      const j = await api(`/v1/accounts/detail?id=${encodeURIComponent(id2)}&reveal=1`)
      setRevealed(String(pick(j, 'refreshToken') ?? ''))
      toast('已显示完整值', 'ok')
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err')
    }
  }
  async function balance() {
    try {
      const j = await api(`/v1/accounts/balance?id=${encodeURIComponent(id2)}`)
      setBal(j)
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err')
    }
  }
  const detail = pick<any>(d, 'account', 'detail') ?? d
  /* 字段名按 worker 真实响应（handleAccountDetail）：
     limited（不是 cooldowns/cooling）、other_models（不是 availableModels）、
     usage_today / usage_total（不是 usage/totals）、refresh_token / refresh_token_masked。
     token_cached、cooldown_minutes、runtime（来源）也在这个响应里。 */
  const cooldowns = pick<any[]>(detail, 'limited', 'cooldowns', 'cooling') ?? []
  const available = pick<string[]>(detail, 'other_models', 'availableModels', 'available') ?? []
  const usageTotal = pick<any>(detail, 'usage_total', 'usage') ?? {}
  const usageToday = pick<any>(detail, 'usage_today') ?? {}
  const rt = String(pick(detail, 'refresh_token') ?? '')
  const rtMasked = String(pick(detail, 'refresh_token_masked') ?? '')
  /* 解除单模型冷却要带 modelId（worker 的 clearCooldown 分支），
     不带 modelId 只发 reset 会把这个账号**全部**模型的冷却一起清掉。 */
  async function clearOne(modelId: string) {
    try {
      await api('/v1/accounts/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'clearCooldown', id: id2, modelId }) })
      toast('已解除该模型的冷却', 'ok')
      const j = await api(`/v1/accounts/detail?id=${encodeURIComponent(id2)}`)
      setD(j)
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err')
    }
  }
  return (
    <Veil onClose={onClose} width="min(680px, calc(100vw - 40px))">
        <h3>账号详情 · {String(pick(detail, 'email') ?? id2).slice(0, 32)} <button className="btn ghost xs" style={{ float: 'right', marginTop: -4 }} onClick={onClose}>关闭</button></h3>
        {err ? <p style={{ color: 'var(--bad)', fontSize: 13 }}>{err}</p> : !d ? <div className="loading">读取中…</div> : (
          <>
            <div className="tbox"><table><tbody>
              <tr><td style={{ width: 130 }} className="muted">状态</td><td>{pick(detail, 'enabled') === false ? '已停用' : '启用'}</td></tr>
              <tr><td className="muted">来源</td><td>{pick(detail, 'runtime') ? '控制台登录（已存盘）' : '环境变量 CLINE_REFRESH_TOKEN'}</td></tr>
              <tr><td className="muted">账号 ID</td><td className="m" style={{ fontSize: 11.5 }}>{String(pick(detail, 'id') ?? id2)}</td></tr>
              <tr><td className="muted">token 缓存</td><td>{pick(detail, 'token_cached', 'tokenCached') ? '有' : '无'}</td></tr>
              <tr><td className="muted">兜底冷却时长</td><td>{String(pick(detail, 'cooldown_minutes', 'fallbackCooldown') ?? 30)} 分钟</td></tr>
              {pick(detail, 'stats.last_error') ? (
                <tr><td className="muted">最后错误</td><td style={{ color: 'var(--bad)', fontSize: 12 }}>{String(pick(detail, 'stats.last_error')).slice(0, 160)}</td></tr>
              ) : null}
            </tbody></table></div>
            <p style={{ fontSize: 12, fontWeight: 650, margin: '16px 0 6px' }}>冷却中的模型（额度按「账号×模型」独立计算）</p>
            {cooldowns.length === 0 ? <p className="muted" style={{ fontSize: 12.5 }}>没有模型在冷却中。</p> : (
              <div className="tbox"><table>
                <thead><tr><th>模型</th><th style={{ width: 90 }}>原因</th><th style={{ width: 110 }}>恢复时刻</th><th style={{ width: 110 }}></th></tr></thead>
                <tbody>
                  {cooldowns.map((c: any, i: number) => (
                    <tr key={i}>
                      <td className="m">{String(pick(c, 'model_id', 'model') ?? '')}</td>
                      <td><span className="st rate"><i />{String(pick(c, 'reason') ?? '未识别')}</span></td>
                      <td className="muted">{relTime(pick(c, 'until', 'resets_at'))}</td>
                      <td className="num-r"><button className="btn xs" onClick={() => void clearOne(String(pick(c, 'model_id', 'model') ?? ''))}>解除该模型</button></td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            )}
            <p style={{ fontSize: 12, fontWeight: 650, margin: '16px 0 6px' }}>现在可用的模型（{available.length}）</p>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', maxHeight: 150, overflowY: 'auto' }}>
              {available.length === 0 ? <span className="muted" style={{ fontSize: 12.5 }}>没有其它可用模型。</span>
                : available.slice(0, 60).map((m) => <span key={m} className="chip">{m}</span>)}
              {available.length > 60 && <span className="faint" style={{ fontSize: 11.5 }}>…共 {available.length} 个</span>}
            </div>
            {/* 原面板「Token 用量」是今日与累计两组各四项；字段名 usage_today / usage_total */}
            <p style={{ fontSize: 12, fontWeight: 650, margin: '16px 0 6px' }}>Token 用量</p>
            <div className="tbox"><table><tbody>
              <tr><td style={{ width: 90 }} className="muted">今日</td>
                  <td className="tok" style={{ fontSize: 11.5 }}>输入 {fmtInt(pick(usageToday, 'input', 'prompt_tokens'))} · 输出 {fmtInt(pick(usageToday, 'output', 'completion_tokens'))} · 调用 {fmtInt(pick(usageToday, 'calls', 'requests'))}</td></tr>
              <tr><td className="muted">累计</td>
                  <td className="tok" style={{ fontSize: 11.5 }}>输入 {fmtInt(pick(usageTotal, 'input', 'prompt_tokens'))} · 输出 {fmtInt(pick(usageTotal, 'output', 'completion_tokens'))} · 调用 {fmtInt(pick(usageTotal, 'calls', 'requests'))}</td></tr>
            </tbody></table></div>
            <p style={{ fontSize: 12, fontWeight: 650, margin: '16px 0 6px' }}>refreshToken</p>
            <div className="linkbox">{revealed ? revealed : (rtMasked || rt.slice(0, 24) + '…') + (rtMasked ? '' : '（脱敏）')}</div>
            {pick(detail, 'rotated') ? <p className="faint" style={{ fontSize: 11.5, marginTop: 4 }}>上游已轮换过 token，这里显示的是内存中的现值；环境变量里的旧值不会自动更新。</p> : null}
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn xs pri" onClick={() => void reveal()}>显示完整值</button>
              <button
                className="btn xs"
                onClick={() => void navigator.clipboard.writeText(revealed || rt).then(
                  () => toast(revealed ? 'refreshToken 已复制' : '尚未显示完整值，先点「显示完整值」', revealed ? 'ok' : 'err'),
                  () => toast('复制失败：浏览器不允许写剪贴板', 'err'),
                )}
              >复制</button>
              <button className="btn xs" onClick={() => void balance()}>查询官方余额</button>
            </div>
            {bal && (
              <div className="kv2" style={{ marginTop: 12 }}>
                <div><div className="faint" style={{ fontSize: 11 }}>Credit 余额</div><div className="m">{Number(pick(bal, 'balance', 'credits') ?? 0).toFixed(6)}</div></div>
                <div><div className="faint" style={{ fontSize: 11 }}>查询时刻</div><div className="m">{new Date().toTimeString().slice(0, 8)}</div></div>
              </div>
            )}
          </>
        )}
        <div className="acts"><button className="btn" onClick={onClose}>关闭</button></div>
    </Veil>
  )
}

/* ---------- WorkBuddy 积分任务弹层（完整版） ---------- */
/* 可自动完成的任务（与后端 internal/panel/autotask.go 的 autoActions 表一致）。
   其余任务要在官方客户端里交互，面板只展示指引（挂在行的 title 上）。
   ★ 后端**不返回**「这个任务能不能自动完成」这个字段——判断依据只能由前端持有，
   所以这张表是必需的，不能靠 pick(t,'auto') 之类的推测字段（那种写法永远取不到）。 */
const AUTO_TASKS: Record<string, string> = {
  chat_5: '上报 5 条对话活跃事件（自动补足差额）',
  first_buddy: '上报解锁 → 同意协议 → 领取第一只 Buddy（+300 分）',
  'Model_chat_GLM5.2': '接受任务 → glm-5.2 真实对话一次 → 对齐模型上报',
  RichMeow_Chat: '桌面指纹事件链上报（已验证：纯 API 可点亮）',
  Buddy_App: '上报「进入 Buddy 应用」事件链（已验证：纯 API 可点亮）',
  Buddy_App_QQ: '上报「进入企鹅教师助手」事件链（已验证：纯 API 可点亮）',
  automation_1: '上报「定时任务创建」事件（已验证：纯 API 可点亮）',
  Library_read: '上报「读资料库介绍」事件（已验证：纯 API 可点亮）',
  template_5: '上报「使用模板创建任务」事件组 ×5（三账号点亮）',
  playbook_prompt: '上报「灵感案例做同款发送 Prompt」事件组（三账号点亮）',
  create_canvas: '上报「设计创意画布创建」事件组（三账号点亮，+300 分）',
  expert_5: '真实专家召唤+使用链 ×5（三账号实测点亮）',
  Expert_team_use_3: '真实专家团召唤+使用链 ×3（三账号实测点亮）',
  Hp_Appearance: '设置主题 API + 皮肤生效事件（两账号实测点亮）',
  black_cat: '夜猫子：23:00–08:00 窗口内 glm-5.2 对话补足（窗口外提示等 23 点排程）',
  Expert_lighthouse: '真实轻量云专家召唤+使用链（真实对话 requestId，两账号实测点亮）',
  skill_1: '真实对话 + skill_info 技能加载事件（实测点亮）',
}

function WorkbuddyTaskModal({ uid, onClose }: { uid: string; onClose: () => void }) {
  const api = useSvcApi('workbuddy')
  const [tasks, setTasks] = useState<any[] | null>(null)
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    try {
      const j = await api(`/panel/api/accounts/${uid}/tasks`)
      const list = pick<any[]>(j, 'tasks', 'items') ?? []
      setTasks(list.map((t: any) => (typeof t === 'string' ? { task_code: t } : t)))
      setErr('')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [api, uid])
  useEffect(() => { void load() }, [load])

  async function act2(path: string, body: any, okMsg: string) {
    try {
      const j = await api(`/panel/api/accounts/${uid}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const msg = String(pick(j, 'message') ?? okMsg)
      toast(msg, 'ok')
      void load()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err')
    }
  }

  /* 状态机按后端 Task 结构（upstream/tasks.go）：
     claimed / claimable / locked / accept_status(accepted 等) / target+current（恒输出）。
     注意 target 与 current **永远存在**（0 也是有效值），所以「有进度就是进行中」的
     旧判据会把所有任务都判成进行中，让「未接受/未解锁」永不出现。 */
  function statusOf(t: any): [string, string] {
    if (pick(t, 'claimed') === true) return ['ok', '已领取']
    if (pick(t, 'claimable') === true) return ['credit', '可领取']
    if (pick(t, 'locked') === true) return ['mute', '未解锁']
    const acc = String(pick(t, 'accept_status') ?? '')
    if (acc === 'accepted') return ['mute', '进行中']
    if (acc === 'claimed') return ['ok', '已领取']
    if (acc) return ['mute', '未接受']
    return ['mute', '—']
  }

  /* 排序与原面板一致：可领取优先、已领取沉底，一眼看到「现在该做什么」 */
  const sorted = tasks ? [...tasks].sort((a, b) =>
    Number(Boolean(pick(b, 'claimable'))) - Number(Boolean(pick(a, 'claimable'))) ||
    Number(Boolean(pick(a, 'claimed'))) - Number(Boolean(pick(b, 'claimed'))) ||
    String(pick(a, 'task_code') ?? '').localeCompare(String(pick(b, 'task_code') ?? ''))
  ) : null

  return (
    <Veil onClose={onClose} width="min(800px, calc(100vw - 40px))">
        <h3>积分任务 <span className="muted" style={{ fontSize: 12, fontWeight: 500 }}>· {uid.slice(0, 16)}</span></h3>
        <p className="sub">查询上游任务进度；「接受」为报名（幂等），「领取」在进度达标后可用。「一键完成」只对网关能复现的任务开放（鼠标悬停看做法）。</p>
        {err ? <p style={{ color: 'var(--bad)', fontSize: 13 }}>{err}</p> : !sorted ? <div className="loading">加载中…</div> : sorted.length === 0 ? (
          <p className="muted" style={{ fontSize: 12.5 }}>该账号暂无任务</p>
        ) : (
          <div className="tbox"><table>
            <thead><tr><th>任务</th><th style={{ width: 90 }}>进度</th><th style={{ width: 120 }}>奖励</th><th style={{ width: 96 }}>状态</th><th style={{ width: 160 }}></th></tr></thead>
            <tbody>
              {sorted.map((t: any, i: number) => {
                const code = String(pick(t, 'task_code', 'code') ?? i)
                const name = String(pick(t, 'title', 'name') ?? code)
                const tag = String(pick(t, 'tag') ?? '')
                const cur = Number(pick(t, 'current') ?? 0)
                const tgt = Number(pick(t, 'target') ?? 0)
                const prog = tgt > 0 ? `${cur} / ${tgt}` : cur > 0 ? String(cur) : '—'
                /* 奖励：后端给的是 credit / energy / reward_buddy 三个独立字段，
                   没有 rewards[] 也没有 reward_label。 */
                const parts: string[] = []
                if (Number(pick(t, 'credit') ?? 0) > 0) parts.push(`+${pick(t, 'credit')} 分`)
                if (Number(pick(t, 'energy') ?? 0) > 0) parts.push(`+${pick(t, 'energy')} 能`)
                if (pick(t, 'reward_buddy') === true) parts.push('Buddy')
                const reward = parts.length ? parts.join(' ') : '—'
                const [kind, label] = statusOf(t)
                const claimed = pick(t, 'claimed') === true
                const claimable = pick(t, 'claimable') === true
                const locked = pick(t, 'locked') === true
                const accepted = String(pick(t, 'accept_status') ?? '') === 'accepted'
                const autoTip = AUTO_TASKS[code]
                const tip = [pick(t, 'title'), pick(t, 'task_desc', 'description'), pick(t, 'jump_url') ? `跳转：${pick(t, 'jump_url')}` : ''].filter(Boolean).join('\n')
                return (
                  <tr key={code + i} title={tip || undefined}>
                    <td><b style={{ fontSize: 13 }}>{name}</b>{tag ? <> <span className="chip">{tag}</span></> : null}
                      <div className="faint m" style={{ fontSize: 11 }}>{code}</div></td>
                    <td className="tok">{prog}</td>
                    <td className="tok">{reward}</td>
                    <td><span className={`st ${kind}`}><i />{label}</span></td>
                    <td className="num-r" style={{ whiteSpace: 'nowrap' }}>
                      {claimable && !claimed && <button className="btn xs pri" onClick={() => void act2('tasks/claim', { task_code: code }, '已领取奖励')}>领取</button>}{' '}
                      {!claimed && !claimable && !locked && autoTip && (
                        <button className="btn xs pri" title={autoTip} onClick={() => void act2('tasks/auto', { task_code: code }, '已执行')}>一键完成</button>
                      )}{' '}
                      {!claimed && !locked && !accepted && !autoTip && (
                        <button className="btn xs" onClick={() => void act2('tasks/accept', { task_codes: [code] }, '已接受任务')}>接受</button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table></div>
        )}
        <div className="acts">
          <button className="btn" onClick={() => void act2('tasks/accept_all', {}, '已接受全部任务')}>全部接受</button>
          <button className="btn pri" onClick={() => void act2('tasks/auto_all', {}, '一键执行完成')}>一键完成可自动任务</button>
          <button className="btn" onClick={() => void load()}>重新查询</button>
          <button className="btn" onClick={onClose}>关闭</button>
        </div>
    </Veil>
  )
}

async function actCline(api: (p: string, o?: RequestInit) => Promise<any>, id: string, action: string, okMsg: string) {
  await api('/v1/accounts/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, id }) })
  toast(okMsg, 'ok')
}

/* ---------- cmdgo ---------- */
function CmdgoAccounts({ live }: { live: boolean }) {
  const api = useSvcApi('cmdgo')
  const [snap, setSnap] = useState<any>(null)
  const [err, setErr] = useState('')
  const load = useCallback(async () => {
    try {
      const j = await api('/api/status')
      setSnap(j)
      setErr('')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [api])
  useEffect(() => {
    if (!live) return
    void load()
    const t = setInterval(() => void load(), 2500)
    return () => clearInterval(t)
  }, [live, load])

  const accounts: any[] = pick<any[]>(snap, 'accounts') ?? []
  const login = pick<any>(snap, 'login') ?? {}
  const activeAccounts = Number(pick(snap, 'activeAccounts') ?? 0)
  const provider = String(pick(snap, 'provider') ?? '')
  /* 上游网关地址：原面板 hero 就展示它，冲一个上游问题时第一眼看的就是这行 */
  const upstream = String(pick(snap, 'baseURL') ?? '').replace(/^https?:\/\//, '')
  const modelCount = pick(snap, 'modelCount')
  const loginWho = [pick(login, 'userName'), pick(login, 'keyName')].filter(Boolean).join(' · ')

  async function post(path: string, body?: any, okMsg?: string) {
    try {
      await api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) })
      if (okMsg) toast(okMsg, 'ok')
      void load()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err')
    }
  }

  if (!live) return <NotRunning />
  return (
    <>
      {/* 链路状态行：原面板 hero 的三行信息（可用账号 / 模型数 / 上游主机） */}
      <div className="sect" style={{ padding: '11px 14px', marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span className="st ok" style={{ ...(login?.status === 'error' ? { color: 'var(--bad)' } : {}) }}>
            <i />{accounts.length > 0 || login?.status === 'success' ? 'LINK ACTIVE' : login?.status === 'waiting' ? 'HANDSHAKE' : 'NO KEY'}
          </span>
          <span className="muted m" style={{ fontSize: 12 }}>
            keys {activeAccounts}/{accounts.length}
            {modelCount != null ? ` · models ${String(modelCount)}` : ''}
            {provider ? ` · ${provider}` : ''}
            {upstream ? ` · ${upstream}` : ''}
          </span>
        </div>
      </div>
      <div className="sect" style={{ padding: 14, marginBottom: 14 }}><div className="opsbar">
        <button className="btn xs pri" disabled={login?.status === 'waiting'} onClick={() => void post('/api/login', {}, undefined)}>▸ 发起登录</button>
        {login?.status === 'waiting' && (
          <>
            <input className="mono" readOnly value={login.authUrl ?? ''} style={{ flex: 1, minWidth: 0 }} onFocus={(e) => e.currentTarget.select()} />
            <a className="btn xs pri" href={login.authUrl} target="_blank" rel="noreferrer">打开登录页 ↗</a>
            <button className="btn xs" onClick={() => { navigator.clipboard.writeText(String(login.authUrl ?? '')).then(() => toast('链接已复制', 'ok')) }}>复制链接</button>
            <button className="btn xs" onClick={() => void post('/api/cancel', {}, '已取消')}>取消</button>
            <span className="muted" style={{ fontSize: 12 }}>等待 Command Code 回调（浏览器完成授权后自动入池）…</span>
          </>
        )}
        {/* 登录终态：原面板会显示成功者与失败原因，之前这里两种都没有 */}
        {login?.status === 'success' && (
          <span className="st ok"><i />授权成功{loginWho ? `：${loginWho}` : ''}{login?.at ? `（${String(login.at).slice(0, 19).replace('T', ' ')}）` : ''}</span>
        )}
        {login?.status === 'error' && (
          <span className="st stop"><i />授权失败{login?.message ? `：${String(login.message)}` : ''}</span>
        )}
        {login?.status !== 'waiting' && login?.status !== 'success' && login?.status !== 'error' && (
          <span className="muted" style={{ fontSize: 12 }}>尚未发起登录</span>
        )}
        {accounts.length > 0 && <span style={{ flex: 1 }} />}
        {accounts.length > 0 && <button className="btn xs dgr" onClick={() => { if (confirm('清空账号池？所有账号及其 API key 将一并删除。')) void post('/api/logout', {}, '已清空账号池') }}>清空账号池</button>}
      </div></div>
      {err ? <div className="alertbar err"><span className="ico" /><span>{err}</span></div> : null}
      <div className="sect" style={{ marginBottom: 0 }}>
        {accounts.length > 0 && (
          <div className="sub" style={{ marginBottom: 8 }}>{activeAccounts} / {accounts.length} 可用 · 请求失败自动冷却并故障转移</div>
        )}
        {accounts.length === 0 ? (
          <div className="empty"><b>暂无账号</b><span>每完成一次授权登录自动入池；多账号轮询摊薄额度，请求失败自动冷却并故障转移。</span></div>
        ) : (
          <div>
            {accounts.map((a: any) => {
              const id2 = String(pick(a, 'id') ?? '')
              const enabled = pick(a, 'enabled') !== false
              const cooling = Boolean(pick(a, 'cooling'))
              const name = [pick(a, 'userName'), pick(a, 'keyName')].filter(Boolean).join(' · ') || id2
              const fail = pick<number>(a, 'failCount') ?? 0
              const lastErr = String(pick(a, 'lastError') ?? '')
              return (
                <div key={id2} className="acctrow" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 2px', borderTop: '1px solid var(--line-soft)' }}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', flex: 'none', background: !enabled ? 'var(--off)' : cooling ? 'var(--warn)' : 'var(--ok)' }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 600 }}>{name}</div>
                    <div className="muted mono" style={{ fontSize: 11 }}>{id2} · {!enabled ? 'DISABLED' : cooling ? 'COOLDOWN' : 'READY'}{fail > 0 ? ` · fail×${fail}` : ''}{lastErr ? ` · ${lastErr}` : ''}</div>
                  </div>
                  {cooling && <span className="m" style={{ fontSize: 11, color: 'var(--warn)' }}>冷却中</span>}
                  <button className="btn xs" onClick={() => void post('/account/toggle', { id: id2, enabled: !enabled }, '状态已切换')}>{enabled ? '停用' : '启用'}</button>
                  <button className="btn xs dgr" onClick={() => { if (confirm(`移除账号 ${id2}？其 API key 将一并删除。`)) void post('/account/remove', { id: id2 }, '已移除') }}>移除</button>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </>
  )
}

/* ---------- 添加账号（workbuddy / qoder / cline 的授权流） ---------- */
function AddAccount({ service, onDone }: { service: string; onDone: () => void }) {
  const [open, setOpen] = useState(false)
  const [phase, setPhase] = useState<'form' | 'waiting' | 'done'>('form')
  const [link, setLink] = useState('')
  const [deviceCode, setDeviceCode] = useState('')
  const [waitMsg, setWaitMsg] = useState('')
  const api = useSvcApi(service)
  const pollRef = useRef<number | null>(null)
  const startResp = useRef<any>(null)

  function close() {
    if (pollRef.current) window.clearInterval(pollRef.current)
    setOpen(false)
    setPhase('form')
    setDeviceCode('')
    setWaitMsg('')
  }
  async function begin(realm: string) {
    setPhase('waiting')
    try {
      let pollPath = ''
      if (service === 'workbuddy') {
        const j = await api('/panel/api/login/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ realm }) })
        setLink(String(pick(j, 'authUrl', 'url') ?? ''))
        pollPath = `/panel/api/login/poll?state=${encodeURIComponent(String(pick(j, 'state') ?? ''))}`
      } else if (service === 'qoder') {
        const j = await api('/panel/api/accounts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '', region: realm }) })
        const id2 = String(pick(j, 'id', 'account') ?? '')
        const j2 = await api(`/panel/api/accounts/${id2}/login/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        setLink(String(pick(j2, 'authUrl', 'url', 'verification_url') ?? ''))
        pollPath = `/panel/api/accounts/${id2}/login/poll`
      } else if (service === 'cline') {
        const j = await api('/v1/login/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        startResp.current = j
        /* worker 返回的字段是 verification_uri（不是 authUrl/verification_url），
           之前取不到 → 弹层里没有任何链接可点。user_code 是设备码，页面可能要手输。 */
        setLink(String(pick(j, 'verification_uri', 'authUrl', 'auth_url', 'verification_url') ?? ''))
        setDeviceCode(String(pick(j, 'user_code') ?? ''))
      }
      // 轮询
      pollRef.current = window.setInterval(async () => {
        try {
          let done = false
          let failed = ''
          if (service === 'workbuddy') {
            const j = await api(pollPath)
            const st = String(pick(j, 'status') ?? '')
            if (st === 'ok' || st === 'success' || pick(j, 'nickname')) done = true
          } else if (service === 'qoder') {
            const j = await api(pollPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
            if (pick(j, 'done') === true || pick(j, 'status') === 'ok') done = true
          } else if (service === 'cline') {
            const j = await api('/v1/login/poll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device_code: pick(startResp.current, 'device_code') }) })
            /* 只有 status==='success' 才算成功。注意 worker 在「用户还没授权」时
               返回的是 {ok:true, status:'pending'} —— ok 为 true 只是「请求成功」，
               之前把 ok===true 当成功会 3 秒就谎报入池并关窗。 */
            const st = String(pick(j, 'status') ?? '')
            if (st === 'success') done = true
            else if (st === 'failed') {
              /* error 是 {message,type,reason} 对象，取 .message；取不到再退回顶层 message。
                 不要把对象本身交给 String()，那会渲染成 [object Object]。 */
              const em = pickPath(j, 'error.message')
              failed = String((typeof em === 'string' ? em : '') || pickPath(j, 'message') || '授权失败')
            }
            else if (st === 'slow_down' || st === 'pending') setWaitMsg('等待授权…（还没在浏览器里确认）')
          }
          if (failed) {
            if (pollRef.current) window.clearInterval(pollRef.current)
            setWaitMsg(failed)
            return
          }
          if (done) {
            if (pollRef.current) window.clearInterval(pollRef.current)
            setPhase('done')
            toast('授权成功，账号已入池', 'ok')
            onDone()
            setTimeout(close, 1500)
          }
        } catch { /* 轮询失败继续 */ }
      }, 3000)
    } catch (e) {
      toast('发起授权失败：' + (e instanceof Error ? e.message : String(e)), 'err')
      close()
    }
  }

  return (
    <>
      <button className="btn xs pri" onClick={() => setOpen(true)}>＋ 添加账号</button>
      {open && (
        <Veil onClose={close}>
            <h3>添加账号</h3>
            <p className="sub">
              {service === 'workbuddy' && '浏览器完成腾讯账号登录，网关自动接续签到并载入账号池，无需重启。'}
              {service === 'qoder' && '浏览器完成 Qoder 设备授权，凭证由 worker 写入账号数据目录，无需重启。'}
              {service === 'cline' && '打开授权页面登录 Cline 账号并确认，本页会自动检测结果。'}
            </p>
            {phase === 'form' && (
              <>
                {service !== 'cline' && (
                  <div style={{ marginBottom: 14 }}>
                    <b style={{ fontSize: 13 }}>版本：</b>
                    <label className="check" style={{ marginRight: 16 }}>
                      <input type="radio" name={'rg-' + service} value={service === 'workbuddy' ? 'cn' : 'cn'} defaultChecked /> {service === 'workbuddy' ? '国内版（CN）' : '国内版（cn）'}
                    </label>
                    <label className="check">
                      <input type="radio" name={'rg-' + service} value={service === 'workbuddy' ? 'global' : 'global'} /> {service === 'workbuddy' ? '国际版（Global）' : '国际版（global）'}
                    </label>
                  </div>
                )}
                <div className="acts">
                  <button className="btn" onClick={close}>取消</button>
                  <button className="btn pri" onClick={() => {
                    const rg = (document.querySelector(`input[name='rg-${service}']:checked`) as HTMLInputElement)?.value ?? 'cn'
                    void begin(rg)
                  }}>获取授权链接</button>
                </div>
              </>
            )}
            {phase === 'waiting' && (
              <>
                <div className="spin" />
                <p style={{ fontSize: 13, textAlign: 'center' }}>等待授权完成，自动检测中…</p>
                {link && (
                  <>
                    <div className="linkbox">{link}</div>
                    <div className="acts center">
                      <a className="btn pri" href={link} target="_blank" rel="noreferrer">打开授权页 ↗</a>
                      <button className="btn" onClick={() => { navigator.clipboard.writeText(link).then(() => toast('链接已复制', 'ok')) }}>复制链接</button>
                    </div>
                  </>
                )}
                {/* cline 的 WorkOS 设备流会在页面上要一串设备码；原控制台专门给了展示与复制 */}
                {deviceCode && (
                  <>
                    <p className="muted" style={{ fontSize: 11.5, textAlign: 'center', marginBottom: 4 }}>若页面要求输入设备码，就是下面这串：</p>
                    <div className="code" style={{ textAlign: 'center', fontSize: 16, letterSpacing: 2, fontWeight: 600 }}>{deviceCode}</div>
                    <div className="acts center">
                      <button className="btn xs" onClick={() => { navigator.clipboard.writeText(deviceCode).then(() => toast('设备码已复制', 'ok')) }}>复制设备码</button>
                    </div>
                  </>
                )}
                {waitMsg && <p className="muted" style={{ fontSize: 12, textAlign: 'center' }}>{waitMsg}</p>}
              </>
            )}
            {phase === 'done' && (
              <div style={{ textAlign: 'center' }}>
                <div className="okbig">✓</div>
                <p style={{ fontSize: 13.5, fontWeight: 600, margin: 0 }}>授权成功，账号已入池。</p>
              </div>
            )}
        </Veil>
      )}
    </>
  )
}

/* ---------- 工具 ---------- */
function fmtNum(n: unknown): string {
  if (n == null) return '—'
  const v = Number(n)
  if (Number.isNaN(v)) return String(n)
  return v.toLocaleString('en-US', { maximumFractionDigits: 2 })
}
/** 解析时间：数字（秒/毫秒）或 RFC3339 字符串；Go 零值时间/无法解析 → null */
function parseTs(v: unknown): number | null {
  if (v == null) return null
  let t = typeof v === 'number' ? v : Date.parse(String(v))
  if (typeof t !== 'number' || Number.isNaN(t)) return null
  if (t > 0 && t < 1e12) t = t * 1000 // 秒级时间戳
  if (t < new Date(2000, 0, 1).getTime()) return null // Go 零值时间（0001-01-01）
  return t
}
function relTime(ts: unknown): string {  const t = parseTs(ts)
  if (t == null) return '—'
  const s = (Date.now() - t) / 1000
  if (s < 5) return '刚刚'
  if (s < 60) return Math.floor(s) + ' 秒前'
  if (s < 3600) return Math.floor(s / 60) + ' 分钟前'
  if (s < 86400) return Math.floor(s / 3600) + ' 小时前'
  return Math.floor(s / 86400) + ' 天前'
}

/** 剩余时长（冷却/熔断用）：紧凑中文，如「2h30m」「45s」 */function durText(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '0s'
  const s = Math.round(sec)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60 ? `${s % 60}s` : ''}`
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h < 24) return `${h}h${m ? `${m}m` : ''}`
  const d = Math.floor(h / 24)
  return `${d}d${h % 24 ? `${h % 24}h` : ''}`
}

/** 服务自身的运行时长（页头显示，原面板侧栏有） */
function uptimeText(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return ''
  const s = Math.round(sec)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

/* ================= 模型页签 ================= */
function ModelsPanel({ id, live }: { id: string; live: boolean }) {
  const api = useSvcApi(id)
  const [rows, setRows] = useState<any[]>([])
  const [err, setErr] = useState('')
  /* zen 的模型页默认列上游目录里的全部模型（免费与否逐个标出来），
     所以取数时就带上 ?all=1，筛选用本地状态切。 */
  const [zenFreeOnly, setZenFreeOnly] = useState(false)
  const load = useCallback(async () => {
    try {
      if (id === 'cmdgo') {
        const j = await api('/api/status')
        setRows((pick<any[]>(j, 'modelIds') ?? []).map((m: any) => ({ id: typeof m === 'string' ? m : pick(m, 'id') })))
      } else if (id === 'cline') {
        const j = await api('/v1/models/enabled')
        const list = pick<any[]>(j, 'models', 'enabled', 'data') ?? []
        setRows(Array.isArray(list) ? list.map((m) => (typeof m === 'string' ? { id: m } : m)) : [])
      } else {
        const j = await api(id === 'zen' ? '/panel/api/models?all=1' : '/panel/api/models')
        setRows(pick<any[]>(j, 'models', 'catalog', 'items') ?? [])
      }
      setErr('')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [api, id])
  useEffect(() => { if (live) void load() }, [live, load])

  if (!live) return <NotRunning />
  if (err) return <div className="alertbar err"><span className="ico" /><span>{err}</span></div>
  if (rows.length === 0) return <div className="empty"><b>暂无模型</b><span>{id === 'qoder' ? '账号需要完成登录且 worker 就绪。' : id === 'cmdgo' ? '服务启动后会从官方目录同步。' : '点「刷新」重试。'}</span></div>

  /* ---- WorkBuddy：完整还原原面板「模型能力」表（模型/积分倍率/默认档/支持的思考档位/上下文长度/最大输出） ---- */
  if (id === 'workbuddy') {
    const k = (v: unknown) => (v != null && Number(v) > 0 ? `${Math.round(Number(v) / 1000)}K` : '—')
    return (
      <div className="sect" style={{ marginBottom: 0 }}>
        <div className="sect-head">
          <h3>模型能力</h3>
          <span className="sub">{rows.length} 个模型 · 实时查询上游</span>
          <span className="sp" />
          <button className="btn xs" onClick={() => void load()}>重新获取</button>
        </div>
        <div className="tbox"><table>
          <thead>
            <tr>
              <th style={{ width: 200 }}>模型</th>
              <th style={{ width: 90 }}>积分倍率</th>
              <th style={{ width: 96 }}>默认档</th>
              <th>支持的思考档位</th>
              <th className="num-r" style={{ width: 100 }}>上下文长度</th>
              <th className="num-r" style={{ width: 92 }}>最大输出</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m, i) => {
              const mid = String(pick(m, 'id', 'model', 'modelId', 'name') ?? i)
              const name = String(pick(m, 'name') ?? '')
              const credits = String(pick(m, 'credits', 'rate', 'price_label') ?? '')
              const effort = String(pick(m, 'default_effort', 'defaultEffort') ?? '')
              const effortsRaw = pick<any[]>(m, 'supported_efforts', 'supportedEfforts')
              const efforts: string[] = Array.isArray(effortsRaw) ? effortsRaw.map(String) : []
              const canDisable = Boolean(pick(m, 'can_disable_thinking', 'canDisableThinking'))
              const reasoning = pick(m, 'supports_reasoning') !== false
              return (
                <tr key={mid + i}>
                  <td>
                    <b style={{ fontSize: 13 }}>{mid}</b>
                    {name && name !== mid ? <div className="faint" style={{ fontSize: 11 }}>{name}</div> : null}
                  </td>
                  <td>{credits ? <span className="m">{credits}</span> : '—'}</td>
                  <td>{effort ? <span className="st ok"><i />{effort}</span> : '—'}</td>
                  <td>
                    {efforts.length > 0
                      ? efforts.map((e) => <span key={e} className="st warn" style={{ marginRight: 5 }}><i />{e}</span>)
                      : reasoning
                        ? <span className="muted" style={{ fontSize: 12 }}>固定档{effort ? ` · 默认 ${effort}` : ''}</span>
                        : <span className="faint" style={{ fontSize: 12 }}>不支持思考</span>}
                    {canDisable && <span className="st mute" style={{ marginLeft: 5 }}><i />off（可关）</span>}
                  </td>
                  <td className="num-r m">{k(pick(m, 'context_length', 'contextLength'))}</td>
                  <td className="num-r m">{k(pick(m, 'max_output_tokens', 'maxOutputTokens'))}</td>
                </tr>
              )
            })}
          </tbody>
        </table></div>
      </div>
    )
  }

  /* ---- Qoder：还原原面板「模型目录」6 列（模型 ID / 显示名 / 区域 / 类型 / 计费）
       后端 row = {id, region, account_id, display_name, is_reasoning, free, price_label} ---- */
  if (id === 'qoder') {
    return (
      <div className="sect" style={{ marginBottom: 0 }}>
        <div className="sect-head">
          <h3>模型目录</h3>
          <span className="sub">{rows.length} 个{rows.length > 0 ? ' · 来自就绪账号的实时 catalog' : ''}</span>
          <span className="sp" />
          <button className="btn xs" onClick={() => void load()}>重新获取</button>
        </div>
        <div className="tbox"><table>
          <thead><tr>
            <th style={{ width: 6 }}></th><th>模型 ID</th><th>显示名</th>
            <th style={{ width: 70 }}>区域</th><th style={{ width: 80 }}>类型</th><th style={{ width: 100 }}>计费</th>
          </tr></thead>
          <tbody>
            {rows.map((m, i) => {
              const mid = String(pick(m, 'id') ?? i)
              const region = String(pick(m, 'region') ?? '').toLowerCase() === 'cn' ? 'CN' : 'GL'
              const free = pick(m, 'free') === true
              const price = String(pick(m, 'price_label') ?? '')
              const reasoning = pick(m, 'is_reasoning') === true
              return (
                <tr key={mid + i}>
                  <td><span className="mark" /></td>
                  <td className="m">{mid}</td>
                  <td>{String(pick(m, 'display_name') ?? '—')}</td>
                  <td><span className="chip">{region}</span></td>
                  <td>{reasoning ? <span className="st warn"><i />推理</span> : <span className="st mute"><i />标准</span>}</td>
                  <td>{free ? <span className="st ok"><i />免费</span> : price ? <span className="st mute" title="积分倍率"><i />{price}</span> : <span className="st mute"><i />按额度</span>}</td>
                </tr>
              )
            })}
          </tbody>
        </table></div>
      </div>
    )
  }

  /* ---- zen：匿名免费通道。后端 ?all=1 回上游目录里的全部模型，
        每个都带 exposed/free 与未暴露原因，所以「哪些是免费的」在这张表上直接标出来。
        row = {id, exposed, free, billing, reason, supports_reasoning, supported_efforts,
               input_modalities, context_window, max_output} ---- */
  if (id === 'zen') {
    const k = (v: unknown) => (v != null && Number(v) > 0 ? `${Math.round(Number(v) / 1000)}K` : '—')
    const freeRows = rows.filter((m) => m.exposed === true)
    const shown = zenFreeOnly ? freeRows : rows
    return (
      <div className="sect" style={{ marginBottom: 0 }}>
        <div className="sect-head">
          <h3>模型目录</h3>
          <span className="sub">
            上游目录 {rows.length} 个 · <b>免费 {freeRows.length} 个</b> · 其余判定为付费/下架，调用会返回 400 并写明原因
          </span>
          <span className="sp" />
          <div className="seg">
            <button className={zenFreeOnly ? '' : 'on'} onClick={() => setZenFreeOnly(false)}>全部 {rows.length}</button>
            <button className={zenFreeOnly ? 'on' : ''} onClick={() => setZenFreeOnly(true)}>仅免费 {freeRows.length}</button>
          </div>
          <button className="btn xs" onClick={() => void load()}>重新获取</button>
        </div>
        <div className="tbox"><table>
          <thead><tr>
            <th style={{ width: 6 }}></th>
            <th>模型 ID</th>
            <th style={{ width: 84 }}>思考</th>
            <th style={{ width: 190 }}>可选档位</th>
            <th className="num-r" style={{ width: 96 }}>上下文</th>
            <th className="num-r" style={{ width: 92 }}>最大输出</th>
            <th style={{ width: 108 }}>能否调用</th>
          </tr></thead>
          <tbody>
            {shown.map((m, i) => {
              const mid = String(pick(m, 'id') ?? i)
              const isFree = m.exposed === true
              const reasoning = pick(m, 'supports_reasoning', 'is_reasoning') === true
              const effortsRaw = pick<any[]>(m, 'supported_efforts')
              const efforts: string[] = Array.isArray(effortsRaw) ? effortsRaw.map(String) : []
              const modalities = pick<any[]>(m, 'input_modalities')
              const billing = String(pick(m, 'billing', 'price_label') ?? '可用')
              const reason = String(pick(m, 'reason') ?? '')
              const lastError = String(pick(m, 'last_error') ?? '')
              const lastErrorAt = String(pick(m, 'last_error_at') ?? '')
              const lastOK = String(pick(m, 'last_ok_at') ?? '')
              const shortTime = lastErrorAt.length >= 16 ? lastErrorAt.slice(11, 16) : ''
              return (
                <tr key={mid + i} style={isFree ? undefined : { opacity: 0.55 }}>
                  <td>{isFree ? <span className="mark" /> : null}</td>
                  <td className="m">
                    {/* 模型 ID 直接点就复制：接客户端时要的就是这个串 */}
                    <button
                      className="linklike"
                      title="点击复制模型 ID"
                      onClick={() => { navigator.clipboard.writeText(mid).then(() => toast('模型 ID 已复制：' + mid, 'ok')) }}
                    >
                      {mid}
                    </button>
                    {Array.isArray(modalities) && modalities.includes('image')
                      ? <span className="chip" style={{ marginLeft: 6 }}>图片</span>
                      : null}
                    {/* 这个通道的模型可用性是浮动的：最近一次尝试失败就说清楚为什么 */}
                    {lastError
                      ? <div style={{ fontSize: 11, color: 'var(--bad)', marginTop: 2 }} title={lastError}>
                          上次失败{shortTime ? ` ${shortTime}` : ''}：{lastError.length > 58 ? lastError.slice(0, 58) + '…' : lastError}
                        </div>
                      : lastOK
                        ? <div className="faint" style={{ fontSize: 11, marginTop: 2 }}>最近一次调用成功</div>
                        : null}
                  </td>
                  <td>{reasoning ? <span className="st warn"><i />推理</span> : <span className="st mute"><i />标准</span>}</td>
                  <td>
                    {reasoning && efforts.length > 0
                      ? efforts.map((e) => <span key={e} className="st mute" style={{ marginRight: 5 }}><i />{e}</span>)
                      : <span className="faint" style={{ fontSize: 11.5 }}>{reasoning ? 'off 可关思考' : '—'}</span>}
                  </td>
                  <td className="num-r">{k(pick(m, 'context_window'))}</td>
                  <td className="num-r">{k(pick(m, 'max_output'))}</td>
                  <td>
                    {isFree
                      ? <span className="st ok"><i />免费</span>
                      : <span className="st mute" title={reason}><i />{billing}</span>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table></div>
        <p className="faint" style={{ fontSize: 11.5, marginTop: 8 }}>
          免费 = 上游实时目录里存在、且 models.dev 判定 cost 为 0（下架的一票否决），只有这些能被调用。
          「思考」为推理的模型默认就在思考，正文为空时看 reasoning_content；要真正停思考需发 reasoning_effort: "none"（off 档位即此）。
          「不承载」的 Muse 系列走 Responses 协议，本服务只承载 OpenAI Chat。
        </p>
      </div>
    )
  }

  return (
    <div className="sect" style={{ marginBottom: 0 }}>
      <div className="sect-head"><h3>模型目录</h3><span className="sub">{rows.length} 个{id === 'cmdgo' ? ' · 点模型 ID 复制' : ''}</span><span className="sp" /><button className="btn xs" onClick={() => void load()}>刷新</button></div>
      <div className="tbox"><table>
        <thead><tr><th>模型 ID</th><th style={{ width: 110 }}>状态 / 计费</th></tr></thead>
        <tbody>
          {rows.map((m, i) => {
            const mid = String(pick(m, 'id', 'model', 'modelId', 'name') ?? i)
            return (
              <tr key={mid + i}>
                {id === 'cmdgo' ? (
                  <td className="m"><button className="linklike" title="点击复制模型 ID" onClick={() => { navigator.clipboard.writeText(mid).then(() => toast('模型 ID 已复制', 'ok')) }}>{mid}</button></td>
                ) : (
                  <td className="m">{mid}</td>
                )}
                <td><span className="st ok"><i />{String(pick(m, 'billing', 'price_label', 'type') ?? '可用')}</span></td>
              </tr>
            )
          })}
        </tbody>
      </table></div>
      {id === 'cline' && <p className="faint" style={{ fontSize: 11.5, marginTop: 8 }}>完整模型库（可用分组 / 全部 446 个 / 检测）暂用「打开原面板 ↗」。</p>}
    </div>
  )
}

/* ================= 用量页签 ================= */
function UsagePanel({ id, live }: { id: string; live: boolean }) {
  // workbuddy / qoder 走 SvcUsagePanel，cline 走 ClineUsagePanel，这里只剩 cmdgo
  const api = useSvcApi(id)
  const [data, setData] = useState<any>(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    let alive = true
    if (id !== 'cmdgo') return
    api('/api/usage').then((j) => { if (alive) { setData(j); setErr('') } }).catch((e) => alive && setErr(e instanceof Error ? e.message : String(e)))
    return () => { alive = false }
  }, [api, id])

  if (id !== 'cmdgo') {
    return (
      <div className="sect"><div className="empty"><b>用量页在 M3 已接入统一统计</b><span>见侧栏「统计」页（按服务的日序列与明细）。</span></div></div>
    )
  }
  const total = pick<any>(data, 'total')
  const days = pick<any[]>(data, 'days') ?? []
  return (
    <>
      {err && <div className="alertbar err"><span className="ico" /><span>{err}</span></div>}
      <div className="kpis">
        <div className="kpi"><h3>累计请求</h3><div className="v">{fmtInt(Number(pick(total, 'requests') ?? 0))}</div></div>
        <div className="kpi"><h3>输入 Tokens</h3><div className="v" style={{ fontSize: 22 }}>{fmtInt(Number(pick(total, 'prompt_tokens') ?? 0))}</div></div>
        <div className="kpi"><h3>输出 Tokens</h3><div className="v" style={{ fontSize: 22 }}>{fmtInt(Number(pick(total, 'completion_tokens') ?? 0))}</div></div>
        <div className="kpi"><h3>累计 Tokens</h3><div className="v" style={{ fontSize: 22 }}>{fmtInt(Number(pick(total, 'total_tokens') ?? 0))}</div></div>
      </div>
      <div className="sect" style={{ marginBottom: 0 }}>
        <div className="sect-head"><h3>按日明细</h3><span className="sub">只读补丁口径（usage.json 落盘于 ~/.cmdgo-bridge）</span></div>
        {days.length === 0 ? (
          <div className="empty"><b>还没有用量记录</b><span>每次成功的 chat 完成后自动记账。</span></div>
        ) : (
          <div className="tbox"><table>
            <thead><tr><th>日期</th><th className="num-r">请求</th><th className="num-r">输入</th><th className="num-r">输出</th><th className="num-r">合计</th></tr></thead>
            <tbody>
              {days.slice().reverse().map((d: any) => (
                <tr key={d.date}>
                  <td>{d.date}</td><td className="num-r">{fmtInt(Number(d.requests))}</td>
                  <td className="num-r">{fmtInt(Number(d.prompt_tokens))}</td>
                  <td className="num-r">{fmtInt(Number(d.completion_tokens))}</td>
                  <td className="num-r">{fmtInt(Number(d.total_tokens))}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </div>
    </>
  )
}

/* ================= 日志页签 ================= */
type LogLine = { ch: string; text: string; ts: string }

/* 两个服务的接口形状不同，别按同一套处理：
   - workbuddy GET /panel/api/logs → {entries:[{ts,ch,text}]}，**整环快照**（Ring.Snapshot，
     没有 after 参数），必须整段替换；当增量追加会每 3 秒把同一批再叠一遍。
   - qoder GET /panel/api/logs?after=N → {entries:[{id,ch,text,ts}]}，**增量**，
     用最后一条的 id 作为下次游标。
   频道取值两家都是 sys | task | chat（qoder 另有 worker）。 */
const LOG_CH_NAME: Record<string, string> = { sys: '系统', task: '任务', chat: '对话', worker: 'worker' }

function fmtLogLine(l: LogLine): string {
  const name = LOG_CH_NAME[l.ch] ?? l.ch
  return (name ? `[${name}] ` : '') + (l.ts ? l.ts + ' ' : '') + l.text
}

/** 日志行的时间戳：workbuddy 是 RFC3339、qoder 是 "09:23:11"；文本自带时间时不重复加。 */
function logTs(v: unknown, text: string): string {
  if (!v) return ''
  const s = String(v)
  if (/^\d{2}:\d{2}:\d{2}/.test(s)) return s.slice(0, 8)
  if (/^\d{4}[-/]\d{2}[-/]\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(text)) return ''
  const t = parseTs(v)
  if (t == null) return ''
  const d = new Date(t)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

function LogsPanel({ id, live }: { id: string; live: boolean }) {
  const api = useSvcApi(id)
  const [lines, setLines] = useState<LogLine[]>([])
  const [err, setErr] = useState('')
  const [ch, setCh] = useState('all')
  const [counts, setCounts] = useState<Record<string, number>>({})
  const boxRef = useRef<HTMLPreElement>(null)
  const [auto, setAuto] = useState(true)

  useEffect(() => {
    /* zen 也有 /panel/api/logs（内存环形缓冲，快照口径，与 workbuddy 同形）。 */
    if (!live || (id !== 'qoder' && id !== 'workbuddy' && id !== 'zen')) return
    let alive = true
    let after = 0
    async function poll() {
      try {
        const q = id === 'qoder' ? `?after=${after}` : ''
        const j = await api('/panel/api/logs' + q)
        const items: any[] = pick<any[]>(j, 'entries', 'logs', 'lines') ?? []
        const next: LogLine[] = items
          .map((l: any) =>
            typeof l === 'string'
              ? { ch: '', text: l, ts: '' }
              : {
                  ch: String(pick(l, 'ch', 'channel') ?? ''),
                  text: String(pick(l, 'text', 'message', 'line') ?? ''),
                  ts: logTs(pick(l, 'ts', 'time'), String(pick(l, 'text', 'message', 'line') ?? '')),
                },
          )
          .filter((l) => l.text)
        if (id === 'qoder') {
          // 增量：本次没带回新条目时保留已显示的内容
          if (next.length) {
            after = Number(pick(items[items.length - 1] ?? {}, 'id') ?? after) || after
            setLines((xs) => [...xs, ...next].slice(-800))
            setCounts((c) => {
              const n = { ...c }
              for (const l of next) n[l.ch] = (n[l.ch] ?? 0) + 1
              return n
            })
          }
        } else {
          // 快照：整环替换
          setLines(next.slice(-500))
          const n: Record<string, number> = {}
          for (const l of next) n[l.ch] = (n[l.ch] ?? 0) + 1
          setCounts(n)
        }
        setErr('')
      } catch (e) {
        alive && setErr(e instanceof Error ? e.message : String(e))
      }
    }
    poll()
    const t = setInterval(poll, 3000)
    return () => { alive = false; clearInterval(t) }
  }, [live, id, api])

  useEffect(() => {
    if (auto && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight
  }, [lines, auto])

  if (!live) return <NotRunning />
  if (id === 'cline') {
    return (
      <div className="sect" style={{ marginBottom: 0 }}>
        <div className="empty"><b>cline 的请求日志只存在内存里</b><span>原控制台从内存渲染（无历史接口）；统计页已有该服务的真实用量。完整日志视图暂用「打开原面板 ↗」。</span></div>
      </div>
    )
  }
  if (id === 'cmdgo') {
    return (
      <div className="sect" style={{ marginBottom: 0 }}>
        <div className="empty"><b>cmdgo 的访问日志在服务终端输出</b><span>管理事件（登录/账号/用量）见「用量」页与面板日志目录 data/logs/cmdgo.log。</span></div>
      </div>
    )
  }
  const shown = ch === 'all' ? lines : lines.filter((l) => l.ch === ch)
  const note = ch === 'all'
    ? `任务 ${counts.task ?? 0} · 对话 ${counts.chat ?? 0} · 系统 ${counts.sys ?? 0}${counts.worker ? ` · worker ${counts.worker}` : ''}`
    : `${LOG_CH_NAME[ch] ?? ch} ${shown.length} 行`
  /* zen 的日志频道是它自己的运行组件（startup / models / upstream / stream），
     与 workbuddy 的「任务 / 对话 / 系统」不是一套词汇：这里按行数报，也不摆那三个筛子。 */
  const zenLog = id === 'zen'
  return (
    <div className="sect" style={{ marginBottom: 0 }}>
      <div className="sect-head">
        <h3>运行日志</h3>
        <span className="sub">
          {zenLog
            ? `最近 500 行 · 3s 轮询 · 共 ${lines.length} 行`
            : id === 'qoder' ? `最近 800 行 · 3s 增量 · ${note}` : `最近 500 行 · 3s 轮询 · ${note}`}
        </span>
        <span className="sp" />
        {!zenLog && (
          <div className="seg">
            {['all', 'task', 'chat', 'sys'].map((k) => (
              <button key={k} className={k === ch ? 'on' : ''} onClick={() => setCh(k)}>
                {k === 'all' ? '全部' : LOG_CH_NAME[k]}
              </button>
            ))}
          </div>
        )}
        <button className="btn xs" onClick={() => setAuto(!auto)}>自动滚动：{auto ? '开' : '关'}</button>
      </div>
      {err && <div className="alertbar err"><span className="ico" /><span>{err}</span></div>}
      <pre className="logpre" ref={boxRef}>
        {shown.length === 0 ? (lines.length === 0 ? '暂无日志（服务刚启动或还没有产生记录）。' : '该频道暂无日志。') : shown.map(fmtLogLine).join('\n')}
      </pre>
    </div>
  )
}

/* 支持点号路径的取值：workbuddy 的配置是嵌套结构（schedule.checkin_enabled …），
   qoder/cline 是扁平的，两者共用这一组读写。 */
function pickPath(o: any, path: string): any {
  if (o == null) return undefined
  return path.split('.').reduce((acc: any, k) => (acc == null ? undefined : acc[k]), o)
}

/** 把 [[点号路径, 值]] 组装成嵌套对象；服务端是深度 merge，不会动同一层的其它键。 */
function nestPaths(pairs: [string, unknown][]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [path, v] of pairs) {
    const parts = path.split('.')
    let node: Record<string, unknown> = out
    for (let i = 0; i < parts.length - 1; i++) {
      const next = node[parts[i]]
      if (next && typeof next === 'object') {
        node = next as Record<string, unknown>
      } else {
        const fresh: Record<string, unknown> = {}
        node[parts[i]] = fresh
        node = fresh
      }
    }
    node[parts[parts.length - 1]] = v
  }
  return out
}

/* ================= 设置页签 ================= */

type FieldType = 'num' | 'bool' | 'text' | 'hours' | 'select' | 'model' | 'textarea'

interface CfgField {
  k: string // 配置里的真实路径（workbuddy 是嵌套的）
  label: string
  hint?: string
  type?: FieldType
  placeholder?: string
  options?: { v: string; label: string }[] // select 的静态选项
  /* 留空语义：默认「留空 = 不提交，保持原值」（workbuddy / qoder 的原面板行为）。
     置 allowEmpty 表示「留空是一次合法清空，要提交空串」——cline 的
     override_prompt（清掉覆盖、回到客户端自带 system）就是这种。 */
  allowEmpty?: boolean
  emptySkip?: boolean // 兼容旧写法，等价于默认行为（留空不提交）
}

interface CfgGroup {
  title: string
  note?: string
  fields: CfgField[]
}

/* 字段表照各服务原面板的配置页逐字搬（标签、提示、需重启标注都保留） */
const CFG_LAYOUT: Record<string, CfgGroup[]> = {
  workbuddy: [
    {
      title: '服务',
      fields: [
        { k: 'listen', label: '监听地址', placeholder: ':7863', hint: '改动需重启进程；改端口要同步改面板「设置 → 服务注册表」里的端口' },
        { k: 'api_key', label: 'API 密钥', placeholder: '留空 = 保持当前密钥', hint: '立即生效（含面板自身）；查看/复制在「接入」页签', emptySkip: true },
      ],
    },
    {
      title: '定时任务',
      fields: [
        { k: 'schedule.checkin_enabled', label: '自动签到', type: 'bool' },
        { k: 'schedule.checkin_hours', label: '签到时点（小时，逗号分隔）', type: 'hours', placeholder: '9, 21' },
        { k: 'schedule.keepalive_enabled', label: 'Token 保活', type: 'bool' },
        { k: 'schedule.keepalive_hours', label: '保活时点（小时，逗号分隔）', type: 'hours', placeholder: '22' },
        { k: 'schedule.travel_enabled', label: '猫猫旅行', type: 'bool' },
        { k: 'schedule.travel_hours', label: '旅行时点（小时，逗号分隔）', type: 'hours', placeholder: '9, 21', hint: '一趟派出 + 一趟领奖闭环' },
        { k: 'schedule.activity_enabled', label: '活跃上报', type: 'bool' },
        { k: 'schedule.activity_hours', label: '上报时点（小时，逗号分隔）', type: 'hours', placeholder: '10', hint: '点亮连登 + 解锁领养前置' },
        { k: 'schedule.balance_refresh_enabled', label: '后台刷新余额', type: 'bool' },
        { k: 'schedule.balance_refresh_minutes', label: '刷新间隔（分钟）', type: 'num', placeholder: '5' },
      ],
    },
    {
      title: '账号池与流量治理',
      fields: [
        { k: 'pool.max_in_flight', label: '单账号最大在途', type: 'num', hint: '0 = 不限制' },
        { k: 'pool.breaker_threshold', label: '连续失败熔断阈值', type: 'num' },
        { k: 'cooldown.soft_rate', label: '软限流冷却基数', placeholder: '600s' },
        { k: 'cooldown.soft_rate_max', label: '软冷却退避上限', placeholder: '2h' },
        { k: 'pool.breaker_cooldown', label: '熔断基础时长', placeholder: '30m' },
        { k: 'pool.breaker_cooldown_max', label: '熔断退避上限', placeholder: '6h' },
        { k: 'pool.idle_weight_per_hour', label: '闲置补偿 / 小时', type: 'num', placeholder: '0.5' },
        { k: 'pool.idle_weight_max', label: '闲置补偿上限', type: 'num', placeholder: '5' },
        { k: 'session_sticky.ttl', label: '会话粘性 TTL', placeholder: '30m', hint: '改动需重启进程' },
      ],
    },
    {
      title: '上游与高级',
      note: '统计按自然日聚合并落盘，供「用量」页出趋势与排行',
      fields: [
        { k: 'upstream.timeout_seconds', label: '短请求超时（秒）', type: 'num', hint: '需重启' },
        { k: 'upstream.header_timeout_seconds', label: '聊天首字节超时（秒）', type: 'num', hint: '需重启' },
        { k: 'upstream.idle_timeout_seconds', label: '流空闲超时（秒）', type: 'num', hint: '需重启' },
        { k: 'server.max_body_mb', label: '请求体上限（MB）', type: 'num', hint: '多图会话可调大；需重启' },
        { k: 'upstream.user_agent', label: '出站 User-Agent', placeholder: '留空 = CLI/2.63.2 CodeBuddy/2.63.2', hint: '影响官网积分记录「使用端」显示；需重启' },
        {
          k: 'prompt.mode',
          label: '系统提示词模式',
          type: 'select',
          hint: '需重启',
          options: [
            { v: 'custom', label: 'custom — 网关自有提示词（避免指纹误报）' },
            { v: 'passthrough', label: 'passthrough — 透传客户端原始 system' },
          ],
        },
        { k: 'prompt.file', label: '提示词文件路径', placeholder: '留空 = 内置默认提示词', hint: '需重启' },
        { k: 'features.sanitize_blacklist_fingerprints', label: '出站请求指纹脱敏', type: 'bool' },
        { k: 'session_sticky.enabled', label: '会话粘性路由', type: 'bool' },
        { k: 'stats.enabled', label: '按天用量统计', type: 'bool' },
        { k: 'stats.keep_days', label: '统计保留天数', type: 'num', hint: '改动需重启进程' },
      ],
    },
  ],
  qoder: [
    {
      title: '账号池与流量治理',
      fields: [
        { k: 'max_in_flight', label: '单账号最大在途', type: 'num' },
        { k: 'max_retry_accounts', label: '单请求轮换账号数', type: 'num' },
        { k: 'cooldown_soft_seconds', label: '限流冷却基数（秒）', type: 'num' },
        { k: 'session_sticky', label: '会话粘性路由', type: 'bool' },
        { k: 'stats_enabled', label: '按天用量统计', type: 'bool' },
        { k: 'stats_keep_days', label: '统计保留天数', type: 'num' },
      ],
    },
    {
      title: '上游',
      fields: [{ k: 'proxy_url', label: '出站代理', placeholder: '留空 = 直连', hint: '传给每账号 worker；立即对新建连接生效' }],
    },
  ],
  cline: [
    {
      title: '调度',
      fields: [
        {
          k: 'strategy',
          label: '轮换策略',
          type: 'select',
          options: [
            { v: 'round_robin', label: 'round_robin — 逐个轮换（默认）' },
            { v: 'fill', label: 'fill — 先用满一个号，再换下一个' },
            { v: 'random', label: 'random — 随机挑一个' },
          ],
        },
        { k: 'cooldown_minutes', label: '冷却兜底时长（分钟）', type: 'num', hint: '只在上游没有给出重置时间时使用；1–1440，0 = 恢复默认 30' },
        { k: 'default_model', label: '默认模型', type: 'model', hint: '只能选「已启用」的模型' },
      ],
    },
    {
      title: 'system prompt 覆盖',
      note: '填了就替换客户端传来的 system 消息',
      fields: [{ k: 'override_prompt', label: '覆盖内容', type: 'textarea', placeholder: '留空 = 用客户端自己的 system 提示', allowEmpty: true, hint: '清空并保存 = 撤销覆盖，回到客户端自带 system' }],
    },
  ],
  zen: [
    {
      title: '上游与模型目录',
      note: '匿名免费通道：没有账号池与积分口径，免费额度按出口 IP 限流',
      fields: [
        { k: 'upstream.zen', label: '上游基址', placeholder: 'https://opencode.ai/zen', hint: '正式运行不要改；需重启' },
        { k: 'models.refresh_seconds', label: '实时目录刷新间隔（秒）', type: 'num', hint: '需重启' },
        { k: 'models.metadata_refresh_hours', label: '免费判定元数据刷新（小时）', type: 'num', hint: '需重启' },
        { k: 'models.metadata_cache_days', label: '元数据缓存有效期（天）', type: 'num', hint: '超过后暂时退回按名称判断免费' },
      ],
    },
    {
      title: '限额与超时',
      note: '「模型排除名单」（models.exclude）没有在线编辑：它是字符串数组，直接改服务目录下的 config.json',
      fields: [
        { k: 'limits.request_body_mb', label: '请求体上限（MB）', type: 'num' },
        { k: 'limits.request_timeout_seconds', label: '非流式整体超时（秒）', type: 'num' },
        { k: 'limits.header_timeout_seconds', label: '首字节等待上限（秒）', type: 'num', hint: '冷启动慢的模型可调大' },
        { k: 'limits.body_idle_seconds', label: '流静默断开阈值（秒）', type: 'num' },
        { k: 'limits.max_retries', label: '上游失败重试次数', type: 'num', hint: '需重启' },
      ],
    },
  ],
}

function SettingsPanel({ id, live, onGoAccess }: { id: string; live: boolean; onGoAccess: () => void }) {
  const api = useSvcApi(id)
  const [cfg, setCfg] = useState<any>(null)
  const [err, setErr] = useState('')
  const [modelOpts, setModelOpts] = useState<{ v: string; label: string }[]>([])
  const [hdr, setHdr] = useState<{ k: string; v: string }[]>([])
  const [hdrDefaults, setHdrDefaults] = useState<Record<string, string>>({})

  const groups = CFG_LAYOUT[id] ?? []
  const paths: Record<string, string> = { qoder: '/panel/api/config', workbuddy: '/panel/api/config', zen: '/panel/api/config', cline: '/v1/config' }

  const load = useCallback(async () => {
    try {
      const j = await api(paths[id])
      // workbuddy 回 {ok, path, config:{…}}（配置包了一层）；qoder/cline 是平铺的
      setCfg(j && typeof j.config === 'object' && j.config !== null ? j.config : j)
      if (id === 'cline') {
        const opts = (j.default_model_options ?? []) as { id: string; name?: string }[]
        setModelOpts(opts.map((o) => ({ v: o.id, label: o.name && o.name !== o.id ? `${o.name}（${o.id}）` : o.id })))
        const def = (j.default_headers ?? {}) as Record<string, string>
        const cur = (j.headers ?? {}) as Record<string, string>
        setHdrDefaults(def)
        setHdr(Object.entries({ ...def, ...cur }).map(([k, v]) => ({ k, v: String(v) })))
      }
      setErr('')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, id])

  useEffect(() => { if (live) void load() }, [live, load])

  // 密钥与调用方式不在这里：给一个直达入口（找密钥的人先来的就是设置页）
  const hint = (
    <div className="acc-hint">
      <span>API Key、Base URL 和可直接粘贴的调用代码在「接入」页签</span>
      <span style={{ flex: 1 }} />
      <button className="btn xs" onClick={onGoAccess}>打开「接入」→</button>
    </div>
  )

  async function save() {
    const pairs: [string, unknown][] = []
    const changed: string[] = []
    for (const g of groups) {
      for (const f of g.fields) {
        const el = document.querySelector<HTMLElement>(`[data-cfg="${f.k}"]`)
        if (!el) continue
        let next: unknown
        if (f.type === 'bool') {
          next = el.dataset.value === 'true'
        } else {
          const v = (el as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value
          /* 留空语义**逐服务不同**，不能一刀切：
             - workbuddy 的 collectConfig 是「空值一律不提交（保持原值）」；
               若照常提交，Number('') 会把「单账号最大在途」写成 0，而 0 在这里
               是有意义的取值（不限制）——等于用户一清空就把配置改坏了。
             - cline 的 saveSettings 直接提交输入框值，override_prompt 留空
               是**合法清空**（原面板还会提示「已清空覆盖值」），清空会被吞掉。
             - qoder 的字段没有「清空即合法」的语义，与 workbuddy 同样处理。
             字段可用 `allowEmpty: true` 单独声明「留空要提交」。 */
          if (v.trim() === '' && !f.allowEmpty) continue
          if (f.type === 'num') next = Number(v)
          else if (f.type === 'hours') next = v.split(',').map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n))
          else next = v
        }
        const orig = pickPath(cfg, f.k)
        const same =
          Array.isArray(orig) && Array.isArray(next)
            ? orig.join(',') === next.join(',')
            : String(orig ?? '') === String(next ?? '')
        if (!same) changed.push(f.k)
        pairs.push([f.k, next])
      }
    }
    const body: Record<string, unknown> = nestPaths(pairs)
    if (id === 'cline') {
      // 请求头整组替换：空值行不生效，等价于删掉那个头
      const obj: Record<string, string> = {}
      for (const r of hdr) if (r.k.trim() && r.v.trim()) obj[r.k.trim()] = r.v
      body.headers = obj
      body.replace_headers = true
    }
    try {
      const res = await api(paths[id], { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      // 服务返回的 restart_required 是一份固定清单，只报「这次真改了、且确实要重启」的字段
      const rr: string[] = Array.isArray(res?.restart_required) ? res.restart_required : []
      const needRestart = rr.filter((k) => changed.includes(k))
      if (needRestart.length > 0) {
        toast(`配置已保存；${needRestart.join('、')} 需重启进程才生效`, 'ok')
      } else if (changed.length > 0) {
        toast('配置已保存并生效', 'ok')
      } else {
        toast('配置已保存（没有改动）', 'ok')
      }
      void load()
    } catch (e) {
      toast('保存失败：' + (e instanceof Error ? e.message : String(e)), 'err')
    }
  }

  if (!live) return <>{hint}<NotRunning /></>
  if (id === 'cmdgo') {
    return (
      <>
        {hint}
        <div className="sect" style={{ marginBottom: 0 }}>
          <div className="empty">
            <b>cmdgo 没有可在线编辑的配置项</b>
            <span>它的配置在 ~/.cmdgo-bridge/config.json（端口/密钥等），原面板也只做展示不做编辑；调用方式见「接入」页签。</span>
          </div>
        </div>
      </>
    )
  }
  if (err) return <>{hint}<div className="alertbar err"><span className="ico" /><span>读取失败：{err}</span></div></>
  if (!cfg) return <>{hint}<div className="loading">读取中…</div></>

  return (
    <>
      {hint}
      {groups.map((g) => (
        <div className="sect" key={g.title}>
          <div className="sect-head">
            <h3>{g.title}</h3>
            {g.note && <span className="sub" style={{ fontSize: 11.5 }}>{g.note}</span>}
          </div>
          <div className="cfggrid">
            {g.fields.map((f) => (
              <CfgItem key={f.k} f={f} cfg={cfg} modelOpts={modelOpts} />
            ))}
          </div>
        </div>
      ))}

      {id === 'cline' && (
        <div className="sect">
          <div className="sect-head">
            <h3>自定义请求头</h3>
            <span className="sp" />
            <button className="btn xs" onClick={() => setHdr(Object.entries(hdrDefaults).map(([k, v]) => ({ k, v })))}>恢复默认</button>
            <button className="btn xs" onClick={() => setHdr((xs) => [...xs, { k: '', v: '' }])}>＋ 添加一行</button>
          </div>
          <p className="muted" style={{ fontSize: 12, margin: '0 0 10px' }}>
            上游靠这些头识别「是不是 Cline 客户端」，<b>改动有风险</b>：填错会被 403（only available via Cline product surfaces）。
            留空的行不生效；保存时整组替换。
          </p>
          <div className="hdrrows">
            {hdr.map((r, i) => (
              <div className="hdrrow" key={i}>
                <input
                  value={r.k}
                  placeholder="头名"
                  onChange={(e) => setHdr((xs) => xs.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)))}
                />
                <input
                  value={r.v}
                  placeholder="值"
                  onChange={(e) => setHdr((xs) => xs.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)))}
                />
                <button className="btn xs ghost" onClick={() => setHdr((xs) => xs.filter((_, j) => j !== i))}>删除</button>
              </div>
            ))}
            {hdr.length === 0 && <div className="faint" style={{ fontSize: 12 }}>当前没有请求头（上游会用内置默认）。</div>}
          </div>
        </div>
      )}

      <div className="sect" style={{ marginBottom: 0 }}>
        <div className="cfg-save">
          <span className="faint" style={{ fontSize: 11.5 }}>保存写入服务配置文件；标注「需重启」的项要重启该服务后才生效</span>
          <span style={{ flex: 1 }} />
          <button className="btn ghost" onClick={() => void load()}>放弃修改</button>
          <button className="btn pri" onClick={() => void save()}>保存配置</button>
        </div>
      </div>
    </>
  )
}

function CfgItem({ f, cfg, modelOpts }: { f: CfgField; cfg: any; modelOpts: { v: string; label: string }[] }) {
  const raw = pickPath(cfg, f.k)
  const str = (v: unknown) => (v == null ? '' : String(v))

  if (f.type === 'bool') {
    const on = Boolean(raw)
    return (
      <div className="cfgitem">
        <div className="cfgrow">
          <span className="lb">{f.label}</span>
          <button
            type="button"
            className="sw"
            role="switch"
            aria-checked={on}
            data-cfg={f.k}
            data-value={String(on)}
            onClick={(e) => {
              const next = e.currentTarget.getAttribute('aria-checked') !== 'true'
              e.currentTarget.setAttribute('aria-checked', String(next))
              e.currentTarget.dataset.value = String(next)
            }}
          />
        </div>
        {f.hint && <span className="hint">{f.hint}</span>}
      </div>
    )
  }

  return (
    <div className={`cfgitem${f.type === 'textarea' ? ' wide' : ''}`}>
      <span className="lb">{f.label}</span>
      {f.type === 'select' ? (
        <select data-cfg={f.k} defaultValue={str(raw)}>
          {(f.options ?? []).map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
        </select>
      ) : f.type === 'model' ? (
        <select data-cfg={f.k} defaultValue={str(raw)}>
          {/* 当前值可能已不在启用列表里（比如刚被移除），仍保留一项，避免保存时被悄悄改掉 */}
          {raw && !modelOpts.some((o) => o.v === str(raw)) && <option value={str(raw)}>{str(raw)}（当前）</option>}
          {modelOpts.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
        </select>
      ) : f.type === 'textarea' ? (
        <textarea data-cfg={f.k} rows={6} defaultValue={str(raw)} placeholder={f.placeholder} />
      ) : (
        <input
          type="text"
          data-cfg={f.k}
          defaultValue={f.emptySkip ? '' : f.type === 'hours' && Array.isArray(raw) ? raw.join(',') : str(raw)}
          placeholder={f.placeholder}
        />
      )}
      {f.hint && <span className="hint">{f.hint}</span>}
    </div>
  )
}
