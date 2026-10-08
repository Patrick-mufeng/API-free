/* 总览（指挥台）
   布局：6 格 KPI 统计带 → 四张服务细线卡 → 用量趋势(7) + 时段分布(5) → 排行(4) + 服务质量(4) + 面板事件(4) → 接入入口/口径信息带
   全部数据来自面板接口（/api/services、/api/stats、/api/svcinfo、/api/events），
   取不到就显示「—」，不用示例数字兜底。 */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { AreaChart, Badge, PageHead, Segmented, Switch, toast } from '../components/ui'
import { ServiceGlyph } from '../components/ServiceIcons'
import {
  ctlService,
  fetchClineStatus,
  fetchEvents,
  fetchServices,
  fetchStats,
  fetchSvcInfo,
  fetchSvcStats,
  type ClineStatus,
  type PanelEvent,
  type StatsData,
  type SvcCard,
  type SvcInfo,
  type SvcStats,
} from '../api'
import { toViews, type SvcView } from '../data/services'
import { fmtInt, fmtTok } from '../data/format'

type Mode = 'all' | 'split'

/* 行内迷你趋势：30 天阶梯面积。
   窄格里画 31 根柱每根只有 1px 多，细到读不出趋势；阶梯面积能一眼看出
   「一直是 0、最后两天起来」。无文字，所以可以用 preserveAspectRatio="none" 拉伸。 */
function Spark({ vals, color }: { vals: number[]; color: string }) {
  if (vals.length < 2) return null
  const max = Math.max(1, ...vals)
  const step = 100 / vals.length
  const y = (v: number) => (20 - (v / max) * 17).toFixed(2)
  let line = `M0 ${y(vals[0])}`
  vals.forEach((v, i) => {
    const x0 = (i * step).toFixed(2)
    const x1 = ((i + 1) * step).toFixed(2)
    line += `L${x0} ${y(v)}L${x1} ${y(v)}`
  })
  const flat = max <= 1
  return (
    <svg className="spark" viewBox="0 0 100 22" preserveAspectRatio="none" aria-hidden>
      <path d={`${line}L100 22L0 22Z`} fill={flat ? 'var(--line)' : color} opacity={flat ? 1 : 0.32} />
      <path
        d={line}
        fill="none"
        stroke={flat ? 'var(--line)' : color}
        strokeWidth="1.4"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}

export function OverviewPage({ onOpenService }: { onOpenService: (id: string) => void }) {
  const [svcs, setSvcs] = useState<SvcView[]>([])
  const [mode, setMode] = useState<Mode>('all')
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [pending, setPending] = useState<Record<string, 'start' | 'stop'>>({})
  const pendingRef = useRef(pending)
  pendingRef.current = pending

  /* 统计（60s） */
  const [stats, setStats] = useState<StatsData | null>(null)
  /* 服务自身的细粒度统计：只有 workbuddy 提供「按模型 / 按账号 / 小时粒度 / 延迟 / 成功率」，
     cline 提供账号级累计。取不到就整块显示「该服务无此口径」，不做兜底数字。 */
  const [wb30, setWb30] = useState<SvcStats | null>(null)
  const [wbToday, setWbToday] = useState<SvcStats | null>(null)
  const [cline, setCline] = useState<ClineStatus | null>(null)
  useEffect(() => {
    let alive = true
    const load = () => {
      fetchStats(30).then((d) => { if (alive) setStats(d) }).catch(() => { if (alive) setStats(null) })
      fetchSvcStats('workbuddy', '30d').then((d) => { if (alive) setWb30(d) }).catch(() => { if (alive) setWb30(null) })
      fetchSvcStats('workbuddy', 'today').then((d) => { if (alive) setWbToday(d) }).catch(() => { if (alive) setWbToday(null) })
      fetchClineStatus().then((d) => { if (alive) setCline(d) }).catch(() => { if (alive) setCline(null) })
    }
    load()
    const t = setInterval(load, 60000)
    return () => { alive = false; clearInterval(t) }
  }, [])

  /* 跨服务运行时信息（15s） */
  const [info, setInfo] = useState<SvcInfo | null>(null)
  useEffect(() => {
    let alive = true
    const load = () => fetchSvcInfo().then((d) => { if (alive) setInfo(d) }).catch(() => { if (alive) setInfo(null) })
    load()
    const t = setInterval(load, 15000)
    return () => { alive = false; clearInterval(t) }
  }, [])

  /* 面板事件（15s） */
  const [events, setEvents] = useState<PanelEvent[]>([])
  useEffect(() => {
    let alive = true
    const load = () => fetchEvents().then((e) => { if (alive) setEvents(e) }).catch(() => { if (alive) setEvents([]) })
    load()
    const t = setInterval(load, 15000)
    return () => { alive = false; clearInterval(t) }
  }, [])

  /* 进程状态（3s），启停走真 API */
  useEffect(() => {
    let alive = true
    async function poll() {
      try {
        const snap = await fetchServices()
        if (!alive) return
        const next = toViews(snap)
        setSvcs((xs) =>
          next.map((s) => {
            const prev = xs.find((x) => x.id === s.id)
            if (prev && pendingRef.current[s.id]) return { ...s, status: prev.status, lastError: prev.lastError }
            return s
          }),
        )
      } catch {
        /* 面板后端不可达：保留上次快照，不清空 */
      }
    }
    poll()
    const t = setInterval(poll, 3000)
    return () => { alive = false; clearInterval(t) }
  }, [])

  function applySnap(list: { id: string; status: string; lastError?: string }[]) {
    setSvcs((xs) =>
      xs.map((s) => {
        const r = list.find((x) => x.id === s.id)
        if (!r) return s
        return { ...s, status: r.status === 'starting' ? 'booting' : r.status === 'running' ? 'running' : 'stopped', lastError: r.lastError || undefined }
      }),
    )
  }

  async function doStart(s: SvcView) {
    setPending((p) => ({ ...p, [s.id]: 'start' }))
    setSvc(s.id, { status: 'booting' })
    try {
      applySnap(await ctlService(s.id, 'start'))
      toast(`${s.name} 启动指令已下发`, 'ok')
    } catch (e) {
      setSvc(s.id, { status: 'stopped' })
      toast(`${s.name} 启动失败：${e instanceof Error ? e.message : e}`, 'err')
    } finally {
      setPending((p) => { const n = { ...p }; delete n[s.id]; return n })
    }
  }

  async function doStop(s: SvcView) {
    setConfirmId(null)
    setPending((p) => ({ ...p, [s.id]: 'stop' }))
    try {
      applySnap(await ctlService(s.id, 'stop'))
      toast(`${s.name} 已停止`)
    } catch (e) {
      toast(`${s.name} 停止失败：${e instanceof Error ? e.message : e}`, 'err')
    } finally {
      setPending((p) => { const n = { ...p }; delete n[s.id]; return n })
    }
  }

  function setSvc(id: string, patch: Partial<SvcView>) {
    setSvcs((xs) => xs.map((s) => (s.id === id ? { ...s, ...patch } : s)))
  }
  function toggle(s: SvcView) {
    if (s.status === 'running') setConfirmId(s.id)
    else void doStart(s)
  }

  /* ---------- 派生 ---------- */
  const accent = '#16181a'
  const active = svcs.filter((s) => s.status !== 'stopped')
  const stopped = svcs.filter((s) => s.status === 'stopped')
  const cardOf = (id: string): SvcCard | undefined => info?.services.find((c) => c.svc === id)
  const nameOf = (id: string) => svcs.find((s) => s.id === id)?.name ?? id

  const todayRow = stats?.days?.[stats.days.length - 1]
  function todayOf(id: string): { in: number; out: number; tok: number; reqs: number } | null {
    const e = todayRow?.services?.[id]
    if (!e) return null
    return { in: e.input ?? 0, out: e.output ?? 0, tok: (e.input ?? 0) + (e.output ?? 0), reqs: e.reqs ?? 0 }
  }
  const perSvcSeries = (id: string) => (stats?.days ?? []).map((d) => { const e = d.services[id]; return e ? e.input + e.output : 0 })

  const realDays = stats?.days
  const prevRow = realDays && realDays.length > 1 ? realDays[realDays.length - 2] : undefined
  const labels = realDays ? realDays.map((d) => d.date.slice(5)) : []
  const series =
    mode === 'all'
      ? [{ name: 'all', color: accent, data: realDays ? realDays.map((d) => d.total.input + d.total.output) : [] }]
      : svcs.map((s) => ({
          name: s.name,
          color: s.color,
          data: realDays ? realDays.map((d) => { const e = d.services[s.id]; return e ? e.input + e.output : 0 }) : [],
        }))
  const reqData = mode === 'all' ? realDays?.map((d) => d.total.reqs) : undefined
  const startIdx = realDays?.findIndex((d) => d.total.input + d.total.output + d.total.reqs > 0) ?? -1

  /* 30 天合计（由真实逐日汇总，不新造口径） */
  const t30 = (realDays ?? []).reduce(
    (a, d) => ({ tok: a.tok + d.total.input + d.total.output, reqs: a.reqs + d.total.reqs }),
    { tok: 0, reqs: 0 },
  )
  const todayTok = stats ? stats.today.input + stats.today.output : null
  const prevTok = prevRow ? prevRow.total.input + prevRow.total.output : null
  const delta = todayTok != null && prevTok != null && prevTok > 0 ? Math.round(((todayTok - prevTok) / prevTok) * 100) : null
  const inOut = stats && stats.today.output > 0 ? stats.today.input / stats.today.output : null

  /* 异常提醒：服务离线 / 操作失败 / 冷却（全部来自真实接口） */
  const alertItems: { kind: 'err' | 'warn'; node: ReactNode }[] = [
    ...stopped.map((s) => ({ kind: 'err' as const, node: <><b>{s.name} 未运行</b></> })),
    ...svcs.filter((s) => s.lastError).map((s) => ({ kind: 'err' as const, node: <><b>{s.name}</b> 上次操作失败：{s.lastError}</> })),
    ...(info?.alerts ?? []).map((a) => ({ kind: 'warn' as const, node: <><b>{nameOf(a.svc)} {a.text}</b></> })),
  ]
  const hasErr = alertItems.some((a) => a.kind === 'err')

  const coolSub = (() => {
    if (!info) return '运行时信息接口未连接'
    const miss = info.cooling.filter((c) => !c.ok)
    const noPk = miss.filter((c) => c.err === '该服务没有冷却口径')
    const unknown = miss.filter((c) => c.err !== '该服务没有冷却口径')
    const okN = info.cooling.length - miss.length
    const parts: string[] = []
    if (okN > 0) parts.push(`${okN} 家已接入`)
    if (noPk.length > 0) parts.push(`${noPk.map((m) => nameOf(m.svc)).join('、')} 无此口径`)
    if (unknown.length > 0) parts.push(`${unknown.map((m) => nameOf(m.svc)).join('、')} 未取到`)
    return parts.join(' · ') || '没有可统计的服务'
  })()
  const coolTitle = (info?.cooling ?? []).map((c) => `${nameOf(c.svc)}：${c.ok ? `${c.n} 个${c.unit}` : c.err || '未接入'}`).join('\n')

  const recentEvents = events.slice(-8).reverse()

  /* 时段分布：workbuddy 的 range=today 是小时粒度，series 是 00..23 共 24 桶 */
  const hourly = wbToday?.unit === 'hour' ? wbToday.series : []
  const hourlyMax = Math.max(1, ...hourly.map((h) => h.total_tokens ?? 0))

  /* 按模型排行（workbuddy 30 天）；按账号排行 = workbuddy 账号 + cline 账号 */
  const byModel = (wb30?.by_model ?? [])
    .slice()
    .sort((a, b) => (b.total_tokens ?? 0) - (a.total_tokens ?? 0))
  const byAcct = [
    ...(wb30?.by_account ?? []).map((a) => ({ id: 'workbuddy', key: a.label || a.key.slice(0, 8), tok: a.total_tokens ?? 0 })),
    ...(cline?.account_details ?? []).map((a) => ({ id: 'cline', key: a.email.replace(/@.*$/, ''), tok: a.usage?.total ?? 0 })),
  ].sort((a, b) => b.tok - a.tok)

  /* 服务质量：成功/失败/延迟都取各服务自身口径，缺项显示「—」，
     不跨服务硬凑一个总数（口径不同，加在一起是假的）。 */
  const clineOk = cline?.account_details?.reduce((a, x) => a + (x.stats?.ok ?? 0), 0)
  const clineFail = cline?.account_details?.reduce((a, x) => a + (x.stats?.fail ?? 0), 0)
  interface Q { id: string; ok: number | null; fail: number | null; rate: number | null; latency: number | null; tps: number | null }
  const quality: Q[] = [
    {
      id: 'workbuddy',
      ok: wb30?.totals.requests != null ? Math.max(0, (wb30.totals.requests ?? 0) - (wb30.totals.failed ?? 0)) : null,
      fail: wb30?.totals.failed ?? null,
      rate: wb30?.totals.success_rate ?? null,
      latency: wb30?.totals.avg_latency_ms ?? null,
      tps: wb30?.totals.avg_tokens_per_sec ?? null,
    },
    {
      id: 'cline',
      ok: clineOk ?? null,
      fail: clineFail ?? null,
      rate: clineOk != null && clineFail != null && clineOk + clineFail > 0 ? clineOk / (clineOk + clineFail) : null,
      latency: null,
      tps: null,
    },
    { id: 'qoder', ok: null, fail: null, rate: null, latency: null, tps: null },
    { id: 'cmdgo', ok: null, fail: null, rate: null, latency: null, tps: null },
  ]

  function statusBadge(s: SvcView, pendingStop: boolean) {
    return (
      <Badge kind={pendingStop ? 'boot' : s.status === 'running' ? 'run' : s.status === 'booting' ? 'boot' : 'stop'}>
        {pendingStop ? '停止中…' : s.status === 'running' ? '运行中' : s.status === 'booting' ? '启动中…' : '已停止'}
      </Badge>
    )
  }

  return (
    <div className="wrap">
      <PageHead title="总览" sub="服务状态 · 用量趋势 · 面板事件">
        <span className="faint" style={{ fontSize: 11.5 }}>状态 3s · 运行时 15s · 统计 60s 自动刷新</span>
      </PageHead>

      {alertItems.length > 0 && (
        <div className={`alertbar${hasErr ? ' err' : ''}`}>
          <span className="ico" />
          <span>
            {alertItems.map((a, i) => (
              <span key={i}>
                {i > 0 && ' · '}
                {a.node}
              </span>
            ))}
          </span>
        </div>
      )}

      {/* 统计带：6 格连成一条，格间竖细线 */}
      <div className="stat6">
        <div className="kpi">
          <h3>今日 Tokens</h3>
          <div className="v">{todayTok != null ? fmtTok(todayTok) : '—'}</div>
          <div className={`d${delta != null && delta >= 0 ? ' up' : ''}`}>
            {delta != null ? `${delta >= 0 ? '+' : ''}${delta}% 较昨日 ${fmtTok(prevTok ?? 0)}` : stats ? '无昨日数据' : '统计接口未连接'}
          </div>
        </div>
        <div className="kpi">
          <h3>今日请求</h3>
          <div className="v">{stats ? fmtInt(stats.today.reqs) : '—'}</div>
          <div className="d">{stats && stats.today.reqs > 0 ? `平均 ${Math.round((todayTok ?? 0) / stats.today.reqs)} tok / 次` : '各服务自身口径合计'}</div>
        </div>
        <div className="kpi">
          <h3>输入 / 输出</h3>
          <div className="v">
            {stats ? fmtTok(stats.today.input) : '—'}
            <span className="faint" style={{ fontSize: 13, fontFamily: 'var(--font-sans)' }}> / {stats ? fmtTok(stats.today.output) : '—'}</span>
          </div>
          <div className="d">{inOut != null ? `比值 ${inOut.toFixed(2)}` : '无输出数据'}</div>
        </div>
        <div className="kpi">
          <h3>活跃服务</h3>
          <div className="v">{svcs.length === 0 ? '—' : `${active.length} / ${svcs.length}`}</div>
          <div className="d">{svcs.length === 0 ? '读取中…' : stopped.length === 0 ? '全部运行中' : stopped.map((s) => s.name).join('、') + ' 已停止'}</div>
        </div>
        <div className="kpi">
          <h3>冷却中</h3>
          <div className="v">{info ? info.total : '—'}</div>
          <div className="d" title={coolTitle}>{coolSub}</div>
        </div>
        <div className="kpi">
          <h3>30 天合计</h3>
          <div className="v">{stats ? fmtTok(t30.tok) : '—'}</div>
          <div className="d">{stats ? `${fmtInt(t30.reqs)} 次请求` : '统计接口未连接'}</div>
        </div>
      </div>

      {/* ---------- 服务：四张细线卡 ---------- */}
      <div className="svcards">
        {svcs.map((s) => {
          const c = cardOf(s.id)
          const t = todayOf(s.id)
          const stoppedNow = s.status === 'stopped'
          const pendingStop = pending[s.id] === 'stop'
          const stText = pendingStop ? '停止中' : s.status === 'running' ? '运行中' : s.status === 'booting' ? '启动中' : '已停止'
          const stKind = pendingStop ? 'boot' : s.status === 'running' ? 'run' : s.status === 'booting' ? 'boot' : 'stop'
          const acct = !c || !c.ok
            ? (c?.err ?? '未取到')
            : c.accounts == null
              ? '无账号池'
              : c.accounts === 0
                ? (s.id === 'cmdgo' ? '未授权 · 需 OAuth' : '未登录 · 需设备授权')
                : `${c.accounts} 个 · 可用 ${c.healthy ?? '—'} · 冷却 ${c.cooling ?? 0}`
          const credit = c?.credits ? `${fmtInt(c.credits.remaining)} / ${fmtInt(c.credits.total)}` : '—'
          const tasks = (c?.tasks ?? []).map((x) => `${x.name === '开学季' ? '活动' : '任务'} ${x.done}/${x.total}`)
          return (
            <section key={s.id} className={`scard${stoppedNow ? ' off' : ''}`}>
              {/* 身份行 */}
              <div className="sc-head">
                <ServiceGlyph id={s.id} size={28} />
                <div className="sc-id">
                  <b>{s.name}</b>
                  <span className={`sc-st ${stKind}`}>
                    <i />{stText}
                    <em className="faint">· {s.port} · {s.managed ? '面板托管' : '外部实例'}{s.restarts > 0 ? ` · 重启 ${s.restarts}` : ''}</em>
                  </span>
                </div>
                <Switch
                  checked={!stoppedNow}
                  disabled={s.status === 'booting' || pendingStop}
                  onChange={() => toggle(s)}
                  label={`${s.name} 开关`}
                />
              </div>

              {/* 数字行：今日用量当主角，迷你曲线同排 */}
              <div className="sc-fig">
                <div className="sc-num">
                  <div className="v">
                    {stoppedNow ? '—' : t && t.tok > 0 ? fmtTok(t.tok) : t ? '0' : '—'}
                    {!stoppedNow && t && t.tok > 0 && <span className="u">tok</span>}
                  </div>
                  <div className="s">
                    {stoppedNow ? '已停止，不产生用量'
                      : !stats ? '统计接口未连接'
                      : t && t.tok > 0 ? `今日用量 · ${fmtInt(t.reqs)} 次请求`
                      : '今日暂无用量'}
                  </div>
                </div>
                <div className="sc-spark" title="近 30 天逐日用量">
                  <Spark vals={perSvcSeries(s.id)} color={s.color} />
                </div>
              </div>

              {/* 库存行：四格固定，缺项显示「—」 */}
              <dl className="sc-meta">
                <div><dt>账号</dt><dd>{acct}</dd></div>
                <div><dt>积分</dt><dd>{credit}</dd></div>
                <div><dt>模型</dt><dd>{c?.models == null ? '—' : `${c.models} 个可调度`}</dd></div>
                <div><dt>任务</dt><dd>{tasks.length > 0 ? tasks.join(' · ') : '—'}</dd></div>
              </dl>

              {s.lastError && <div className="code b sc-err" title={s.lastError}>{s.lastError}</div>}
              {confirmId === s.id && (
                <div className="sc-confirm">
                  <span className="faint">停止后进行中的请求会失败。</span>
                  <span style={{ flex: 1 }} />
                  <button className="btn ghost xs" onClick={() => setConfirmId(null)}>取消</button>
                  <button className="btn dgr xs" onClick={() => doStop(s)}>确认停止</button>
                </div>
              )}

              <div className="sc-foot">
                <a className="enterlink" href="#" onClick={(e) => { e.preventDefault(); onOpenService(s.id) }}>
                  进入服务 →
                </a>
              </div>
            </section>
          )
        })}
        {svcs.length === 0 && (
          <div className="sect" style={{ gridColumn: '1 / -1' }}>
            <div className="empty"><b>读不到服务列表</b><span>面板后端未连接，或注册表为空。</span></div>
          </div>
        )}
      </div>
      <p className="ovnote faint">开关＝真·进程启停；面板托管的服务崩溃会指数退避自动拉起。卡片右侧曲线为其 30 天逐日用量。</p>

      <div className="grid12 rowgap">
        {/* ---------- 用量趋势 ---------- */}
        <section className="sect s7">
          <div className="sect-head">
            <h3>用量趋势</h3>
            <span className="faint" style={{ fontSize: 11 }}>30 天 · 每日 Tokens</span>
            <span className="sp" />
            <Segmented
              options={[{ v: 'all' as Mode, label: '全部' }, { v: 'split' as Mode, label: '按服务分线' }]}
              value={mode}
              onChange={setMode}
            />
          </div>
          {realDays && realDays.length > 1 ? (
            <AreaChart
              series={series}
              mode={mode === 'all' ? 'area' : 'split'}
              labels={labels}
              barStyle="tick"
              reqData={reqData}
              height={200}
              startIdx={startIdx >= 0 ? startIdx : undefined}
              onHover={(i) => {
                if (mode === 'all') {
                  const v = series[0].data[i] ?? 0
                  const r = reqData?.[i] ?? 0
                  return `<b>${labels[i]}</b>合计 ${fmtTok(v)} tok · ${fmtInt(r)} 次`
                }
                return `<b>${labels[i]}</b>` + series.map((s) => `<span style="color:${s.color}">●</span> ${fmtTok(s.data[i])}`).join('&nbsp; ')
              }}
            />
          ) : (
            <div className="empty">
              <b>还没有可绘制的趋势</b>
              <span>面板每 5 分钟从运行中的服务拉一轮统计；累积两天以上就会出现曲线。</span>
            </div>
          )}
          {mode === 'split' && realDays && realDays.length > 1 && (
            <div className="legend">
              {svcs.map((s) => (
                <span key={s.id}><i style={{ background: s.color }} />{s.name}</span>
              ))}
            </div>
          )}
          <p className="ovnote faint">{statsNote(stats)}</p>
        </section>

        {/* ---------- 24 小时时段分布（只有 workbuddy 有小时粒度） ---------- */}
        <section className="sect s5">
          <div className="sect-head">
            <h3>时段分布</h3>
            <span className="faint" style={{ fontSize: 11 }}>今日 · 每小时 Tokens</span>
          </div>
          {hourly.length > 0 ? (
            <>
              <div className="hours">
                <svg viewBox="0 0 240 92" preserveAspectRatio="none" aria-hidden>
                  {hourly.map((h, i) => {
                    const v = h.total_tokens ?? 0
                    const bh = Math.max(v > 0 ? 2 : 0, (v / hourlyMax) * 88)
                    return (
                      <rect
                        key={h.key}
                        x={i * 10 + 1.5}
                        y={92 - bh}
                        width={7}
                        height={bh}
                        fill="var(--accent)"
                        opacity={v > 0 ? 0.85 : 0.12}
                      />
                    )
                  })}
                </svg>
                <div className="hlabels faint"><span>00</span><span>06</span><span>12</span><span>18</span><span>23</span></div>
              </div>
              <div className="kv-mini">
                <div><span>峰值时段</span><b>{peakHour(hourly)}</b></div>
                <div><span>活跃时段</span><b>{hourly.filter((h) => (h.total_tokens ?? 0) > 0).length} / 24</b></div>
              </div>
              <p className="ovnote faint">小时粒度仅 workbuddy 提供。</p>
            </>
          ) : (
            <div className="empty"><b>暂无小时数据</b><span>workbuddy 未运行，或今天还没有产生用量。</span></div>
          )}
        </section>

      </div>

      <div className="grid12 rowgap">

        {/* ---------- 按模型 / 按账号 排行 ---------- */}
        <section className="sect s4">
          <div className="sect-head">
            <h3>排行</h3>
            <span className="faint" style={{ fontSize: 11 }}>30 天 Tokens</span>
          </div>
          <div className="rank2">
            <div>
              <div className="rt">按模型<span className="faint">workbuddy</span></div>
              {byModel.length > 0 ? (
                byModel.slice(0, 5).map((m) => (
                  <div className="rr" key={m.key}>
                    <span className="k mono" title={m.key}>{m.key}</span>
                    <span className="t"><i style={{ width: `${Math.max(2, ((m.total_tokens ?? 0) / (byModel[0].total_tokens || 1)) * 100)}%` }} /></span>
                    <span className="v">{fmtTok(m.total_tokens ?? 0)}</span>
                  </div>
                ))
              ) : (
                <div className="faint" style={{ fontSize: 11, padding: '6px 0' }}>该服务无此口径</div>
              )}
            </div>
            <div>
              <div className="rt">按账号<span className="faint">workbuddy + cline</span></div>
              {byAcct.length > 0 ? (
                byAcct.map((a) => (
                  <div className="rr" key={a.id + a.key}>
                    <span className="k"><ServiceGlyph id={a.id} size={13} /> {a.key}</span>
                    <span className="t"><i style={{ width: `${Math.max(2, (a.tok / (byAcct[0].tok || 1)) * 100)}%` }} /></span>
                    <span className="v">{fmtTok(a.tok)}</span>
                  </div>
                ))
              ) : (
                <div className="faint" style={{ fontSize: 11, padding: '6px 0' }}>暂无账号用量</div>
              )}
            </div>
          </div>
          <p className="ovnote faint">模型维度仅 workbuddy；账号维度来自 workbuddy 与 cline 各自统计。</p>
        </section>
        {/* ---------- 服务质量 ---------- */}
        <section className="sect s4">
          <div className="sect-head">
            <h3>服务质量</h3>
            <span className="faint" style={{ fontSize: 11 }}>各服务自身口径</span>
          </div>
          <div className="tbox">
            <table className="tight">
              <thead>
                <tr>
                  <th>服务</th>
                  <th className="num-r">成功率</th>
                  <th className="num-r">成功 / 失败</th>
                  <th className="num-r">平均延迟</th>
                </tr>
              </thead>
              <tbody>
                {quality.map((q) => (
                  <tr key={q.id}>
                    <td><span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}><ServiceGlyph id={q.id} size={15} />{nameOf(q.id)}</span></td>
                    <td className="num-r">{q.rate != null ? `${(q.rate * 100).toFixed(q.rate === 1 ? 0 : 1)}%` : '—'}</td>
                    <td className="num-r">{q.ok != null ? `${q.ok} / ${q.fail ?? 0}` : '—'}</td>
                    <td className="num-r">{q.latency != null ? `${fmtInt(q.latency)} ms` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="ovnote faint">延迟仅 workbuddy；cline 只给成功失败计数。「—」＝该服务没有这个口径。</p>
        </section>

        {/* ---------- 面板事件 ---------- */}
        <section className="sect s4">
          <div className="sect-head">
            <h3>面板事件</h3>
            <span className="faint" style={{ fontSize: 11 }}>启停 / 崩溃拉起 / 统计拉取</span>
            <span className="sp" />
            <span className="faint" style={{ fontSize: 11 }}>最近 {recentEvents.length} 条</span>
          </div>
          <div className="tbox">
            <table>
              <tbody>
                {recentEvents.map((e, i) => (
                  <tr key={i}>
                    <td className="mono" style={{ width: 84, color: 'var(--muted)' }}>{e.t}</td>
                    <td>{e.msg}</td>
                  </tr>
                ))}
                {recentEvents.length === 0 && (
                  <tr><td className="faint">暂无面板事件（后端刚启动）。</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="ovnote faint">
            只记面板自身动作。逐条请求流水四个服务都没有结构化接口，见各服务「日志」页签；用量聚合见「统计」页。
          </p>
        </section>

      </div>

      {/* ---------- 信息带：接入入口与口径 ---------- */}
      <div className="footband rowgap">
        <section>
          <h4>接入入口</h4>
          <dl className="foot-dl">
            <dt>经面板</dt><dd><code>/api/svc/&lt;服务&gt;/v1</code></dd>
            <dt>客户端密钥</dt><dd>随便填，面板会覆盖成真实密钥</dd>
            <dt>直连</dt><dd><code>127.0.0.1:&lt;端口&gt;/v1</code> + 真钥</dd>
          </dl>
        </section>
        <section>
          <h4>数据口径</h4>
          <dl className="foot-dl">
            <dt>统计</dt><dd>各服务自身口径，面板按日搬运，取不到就显示「—」</dd>
            <dt>进程监督</dt><dd>30s 起指数退避，上限 10 分钟；面板外起的实例会被接管</dd>
          </dl>
          <p className="ovnote faint">
            四家仍是四个独立入口，没有「一个 base URL 调四家」的聚合入口。
          </p>
        </section>
      </div>
    </div>
  )
}


function statsNote(stats: StatsData | null): string {
  if (!stats) return '统计接口未连接：数字显示「—」。'
  const first = stats.days.find((d) => d.total.input + d.total.output + d.total.reqs > 0)
  if (!first) return '暂无历史记录：面板统计从服务产生流量后开始收录。'
  return `统计自 ${first.date.slice(5)} 起收录（此前无记录；面板每 5 分钟拉取一次）。服务停止期间不产生数据。`
}

/* 峰值时段：返回形如 02:00（该小时 tokens 最高）；无数据返回「—」 */
function peakHour(hours: { key: string; total_tokens?: number }[]): string {
  let best = -1
  let bv = 0
  hours.forEach((h, i) => {
    const v = h.total_tokens ?? 0
    if (v > bv) { bv = v; best = i }
  })
  return best < 0 ? '—' : `${hours[best].key}:00`
}
