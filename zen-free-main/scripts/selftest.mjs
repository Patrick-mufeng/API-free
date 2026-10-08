// Client-side self test for a running zen-free service.
//
//	node scripts/selftest.mjs [baseUrl]
//
// Everything here talks to the service the way a normal OpenAI client would:
// no gate tools, no session headers, no disguise — the service has to supply
// all of that itself. Requires the service to be running (config.json's
// api_key is read from the current directory).
import { readFileSync } from 'node:fs'

const base = process.argv[2] ?? 'http://127.0.0.1:8020'
const cfg = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'))
const key = cfg.api_key

let failures = 0
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '[ ok ]' : '[FAIL]'} ${label}${detail ? '  ' + detail : ''}`)
  if (!ok) failures++
}

async function json(path, init = {}) {
  const res = await fetch(base + path, init)
  const text = await res.text()
  let parsed
  try { parsed = JSON.parse(text) } catch { /* keep text */ }
  return { res, parsed, text }
}

console.log(`zen-free 自检 · ${base}\n`)

// 1) health
{
  const { res, parsed } = await json('/healthz')
  check(res.ok && parsed?.status === 'ok', 'GET /healthz', `HTTP ${res.status} status=${parsed?.status} models=${parsed?.models?.exposed}/${parsed?.models?.total} source=${parsed?.models?.source}`)
  if (parsed?.issues?.length) console.log(`        issues: ${parsed.issues.join(', ')}`)
}

// 2) auth: no key must be refused
{
  const { res } = await json('/v1/models')
  check(res.status === 401, 'GET /v1/models 无密钥 → 401', `HTTP ${res.status}`)
}

// 3) models list with the key
let model = 'big-pickle'
{
  const { res, parsed } = await json('/v1/models', { headers: { Authorization: `Bearer ${key}` } })
  const ids = (parsed?.data ?? []).map((m) => m.id)
  const freeish = ids.filter((id) => /free/.test(id) || id === 'big-pickle')
  check(res.ok && ids.length > 0, 'GET /v1/models 带密钥', `HTTP ${res.status}, ${ids.length} 个模型`)
  console.log(`        免费 ${freeish.length} 个：${freeish.slice(0, 6).join(', ')}${freeish.length > 6 ? ' …' : ''}`)
  if (freeish.length > 0 && !freeish.includes(model)) model = freeish[0]
}

// 4) plain non-streaming chat: no tools, no stream — the service must add both
{
  const started = Date.now()
  const { res, parsed, text } = await json('/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: '只回复两个字：收到' }], max_tokens: 64 }),
  })
  const content = parsed?.choices?.[0]?.message?.content ?? ''
  const usage = parsed?.usage
  check(res.ok && content.length > 0, 'POST /v1/chat/completions 非流式（客户端不带 stream/tools）',
    `HTTP ${res.status} ${Date.now() - started}ms`)
  console.log(`        content=${JSON.stringify(content)} object=${parsed?.object} finish=${parsed?.choices?.[0]?.finish_reason}`)
  console.log(`        usage=${usage ? `${usage.prompt_tokens}/${usage.completion_tokens}/${usage.total_tokens}` : '无'}`)
  if (!res.ok) console.log(`        ${text.slice(0, 200)}`)
}

// 5) streaming chat: still no tools — the service injects the gate tools
{
  const started = Date.now()
  const res = await fetch(base + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: '只回复两个字：收到' }], max_tokens: 64, stream: true }),
  })
  let chunks = 0, content = '', sawUsage = false, sawDone = false
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const frames = buffer.split('\n\n')
    buffer = frames.pop() ?? ''
    for (const frame of frames) {
      const line = frame.split('\n').find((l) => l.startsWith('data:'))
      if (!line) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') { sawDone = true; continue }
      let chunk
      try { chunk = JSON.parse(data) } catch { continue }
      chunks++
      if (chunk.usage) sawUsage = true
      content += chunk.choices?.[0]?.delta?.content ?? ''
    }
  }
  check(res.ok && content.length > 0, 'POST /v1/chat/completions 流式 SSE', `HTTP ${res.status} ${Date.now() - started}ms`)
  console.log(`        ${chunks} chunk, [DONE]=${sawDone}, 正文=${JSON.stringify(content)}, 流内 usage=${sawUsage}`)
}

// 6) a paid model must be refused locally, with a readable reason
{
  const { res, parsed } = await json('/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: 'claude-opus-5', messages: [{ role: 'user', content: 'hi' }] }),
  })
  check(res.status === 400, 'POST 付费模型 → 本地 400', `HTTP ${res.status}: ${parsed?.error?.message ?? ''}`.slice(0, 160))
}

// 7) the panel-shaped management API
for (const path of ['/panel/api/overview', '/panel/api/stats?range=30d', '/panel/api/models', '/panel/api/logs']) {
  const { res, parsed } = await json(path)
  const shape =
    path.includes('stats') ? `series=${parsed?.series?.length ?? '?'}`
    : path.includes('/models') ? `models=${parsed?.models?.length ?? '?'}`
    : path.includes('logs') ? `entries=${parsed?.entries?.length ?? '?'}`
    : `exposed=${parsed?.models_exposed} today=${parsed?.today?.requests}`
  check(res.ok, `GET ${path}`, `HTTP ${res.status} ${shape}`)
}

// 8) usage accounting survived the three requests above
{
  const { parsed } = await json('/panel/api/stats?range=30d')
  const today = parsed?.series?.find((row) => row.key === new Date().toISOString().slice(0, 10)) ?? parsed?.series?.at(-1)
  check(Boolean(today) && today.requests >= 3, '用量记账（今日行）', `requests=${today?.requests} input=${today?.prompt_tokens} output=${today?.completion_tokens} failures=${today?.failures}`)
}

console.log(failures === 0 ? '\n全部通过。' : `\n${failures} 项未通过。`)
process.exit(failures === 0 ? 0 : 1)
