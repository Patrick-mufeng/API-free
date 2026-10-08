/* 统计页：跨服务聚合（M3）—— 数据来自面板 SQLite（5 分钟拉取一轮，可手动刷新） */
import { useCallback, useEffect, useState } from 'react'
import { AreaChart, PageHead, toast } from '../components/ui'
import { fetchServices, fetchStats, refreshStats, type StatsData } from '../api'
import { svcColor, toViews, orderIndex, type SvcView } from '../data/services'
import { fmtInt, fmtTok } from '../data/format'

export function StatsPage() {
  const [data, setData] = useState<StatsData | null>(null)
  const [svcs, setSvcs] = useState<SvcView[]>([])
  const [mode, setMode] = useState<'total' | 'split'>('total')
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

  const days = data.days
  const labels = days.map((d) => d.date.slice(5))
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#3b82f6'

  // 服务清单：名称取注册表（真实），统计里出现过的服务一律补上，避免丢掉数据
  const seen = new Map<string, { id: string; name: string; color: string }>(
    svcs.map((s) => [s.id, { id: s.id, name: s.name, color: s.color }]),
  )
  for (const id of new Set([...Object.keys(data.totals), ...days.flatMap((d) => Object.keys(d.services))])) {
    if (id === 'total' || seen.has(id)) continue
    seen.set(id, { id, name: id, color: svcColor(id) })
  }
  const metas = [...seen.values()].sort((a, b) => orderIndex(a.id) - orderIndex(b.id))

  const series =
    mode === 'total'
      ? [{ name: 'total', color: accent, data: days.map((d) => d.total.input + d.total.output) }]
      : metas.map((s) => ({ name: s.name, color: s.color, data: days.map((d) => { const e = d.services[s.id]; return e ? e.input + e.output : 0 }) }))
  const reqData = days.map((d) => d.total.reqs)
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
          <h3>对比趋势</h3><span className="sub">近 30 天 · 每日 Tokens</span><span className="sp" />
          <div className="seg">
            <button className={mode === 'total' ? 'on' : ''} onClick={() => setMode('total')}>合计</button>
            <button className={mode === 'split' ? 'on' : ''} onClick={() => setMode('split')}>分服务</button>
          </div>
        </div>
        <AreaChart
          series={series}
          mode={mode === 'total' ? 'area' : 'split'}
          labels={labels}
          reqData={reqData}
          startIdx={startIdx >= 0 ? startIdx : undefined}
          onHover={(i) => {
            if (mode === 'total') return `<b>${labels[i]}</b>${fmtTok(series[0].data[i])} tok · ${fmtInt(reqData[i])} 次`
            return `<b>${labels[i]}</b>` + metas.map((s, k) => `<span style="color:${s.color}">●</span> ${fmtTok(series[k].data[i])}`).join('&nbsp; ')
          }}
        />
      </div>

        <div className="sect" style={{ marginBottom: 0 }}>
          <div className="sect-head"><h3>服务占比</h3><span className="sub">30 天</span></div>
          <div className="rank">
            {totalsArr.map((t) => {
              const v = t.v.input + t.v.output
              const p = Math.round((v / grand) * 1000) / 10
              return (
                <div key={t.id} className="r">
                  <div className="t"><b><i style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: t.color, marginRight: 7 }} />{t.name}</b><span>{p}%</span></div>
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
