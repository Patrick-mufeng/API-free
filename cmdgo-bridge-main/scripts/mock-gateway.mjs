/**
 * Mock Command Code gateway for local end-to-end testing.
 *
 * - POST /alpha/generate 校验信封后回 NDJSON 事件流；
 * - Bearer `user_failkey` 一律 403（模拟坏账号，用于测故障转移）；
 * - 请求含 tools 时回 tool-call 流，否则回纯文本流（含 usage）。
 *
 * 用法: node scripts/mock-gateway.mjs [port=18999]
 */
import { createServer } from 'node:http'

const PORT = Number(process.argv[2] ?? 18999)

function isRecord(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}

const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204
    res.end()
    return
  }
  if (req.method !== 'POST' || !(req.url ?? '').startsWith('/alpha/generate')) {
    res.statusCode = 404
    res.end(JSON.stringify({ error: { message: 'not found' } }))
    return
  }
  const bodyText = await readBody(req)
  let body
  try {
    body = JSON.parse(bodyText)
  } catch {
    res.statusCode = 400
    res.end(JSON.stringify({ error: { message: 'invalid json' } }))
    return
  }
  const auth = String(req.headers.authorization ?? '')
  const apiKey = auth.replace(/^Bearer\s+/i, '')
  const version = String(req.headers['x-command-code-version'] ?? '?')
  const ua = String(req.headers['user-agent'] ?? '?')
  const session = String(req.headers['x-session-id'] ?? '?')
  const slug = String(req.headers['x-project-slug'] ?? '?')
  const model = body?.params?.model ?? '?'
  const env = body?.config?.environment ?? '?'
  const messages = body?.params?.messages ?? []
  const hasTools = Array.isArray(body?.params?.tools) && body.params.tools.length > 0
  const lastUser = [...messages].reverse().find((m) => m.role === 'user' && typeof m.content === 'string')
  console.log(`[mock] ${apiKey} model=${model} env=${env} tools=${hasTools} v=${version}/${ua} session=${session} slug=${slug} lastUser=${lastUser ? lastUser.content.slice(0, 40) : '?'}`)

  if (apiKey === 'user_failkey') {
    res.statusCode = 403
    res.end(JSON.stringify({ error: { message: 'invalid key for this account' } }))
    return
  }
  if (apiKey === 'user_noplan') {
    res.statusCode = 403
    res.end(JSON.stringify({ error: { message: 'MODEL_NOT_IN_PLAN: model above Go tier' } }))
    return
  }
  if (!apiKey.startsWith('user_')) {
    res.statusCode = 401
    res.end(JSON.stringify({ error: { message: 'unauthorized' } }))
    return
  }

  res.statusCode = 200
  res.setHeader('Content-Type', 'application/x-ndjson')
  const send = (obj) => res.write(JSON.stringify(obj) + '\n')

  send({ type: 'text-start' })
  if (hasTools) {
    send({ type: 'text-delta', text: '我来帮你查一下天气。' })
    send({ type: 'tool-call', toolCallId: 'call_mock_1', toolName: 'get_weather', input: { city: '北京' } })
    send({
      type: 'finish-step',
      finishReason: 'tool_calls',
      usage: {
        inputTokens: 55,
        outputTokens: 12,
        inputTokenDetails: { noCacheTokens: 40, cacheReadTokens: 15 },
        outputTokenDetails: { textTokens: 6, reasoningTokens: 6 },
      },
    })
  } else {
    send({ type: 'text-delta', text: '你好，我是 mock 网关。' })
    send({ type: 'text-delta', text: '\n这条回复来自本地模拟流。' })
    if (body?.params?.reasoning_effort) send({ type: 'reasoning-start' })
    if (body?.params?.reasoning_effort) send({ type: 'reasoning-delta', text: '（模拟思考过程）' })
    send({
      type: 'finish-step',
      finishReason: 'end_turn',
      usage: {
        inputTokens: 42,
        outputTokens: 10,
        inputTokenDetails: { noCacheTokens: 30, cacheReadTokens: 12 },
        outputTokenDetails: { textTokens: 8, reasoningTokens: 2 },
      },
    })
  }
  res.end()
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock] Command Code 模拟网关 http://127.0.0.1:${PORT}/alpha/generate`)
  console.log(`[mock] 可用 key: user_goodkey（成功） / user_failkey（403 失败） / user_noplan（MODEL_NOT_IN_PLAN）`)
})