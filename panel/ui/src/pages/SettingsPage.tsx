/* 设置页（面板自身）：偏好 / 服务注册表 / 进程监督 / 关于 */
import { useEffect, useState } from 'react'
import { PageHead, toast } from '../components/ui'

interface RegSvc {
  id: string
  name: string
  dir: string
  command: string
  args?: string[]
  port: number
  health: string
  env?: Record<string, string>
  auth?: { file: string; field: string; format: string }
}

export function SettingsPage() {
  const [reg, setReg] = useState<{ services: RegSvc[]; autoRestart: boolean; version: string } | null>(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    fetch('/api/registry')
      .then((r) => r.json())
      .then(setReg)
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
  }, [])

  function authText(a?: RegSvc['auth']): string {
    if (!a) return '本机免鉴权'
    return `${a.file} → ${a.field}（${a.format === 'env' ? 'env 行' : 'JSON 字段'}）`
  }

  return (
    <div className="wrap">
      <PageHead title="设置" sub="面板自身 · 修改注册表后重启面板生效" />

      {err && <div className="alertbar err"><span className="ico" /><span>后端不可达：{err}</span></div>}

      <div className="duo-wide" style={{ alignItems: "start" }}>
        <div className="sect">
          <div className="sect-head"><h3>面板偏好</h3></div>
          <div className="tbox"><table><tbody>
            <tr>
              <td style={{ width: 220 }}><b>主题</b><div className="muted" style={{ fontSize: 11.5 }}>当前版本仅保留素瓷</div></td>
              <td><span className="st ok"><i />素瓷 Porcelain</span></td>
            </tr>
            <tr>
              <td><b>数据刷新频率</b><div className="muted" style={{ fontSize: 11.5 }}>统计每 5 分钟自动拉取（可在统计页手动触发）；页面轮询 2.5–3 秒</div></td>
              <td className="muted" style={{ fontSize: 12.5 }}>暂不支持自定义</td>
            </tr>
            <tr>
              <td><b>面板地址</b><div className="muted" style={{ fontSize: 11.5 }}>当前访问地址（启动参数 -addr 决定）</div></td>
              <td><input type="text" readOnly value={location.host} style={{ width: 180, background: 'var(--line-soft)' }} /></td>
            </tr>
          </tbody></table></div>
        </div>
        <div className="sect">
          <div className="sect-head"><h3>进程监督</h3></div>
          <div className="tbox"><table><tbody>
            <tr>
              <td style={{ width: 220 }}><b>崩溃自动拉起</b><div className="muted" style={{ fontSize: 11.5 }}>退出即检测；收编的外部实例掉线同样接管拉起</div></td>
              <td>{reg ? (reg.autoRestart ? <span className="st ok"><i />已启用</span> : <span className="st stop"><i />已关闭（-no-autorestart）</span>) : '—'}</td>
            </tr>
            <tr>
              <td><b>重启退避</b><div className="muted" style={{ fontSize: 11.5 }}>连续崩溃时指数退避，防拉起风暴</div></td>
              <td className="m">30s 起步 · 最长 10 分钟</td>
            </tr>
            <tr>
              <td><b>服务日志目录</b><div className="muted" style={{ fontSize: 11.5 }}>各服务 stdout 重定向</div></td>
              <td className="m">{'panel/data/logs/{id}.log'}</td>
            </tr>
          </tbody></table></div>
        </div>
      </div>

      <div className="sect">
        <div className="sect-head">
          <h3>服务注册表</h3><span className="sub">panel/data/services.json · 编辑后重启面板生效</span>
          <span className="sp" />
          <button className="btn xs" onClick={() => { navigator.clipboard.writeText(JSON.stringify(reg?.services ?? [], null, 2)).then(() => toast('注册表已复制', 'ok')) }}>复制 JSON</button>
        </div>
        {!reg ? <div className="loading">读取中…</div> : (
          <div className="tbox"><table>
            <thead><tr><th>服务</th><th>目录</th><th>启动命令</th><th className="num-r" style={{ width: 80 }}>端口</th><th>健康检查</th><th>鉴权来源</th></tr></thead>
            <tbody>
              {reg.services.map((s) => (
                <tr key={s.id}>
                  <td><b style={{ fontSize: 13 }}>{s.name}</b><div className="faint m" style={{ fontSize: 11 }}>{s.id}</div></td>
                  <td className="m">{s.dir}</td>
                  <td className="m">{s.command}{(s.args ?? []).length ? ' ' + (s.args ?? []).join(' ') : ''}{s.env && Object.keys(s.env).length ? `（env ${Object.entries(s.env).map(([k, v]) => k + '=' + v).join(' ')}）` : ''}</td>
                  <td className="num-r">{s.port}</td>
                  <td className="m">{s.health}</td>
                  <td className="m" style={{ fontSize: 11.5 }}>{authText(s.auth)}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </div>


      <div className="sect" style={{ marginBottom: 0 }}>
        <div className="sect-head"><h3>关于</h3></div>
        <div className="tbox"><table><tbody>
          <tr><td style={{ width: 220 }}><b>面板版本</b></td><td className="m">v{reg?.version ?? '0.1.0'} · Go 后端 + React 前端（构建产物由面板静态托管）</td></tr>
          <tr><td><b>统一 API 入口</b></td><td className="muted" style={{ fontSize: 12.5 }}>面板 v1 暂不聚合为单 base URL + 单 key，架构已预留</td></tr>
          <tr><td><b>原面板入口</b></td><td className="muted" style={{ fontSize: 12.5 }}>各服务详情页右上「打开原面板 ↗」（经 {'/api/svc/{id}'} 代理）</td></tr>
        </tbody></table></div>
      </div>
    </div>
  )
}
