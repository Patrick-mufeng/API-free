/* 统计页：跨服务聚合（M3）—— 数据来自面板 SQLite（5 分钟拉取一轮，可手动刷新） */
import { useCallback, useEffect, useState } from 'react'
import { AreaChart, Legend, PageHead, toast } from '../components/ui'
import { fetchServices, fetchStats, refreshStats, type StatsData } from '../api'
import { svcColor, toViews, orderIndex, type SvcView } from '../data/services'
import { fmtInt, fmtTok } from '../data/format'

export function StatsPage() {
  const [data, setData] = useState<StatsData | null>(null)
  const [svcs, setSvcs] = useState<SvcView[]>([])
  /* 图例选中的服务：空 = 合计（输入/输出分层）；选中若干 = 只看这几家 */
  const [picked, setPicked] = useState<string[]>([])
  const [err, setErr] = useState('')

  useEffect(() => {
    let alive = true
    fetchServices().then((l) => { if (alive) setSvcs(toViews(l)) }).catch(() => { /* 名称回退到 id */ })
    return () => { alive = false }
  }, [])

  const load = useCallback(async () => {
    try {
      setData(await fetchStats(30))
      setErr('')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), 60000)
    return () => clearInterval(t)
  }, [load])

  async function refresh() {
    try {
      await refreshStats()
      toast('已拉取一轮统计', 'ok')
      await load()
    } catch (e) {
      toast('刷新失败：' + (e instanceof Error ? e.message : e), 'err')
    }
  }

  if (err && !data) {
    return (
      <div className="wrap">
        <PageHead title="统计" sub="跨服务聚合" />
        <div className="alertbar err"><span className="ico" /><span>统计后端不可达：{err}（需要 panel.exe 在运行）</span></div>
      </div>
    )
  }
  if (!data) {
    return <div className="wrap"><div className="loading">加载统计中…</div></div>
  }

  /* 收录起点之前的空日子不画：那不是「用量为 0」，而是「还没有记录」。
     整段 0 会把曲线压成一条贴底的直线，30 格宽度只用上最后一格；
     攒满 30 天后窗口自然就是完整的 30 天。明细表只列有记录的日子，不受影响。 */
  const allDays = data.days
  const firstDay = allDays.findIndex((d) => d.total.input + d.total.output + d.total.reqs > 0)
  const days = firstDay > 0 ? allDays.slice(firstDay) : allDays
  const labels = days.map((d) => d.date.slice(5))
  /* 合计用中性两档（墨色 / 浅灰）：输入/输出是同一度量的两部分，两档比两个色相更清楚 */
  const ink = 'var(--text)'
  const inkSoft = 'var(--faint)'

  // 服务清单：名称取注册表（真实），统计里出现过的服务一律补上，避免丢掉数据
  const seen = new Map<string, { id: string; name: string; color: string }>(
    svcs.map((s) => [s.id, { id: s.id, name: s.name, color: s.color }]),
  )
  for (const id of new Set([...Object.keys(data.totals), ...days.flatMap((d) => Object.keys(d.services))])) {
    if (id === 'total' || seen.has(id)) continue
    seen.set(id, { id, name: id, color: svcColor(id) })
  }
  const metas = [...seen.values()].sort((a, b) => orderIndex(a.id) - orderIndex(b.id))

  const pickedMetas = metas.filter((m) => picked.includes(m.id))
  const scoped = (f: (e: { input: number; output: number; reqs: number }) => number) =>
    pickedMetas.length === 0
      ? days.reduce((a, d) => a + f(d.total), 0)
      : days.reduce((a, d) => a + pickedMetas.reduce((b, m) => b + (d.services[m.id] ? f(d.services[m.id]) : 0), 0), 0)
  const series =
    pickedMetas.length === 0
      ? [
          { name: '输入', color: ink, data: days.map((d) => d.total.input) },
          { name: '输出', color: inkSoft, data: days.map((d) => d.total.output) },
        ]
      : pickedMetas.map((s) => ({ name: s.name, color: s.color, data: days.map((d) => { const e = d.services[s.id]; return e ? e.input + e.output : 0 }) }))
  const chartMode: 'stack' | 'split' = pickedMetas.length === 0 ? 'stack' : 'split'
  const scopeName = pickedMetas.length === 0 ? '全部服务' : pickedMetas.length === 1 ? pickedMetas[0].name : `${pickedMetas.length} 家`
  const scopeTok = scoped((e) => e.input + e.output)
  const scopeReqs = scoped((e) => e.reqs)
  const reqData = days.map((d) => (pickedMetas.length === 0
    ? d.total.reqs
    : pickedMetas.reduce((a, m) => a + (d.services[m.id]?.reqs ?? 0), 0)))
  const startIdx = days.findIndex((d) => d.total.input + d.total.output + d.total.reqs > 0)

  const totalsArr = metas.map((s) => ({ ...s, v: data.totals[s.id] ?? { input: 0, output: 0, reqs: 0 } }))
  const grand = totalsArr.reduce((a, t) => a + t.v.input + t.v.output, 0) || 1
  const used = totalsArr.filter((t) => t.v.input + t.v.output + t.v.reqs > 0).length
  const today = data.today

  return (
    <div className="wrap">
      <PageHead title="统计" sub={`跨服务聚合 · 每 5 分钟拉取（最近一轮 ${data.lastPull}${data.lastPullErr ? ' · ' + data.lastPullErr : ''}）`}>
        <button className="btn" onClick={() => void refresh()}>立即拉取</button>
      </PageHead>

      <div className="kpis">
        <div className="kpi"><h3>今日 Tokens</h3><div className="v">{fmtTok(today.input + today.output)}</div><div className="d">输入 {fmtTok(today.input)} · 输出 {fmtTok(today.output)}</div></div>
        <div className="kpi"><h3>今日请求</h3><div className="v">{fmtInt(today.reqs)}</div><div className="d">各服务自身口径合计</div></div>
        <div className="kpi"><h3>30 天 Tokens</h3><div className="v">{fmtTok(grand)}</div><div className="d">面板拉取口径</div></div>
        <div className="kpi">
          <h3>有用量服务</h3>
          <div className="v" style={{ fontSize: 20 }}>{svcs.length === 0 ? '—' : `${used} / ${svcs.length}`}</div>
          <div className="d">30 天内有记录 / 已注册</div>
        </div>
      </div>

      <div className="duo-wide">
      <div className="sect" style={{ marginBottom: 0 }}>
        <div className="sect-head">
          <h3>Token 用量</h3>
          <span className="sub">
            最近 {days.length} 天 · 每日 Tokens · {scopeName} {fmtTok(scopeTok)} tok · {fmtInt(scopeReqs)} 次
          </span>
          <span className="sp" />
        </div>
        <Legend
          entries={metas.map((s) => ({ id: s.id, name: s.name, color: s.color, value: (data.totals[s.id]?.input ?? 0) + (data.totals[s.id]?.output ?? 0) }))}
          selected={picked}
          onToggle={(id) => setPicked((xs) => (xs.includes(id) ? xs.filter((x) => x !== id) : [...xs, id]))}
          onClear={() => setPicked([])}
          allValue={grand}
        />
        <AreaChart
          series={series}
          mode={chartMode}
          labels={labels}
          reqData={reqData}
          startIdx={startIdx >= 0 ? startIdx : undefined}
          onHover={(i) => {
            if (chartMode === 'stack') {
              const inTok = series[0].data[i] ?? 0
              const outTok = series[1].data[i] ?? 0
              return `<b>${labels[i]}</b>输入 ${fmtTok(inTok)} · 输出 ${fmtTok(outTok)}<br>合计 ${fmtTok(inTok + outTok)} tok · ${fmtInt(reqData[i])} 次请求`
            }
            const sum = series.reduce((a, s) => a + (s.data[i] ?? 0), 0)
            return `<b>${labels[i]}</b>${series.length > 1 ? `　合计 ${fmtTok(sum)}` : ''}<br>`
              + series.map((s) => `<span style="color:${s.color}">●</span> ${s.name} ${fmtTok(s.data[i])}`).join('&nbsp; ')
          }}
        />
        {chartMode === 'stack' && (
          <div className="legend" style={{ borderTop: 0, paddingTop: 0, marginTop: 2 }}>
            <span className="lgdot"><i style={{ background: ink }} />输入 Tokens</span>
            <span className="lgdot"><i style={{ background: inkSoft }} />输出 Tokens</span>
          </div>
        )}
      </div>

        <div className="sect" style={{ marginBottom: 0 }}>
          <div className="sect-head"><h3>服务占比</h3><span className="sub">30 天 Tokens</span></div>
          <div className="rank">
            {totalsArr.map((t) => {
              const v = t.v.input + t.v.output
              const p = Math.round((v / grand) * 1000) / 10
              return (
                <div key={t.id} className="r">
                  <div className="t">
                    <b><i style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: t.color, marginRight: 7 }} />{t.name}</b>
                    <span className="mono">{fmtTok(v)} · {p}%</span>
                  </div>
                  <div className="bar"><i style={{ width: p + '%', background: t.color }} /></div>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      <div className="sect">
        <div className="sect-head"><h3>明细</h3><span className="sub">日期 × 服务 · 有记录才显示</span></div>
          <div className="tbox" style={{ maxHeight: 420, overflow: 'auto' }}>
            <table>
              <thead><tr><th>日期</th><th>服务</th><th className="num-r">输入</th><th className="num-r">输出</th><th className="num-r">请求</th></tr></thead>
              <tbody>
                {days.flatMap((d) =>
                  metas.flatMap((s) => {
                    const e = d.services[s.id]
                    if (!e || (e.input === 0 && e.output === 0 && e.reqs === 0)) return []
                    return [(
                      <tr key={d.date + s.id}>
                        <td>{d.date.slice(5)}</td>
                        <td><span className="chip">{s.name}</span></td>
                        <td className="num-r">{fmtTok(e.input)}</td>
                        <td className="num-r">{fmtTok(e.output)}</td>
                        <td className="num-r">{fmtInt(e.reqs)}</td>
                      </tr>
                    )]
                  }),
                )}
              </tbody>
            </table>
          </div>
      </div>

      <p className="faint" style={{ fontSize: 11.5, marginTop: 14 }}>
        {(() => {
          const first = days.find((d) => d.total.input + d.total.output + d.total.reqs > 0)
          return first ? `统计自 ${first.date.slice(5)} 起收录（此前无记录）。 ` : '暂无历史记录：面板统计从今日开始收录。 '
        })()}
        口径说明：以各服务自身统计为准，面板每 5 分钟拉取落 SQLite；cline 为「累计快照差分」推导（进程重启清零期间无法回补）；cmdgo 为只读补丁口径（/api/usage）。服务停止期间不产生数据。
      </p>
    </div>
  )
}
