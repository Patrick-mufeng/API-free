/* 「接入」页签：把这个服务接到别的 Agent 需要的一切——地址、密钥、模型、可复制的调用代码、自检。
   地址与密钥来自后端 /api/access（脱敏）；点「显示」才请求 /api/access/{id}/key 拿明文。 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Segmented, toast } from '../components/ui'
import { fetchAccess, fetchKey, type SvcAccess } from '../api'

/** 各服务的接入须知：都是实测过的事实，不是占位文案 */
const NOTES: Record<string, string[]> = {
  workbuddy: [
    '模型 ID 带范围前缀：cn:… / global:…（跟随账号所属区域）',
    '这是推理模型：max_tokens 给小了会全被思考吃掉，content 会返回空串（思考内容在 reasoning_content 里）',
    '账号池、签到、积分任务都在本服务的「账号 / 任务中心」页签',
  ],
  qoder: [
    '模型 ID 带范围前缀：cn:… / global:…（跟随账号区域）',
    '账号池为空时 /v1/models 会返回 0 个模型——先在「账号」页签登录',
  ],
  cline: [
    '同时支持两种协议：OpenAI（/v1/chat/completions）与 Anthropic（/v1/messages），两边官方 SDK 都能直连',
    '只有「模型库」页签里启用过的模型才会出现在 /v1/models 中',
    'Cloudflare 的 workers.dev 域名按 User-Agent 拦请求，非浏览器 UA 可能拿到 1010；改用 Vercel 域名，或在请求里带浏览器 UA（下面的 curl 示例已带）',
    '402 = 付费档余额不足，换带 :free 或 cline-free/ 前缀的免费模型',
    '429 Daily free limit = 该账号当日额度用尽，等冷却或追加账号后会自动切号',
    '服务端未配 API_KEY 时聊天端点返回 401、不回退到公开默认密钥（所以经面板代理时客户端密钥填任意值即可）',
  ],
  cmdgo: [
    '上游是 Command Code，首次使用要先在「账号」页签完成 OAuth 登录',
    '模型目录随上游同步，数量会变动（点「刷新」看最新）',
  ],
}

const PROTOCOL_LABEL: Record<string, string> = {
  openai: 'OpenAI 兼容',
  anthropic: 'Anthropic 兼容',
}

type SnipKind = 'curl' | 'python' | 'node' | 'anthropic' | 'env'

export function ServiceAccess({ id }: { id: string }) {
  const [acc, setAcc] = useState<SvcAccess | null>(null)
  const [err, setErr] = useState('')
  const [base, setBase] = useState<'panel' | 'local'>('panel')
  const [plain, setPlain] = useState<string | null>(null) // 明文密钥；null = 未解锁
  const [model, setModel] = useState('')
  const [snip, setSnip] = useState<SnipKind>('curl')
  const [probe, setProbe] = useState<{ busy: boolean; ok?: boolean; text: string }>({ busy: false, text: '' })

  const load = useCallback(async () => {
    try {
      const rep = await fetchAccess()
      const mine = rep.services.find((s) => s.svc === id) ?? null
      setAcc(mine)
      setErr(mine ? '' : '后端没有返回这个服务的接入信息')
      if (mine?.models.length) setModel((cur) => cur || (mine.models.find((m) => m.note === '默认')?.id ?? mine.models[0].id))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [id])

  useEffect(() => {
    setPlain(null)
    setBase('panel')
    setModel('')
    void load()
  }, [load])

  const baseUrl = acc ? (base === 'panel' ? acc.panel_base : acc.local_base) : ''
  // 经面板时代理会注入真钥，这里填占位就是可用的代码；直连则必须真钥
  const snippetKey = base === 'panel' ? 'panel' : (plain ?? '你的API_KEY')
  const anthropic = acc?.protocols.includes('anthropic') ?? false

  const snippetText = useMemo(() => genSnippet(snip, baseUrl, snippetKey, model), [snip, baseUrl, snippetKey, model])

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text)
      toast(`${what}已复制`, 'ok')
    } catch {
      toast('复制失败：浏览器不允许写剪贴板', 'err')
    }
  }

  async function toggleKey() {
    if (plain !== null) { setPlain(null); return }
    try {
      setPlain(await fetchKey(id))
      toast('已显示完整密钥', 'ok')
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err')
    }
  }

  async function runProbe() {
    if (!baseUrl) return
    setProbe({ busy: true, text: '请求中…' })
    const t0 = performance.now()
    try {
      const r = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // 直连要带真钥；经面板不用带（带了也会被面板覆盖）
          ...(base === 'local' && plain ? { Authorization: `Bearer ${plain}` } : {}),
        },
        body: JSON.stringify({
          model: model || 'test',
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 64,
          stream: false,
        }),
      })
      const ms = Math.round(performance.now() - t0)
      const raw = await r.text()
      let content = ''
      let upstreamErr = ''
      try {
        const j = JSON.parse(raw)
        content = j?.choices?.[0]?.message?.content ?? ''
        const e = j?.error
        upstreamErr = typeof e === 'string' ? e : (e?.message ?? '')
      } catch {
        upstreamErr = raw.slice(0, 200)
      }
      if (r.ok) {
        setProbe({
          busy: false,
          ok: true,
          text: `HTTP ${r.status} · ${ms}ms · ${content ? '回复：' + content.slice(0, 60) : '（返回体里没有 content，推理模型给小 max_tokens 时会这样，通路是通的）'}`,
        })
      } else {
        setProbe({ busy: false, ok: false, text: `HTTP ${r.status} · ${ms}ms · ${upstreamErr || '（无错误详情）'}` })
      }
    } catch (e) {
      setProbe({ busy: false, ok: false, text: '请求失败：' + (e instanceof Error ? e.message : String(e)) })
    }
  }

  if (err) {
    return (
      <div className="sect">
        <div className="alertbar err"><span className="ico" /><span>{err}</span></div>
        <button className="btn" onClick={() => void load()}>重新读取</button>
      </div>
    )
  }
  if (!acc) return <div className="loading">读取接入信息中…</div>

  return (
    <>
      {!acc.running && (
        <div className="alertbar">
          <span className="ico" />
          <span>{acc.name} 当前没有运行：地址与密钥照常可用，模型列表要等它启动。</span>
        </div>
      )}

      <div className="sect">
        <div className="sect-head">
          <h3>连接信息</h3>
          <span className="sub">Base URL 就是填进客户端 API 地址栏的东西</span>
          <span className="sp" />
          <button className="btn xs" onClick={() => void load()}>刷新</button>
        </div>
        <div className="acc-rows">
          <div>
            <dt>地址</dt>
            <dd>
              <Segmented
                options={[{ v: 'panel' as const, label: '经面板（推荐）' }, { v: 'local' as const, label: '直连服务' }]}
                value={base}
                onChange={setBase}
              />
              <div className="acc-url">
                <code>{baseUrl}</code>
                <button className="btn xs" onClick={() => void copy(baseUrl, '地址')}>复制</button>
              </div>
              <div className="faint" style={{ fontSize: 11.5 }}>
                {base === 'panel'
                  ? '走面板代理：客户端 api_key 随便填，面板会注入真实密钥（面板需在运行）'
                  : `直连 ${acc.name} 自己的端口，需要带真实 API Key`}
              </div>
            </dd>
          </div>

          <div>
            <dt>API Key</dt>
            <dd>
              <div className="acc-url">
                <code>{plain ?? acc.key_masked ?? '—'}</code>
                <button className="btn xs" onClick={() => void toggleKey()} disabled={!acc.has_key}>
                  {plain !== null ? '隐藏' : '显示'}
                </button>
                <button className="btn xs" onClick={() => void copy(plain ?? '', '密钥')} disabled={plain === null}>
                  复制
                </button>
              </div>
              <div className="faint" style={{ fontSize: 11.5 }}>
                {acc.has_key
                  ? '默认为脱敏显示；点「显示」才向后端取明文（仅本机可用），复制同样需要先显示'
                  : '读不到密钥：注册表里没有该服务的鉴权来源，或密钥文件不可读'}
              </div>
            </dd>
          </div>

          <div>
            <dt>协议</dt>
            <dd>
              <div className="acc-inline">
                {acc.protocols.map((p) => (
                  <span key={p} className="chip">{PROTOCOL_LABEL[p] ?? p}</span>
                ))}
                <span className="faint" style={{ fontSize: 11.5 }}>端口 {acc.port}</span>
              </div>
            </dd>
          </div>

          <div>
            <dt>模型</dt>
            <dd>
              {acc.models.length > 0 ? (
                <>
                  <select value={model} onChange={(e) => setModel(e.target.value)} style={{ maxWidth: 420 }}>
                    {acc.models.map((m) => (
                      <option key={m.id} value={m.id}>{m.id}{m.label ? `（${m.label}）` : ''}{m.note ? ` · ${m.note}` : ''}</option>
                    ))}
                  </select>
                  <div className="faint" style={{ fontSize: 11.5, marginTop: 6 }}>
                    共 {acc.models.length} 个（来自该服务 /v1/models）。选中的这个会填进下面的代码。
                  </div>
                </>
              ) : (
                <span className="faint">{acc.models_err || '没有可用模型'}</span>
              )}
            </dd>
          </div>
        </div>
      </div>

      <div className="sect">
        <div className="sect-head">
          <h3>客户端接入代码</h3>
          <span className="sub">已按上面的地址与模型填好</span>
          <span className="sp" />
          <div className="seg">
            {([['curl', 'cURL'], ['python', 'Python'], ['node', 'Node']] as [SnipKind, string][])
              .concat(anthropic ? [['anthropic', 'Anthropic']] : [])
              .concat([['env', '环境变量']])
              .map(([v, label]) => (
                <button key={v} className={snip === v ? 'on' : ''} onClick={() => setSnip(v)}>{label}</button>
              ))}
          </div>
        </div>
        <pre className="logpre acc-snip">{snippetText}</pre>
        <div className="acc-actions">
          <button className="btn pri" onClick={() => void copy(snippetText, '代码')}>复制这段代码</button>
          <button className="btn" onClick={() => void runProbe()} disabled={probe.busy || !baseUrl}>
            {probe.busy ? '自检中…' : '一键自检'}
          </button>
          {probe.text && (
            <span className={probe.ok === false ? 'acc-probe bad' : 'acc-probe'}>{probe.text}</span>
          )}
        </div>
      </div>

      <div className="sect" style={{ marginBottom: 0 }}>
        <div className="sect-head"><h3>接入须知</h3><span className="sub">{acc.name}</span></div>
        <ul className="acc-notes">
          {(NOTES[id] ?? ['暂无该服务的补充说明']).map((n) => <li key={n}>{n}</li>)}
        </ul>
      </div>
    </>
  )
}

/* ---------- 代码片段（照 cline 原面板的形态，改为按当前选择生成） ---------- */

function genSnippet(kind: SnipKind, base: string, key: string, model: string): string {
  const m = model || '模型ID'
  /* cline 走 Cloudflare 时会按 UA 拦（非浏览器 UA 得到 1010），原控制台的 curl 示例
     专门带了浏览器 UA，这里照搬。 */
  const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  switch (kind) {
    case 'curl':
      return [
        `curl ${base}/chat/completions \\`,
        `  -H "Authorization: Bearer ${key}" \\`,
        `  -H "Content-Type: application/json" \\`,
        `  -H "User-Agent: ${BROWSER_UA}" \\`,
        `  -d '{"model":"${m}","messages":[{"role":"user","content":"你好"}],"stream":true}'`,
      ].join('\n')
    case 'python':
      return [
        'from openai import OpenAI',
        '',
        'client = OpenAI(',
        `    base_url="${base}",`,
        `    api_key="${key}",`,
        ')',
        '',
        '# 非流式',
        'resp = client.chat.completions.create(',
        `    model="${m}",`,
        '    messages=[{"role": "user", "content": "你好"}],',
        ')',
        'print(resp.choices[0].message.content)',
        '',
        '# 流式',
        'stream = client.chat.completions.create(',
        `    model="${m}",`,
        '    messages=[{"role": "user", "content": "你好"}],',
        '    stream=True,',
        ')',
        'for chunk in stream:',
        '    print(chunk.choices[0].delta.content or "", end="")',
      ].join('\n')
    case 'node':
      return [
        'import OpenAI from "openai"',
        '',
        `const client = new OpenAI({ baseURL: "${base}", apiKey: "${key}" })`,
        '',
        'const stream = await client.chat.completions.create({',
        `  model: "${m}",`,
        '  messages: [{ role: "user", content: "你好" }],',
        '  stream: true,',
        '})',
        'for await (const chunk of stream) {',
        '  process.stdout.write(chunk.choices[0]?.delta?.content ?? "")',
        '}',
      ].join('\n')
    case 'anthropic':
      return [
        'from anthropic import Anthropic',
        '',
        '# Anthropic SDK 会自己拼 /v1/messages，所以 base_url 不要带 /v1',
        `client = Anthropic(base_url="${base.replace(/\/v1$/, '')}", api_key="${key}")`,
        '',
        'msg = client.messages.create(',
        `    model="${m}",`,
        '    max_tokens=1024,',
        '    messages=[{"role": "user", "content": "你好"}],',
        ')',
        'print(msg.content[0].text)',
      ].join('\n')
    case 'env':
      return [
        '# OpenAI 兼容客户端（Cline / Continue / Cherry Studio / Cursor 自定义供应商…）',
        `OPENAI_BASE_URL=${base}`,
        `OPENAI_API_KEY=${key}`,
        '',
        '# 部分工具只认这个名字',
        `OPENAI_API_BASE=${base}`,
        '',
        '# Anthropic 兼容（Claude Code 等，仅 cline 提供 /v1/messages）',
        `ANTHROPIC_BASE_URL=${base.replace(/\/v1$/, '')}`,
        `ANTHROPIC_API_KEY=${key}`,
      ].join('\n')
  }
}
