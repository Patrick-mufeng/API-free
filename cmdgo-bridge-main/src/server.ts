/**
 * HTTP wiring: OpenAI-compatible endpoints (`/v1/*`), the admin API the
 * console page talks to (`/api/*`), and static serving of the console itself.
 *
 * @module cmdgo-bridge/server
 */

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { appendFile } from 'node:fs/promises'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { timingSafeEqual } from 'node:crypto'
import type { ServerConfig } from './config.js'
import { AccountPool } from './pool.js'
import type { CredentialsSeam, PoolAccount } from './pool.js'
import { FileCredentials } from './credentials.js'
import { DEFAULT_STUDIO_BASE, CommandCodeLoginManager } from './oauth.js'
import type { LoginSuccessInfo, LoginStatus } from './oauth.js'
import { fetchCatalogEfforts, fetchGoModels } from './models.js'
import { initUsage, recordUsage, usageSnapshot } from './usage.js'
import {
  ClientError,
  GatewayError,
  applyEvent,
  buildNonStream,
  chatCompletionId,
  emptyAccumulator,
  openGateway,
  parseChatRequest,
} from './openai.js'
import type { ChatRequest, Accumulator } from './openai.js'

/** Catalog refresh cadence; the listing is stable so slow polling is fine. */
const REFRESH_MS = 15 * 60_000
/** Request body cap（LLM 对话请求可到数 MB，只拦真正的滥用）。 */
const BODY_CAP = 8 * 1024 * 1024

export interface BridgeModel {
  id: string
  name: string
  contextWindow: number
  efforts?: string[]
}

export interface BridgeState {
  cfg: ServerConfig
  credentials: CredentialsSeam
  pool: AccountPool
  login: CommandCodeLoginManager
  /** Called once the primary loopback listener is up. */
  onListening?: () => void
  /** Fatal server error (e.g. EADDRINUSE); the caller decides to exit. */
  onError?: (error: NodeJS.ErrnoException) => void
}

const INDEX_FILE = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'public', 'index.html')
/** 访问/聊天日志落盘：无论桥由谁启动(控制台 vs 双击脚本)都可追溯。 */
const ACCESS_LOG_FILE = join(homedir(), '.cmdgo-bridge', 'access.log')

function logLine(line: string): void {
  console.log(line)
  void appendFile(ACCESS_LOG_FILE, `${line}\n`).catch(() => {})
}

function json(res: ServerResponse, statusCode: number, body: unknown): void {
  if (res.writableEnded) return
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

function cors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  let overflow = false
  await new Promise<void>((resolve) => {
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (!overflow && size <= BODY_CAP && chunk !== undefined) chunks.push(chunk)
      else overflow = true
    })
    req.on('end', () => resolve())
    req.on('error', () => resolve())
  })
  if (overflow) throw new ClientError('request body too large (max 8 MiB)', 413)
  if (chunks.length === 0) return {}
  const raw = Buffer.concat(chunks).toString('utf8')
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    logLine(`[cmdgo] body parse failed (${raw.length} bytes)`)
    throw new ClientError('invalid JSON body')
  }
}

export function createBridgeServer(state: BridgeState): Server {
  const { cfg, credentials, pool, login } = state

  // 池预热：账号池是懒加载的，不预读的话启动后的第一个请求会误报
  // MISSING_CREDENTIAL（池 size=0，pick 不到账号）。立即加载一次。
  void pool.list().catch(() => {})

  /** 模型目录实时视图；sync() 换入新目录后接口立刻可见。 */
  const holder: { current: BridgeModel[] } = { current: [] }
  const models = (): readonly BridgeModel[] => holder.current
  let indexCache: string | undefined
  void readFile(INDEX_FILE, 'utf8').then((text) => { indexCache = text }).catch(() => { indexCache = undefined })

  // --- OAuth 登录生命周期（与插件侧一致：幂等 start + 后台等待 + 入池持久化） ---
  let loginPromise: Promise<LoginSuccessInfo> | undefined
  const log = (message: string) => { console.log(`[cmdgo] ${message}`) }

  async function persistKey(info: LoginSuccessInfo): Promise<void> {
    try {
      const known = await pool.findByKey(credentials, info.apiKey)
      if (known !== undefined) {
        pool.touchMeta(known, { userName: info.userName, keyName: info.keyName })
        log(`该 key 已在账号池（${known.id}），仅刷新标签`)
        return
      }
      const account = await pool.add(credentials, info)
      log(`API key 已入池 ${account.ref}${info.userName === undefined ? '' : `（user=${info.userName}）`}`)
    } catch (error) {
      log(`凭据写入失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async function beginLogin(): Promise<{ authUrl: string; callbackUrl: string }> {
    const started = await login.start({ studioBase: DEFAULT_STUDIO_BASE })
    if (loginPromise === undefined || !login.isWaiting()) {
      loginPromise = login.waitForCallback().then(
        (info) => { void persistKey(info); return info },
        (error: unknown) => {
          log(`登录结束：${error instanceof Error ? error.message : String(error)}`)
          throw error
        },
      )
      // 后台等待；拒绝由上面分支记录，避免 unhandled rejection。
      loginPromise.catch(() => {})
    }
    return started
  }

  interface StatusSnapshot {
    ok: boolean
    provider: string
    baseURL: string
    endpoint: string
    apiKey: string
    maxTokens: number
    modelCount: number
    modelIds: string[]
    login: LoginStatus
    activeAccounts: number
    accounts: unknown[]
  }

  async function statusSnapshot(): Promise<StatusSnapshot> {
    const snapshot = models()
    const now = Date.now()
    const rows = await Promise.all((await pool.list()).map(async (account: PoolAccount) => {
      let accountConfigured = false
      try { accountConfigured = (await credentials.describe(account.ref)).configured } catch { /* 视为缺失 */ }
      return {
        id: account.id,
        ref: account.ref,
        ...(account.userName === undefined ? {} : { userName: account.userName }),
        ...(account.keyName === undefined ? {} : { keyName: account.keyName }),
        addedAt: account.addedAt,
        enabled: account.enabled,
        failCount: account.failCount,
        cooling: (account.cooldownUntil ?? 0) > now,
        ...(account.lastError === undefined ? {} : { lastError: account.lastError }),
        configured: accountConfigured,
      }
    }))
    const endpoint = `http://${cfg.host === '0.0.0.0' ? '127.0.0.1' : cfg.host}:${cfg.port}/v1`
    return {
      ok: true,
      provider: 'commandcode',
      baseURL: cfg.baseURL,
      endpoint,
      apiKey: cfg.apiKey,
      maxTokens: cfg.maxTokens,
      modelCount: snapshot.length,
      modelIds: snapshot.map(m => m.id),
      login: login.status,
      activeAccounts: pool.activeCount(now),
      accounts: rows,
    }
  }

  /** 请求承载的 bearer token 是否与配置一致（常数时间比较）。 */
  function authorized(req: IncomingMessage): boolean {
    const header = req.headers.authorization
    if (typeof header !== 'string') return false
    const match = /^Bearer\s+(.+)$/i.exec(header)
    if (match === null) return false
    const presented = Buffer.from(match[1] ?? '')
    const expected = Buffer.from(cfg.apiKey)
    if (presented.length !== expected.length) return false
    return timingSafeEqual(presented, expected)
  }

  /* ---------------- /v1/* : OpenAI 兼容面 ---------------- */

  function handleModelsList(_req: IncomingMessage, res: ServerResponse): void {
    json(res, 200, {
      object: 'list',
      data: models().map(m => ({
        id: m.id,
        object: 'model',
        created: 0,
        owned_by: 'commandcode',
      })),
    })
  }

  function openaiErrorBody(message: string, code: string): unknown {
    return { error: { message, type: 'invalid_request_error', code, param: null } }
  }

  async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: Record<string, unknown>
    let chat: ChatRequest
    try {
      body = await readBody(req)
      chat = parseChatRequest(body)
    } catch (error) {
      const message = error instanceof ClientError ? error.message : 'invalid request'
      const status = error instanceof ClientError ? error.httpStatus : 400
      json(res, status, openaiErrorBody(message, 'invalid_request_error'))
      logLine(`[cmdgo] chat 请求被拒 ${status} ${message}`)
      return
    }

    const controller = new AbortController()
    res.on('close', () => controller.abort())
    const startedAt = Date.now()
    const ctx = {
      cfg,
      pool,
      credentials,
      signal: controller.signal,
      onAccount: (account: PoolAccount) => {
        logLine(`[cmdgo] chat 开始 model=${chat.model} stream=${chat.stream} account=${account.id}`)
      },
    }
    const logOutcome = (outcome: string, detail = ''): void => {
      logLine(`[cmdgo] chat 结束 model=${chat.model} stream=${chat.stream} ${outcome} ${Date.now() - startedAt}ms${detail ? ` ${detail}` : ''}`)
    }

    if (!chat.stream) {
      try {
        const acc = emptyAccumulator()
        let finished = false
        for await (const event of openGateway(chat, ctx)) {
          applyEvent(acc, event)
          if (event.type === 'finish-step') { finished = true; break }
        }
        if (!finished) throw new GatewayError('Command Code 网关未发送 finish-step', 502, 'STREAM_CLOSED')
        json(res, 200, buildNonStream(chat, acc))
        recordUsage(acc.promptTokens, acc.completionTokens)
        logOutcome('ok')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (error instanceof ClientError) {
          json(res, error.httpStatus, openaiErrorBody(message, 'invalid_request_error'))
          logOutcome('client-error', message)
        } else if (error instanceof GatewayError) {
          json(res, error.httpStatus, openaiErrorBody(message, error.code))
          logOutcome(`error ${error.code}`, message)
        } else {
          json(res, 500, openaiErrorBody(message, 'INTERNAL'))
          logOutcome('error INTERNAL', message)
        }
      }
      return
    }

    // 流式：请求校验一过就提交 SSE 头——真实网关首 token 可能数秒，
    // 等上游首个事件再发头会让带首字节超时的客户端误判连接失败。
    res.statusCode = 200
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    cors(res)
    // 立即送出响应头：setHeader 只是登记，flushHeaders 才真正发出去；
    // 否则首 token 之前的等待期里客户端收不到任何字节。
    res.flushHeaders()

    const id = chatCompletionId()
    const created = Math.floor(Date.now() / 1000)
    const meta = { id, object: 'chat.completion.chunk', created, model: chat.model }
    const emit = (chunk: unknown): void => {
      if (res.writableEnded) return
      res.write(`data: ${JSON.stringify(chunk)}\n\n`)
    }
    const choice = (delta: unknown, finishReason: string | null) => ({
      ...meta, choices: [{ index: 0, delta, finish_reason: finishReason }],
    })

    const acc: Accumulator = emptyAccumulator()
    let roleSent = false
    const emitDelta = (delta: Record<string, unknown>): void => {
      if (!roleSent && Object.keys(delta).length > 0) {
        delta = { role: 'assistant', ...delta }
        roleSent = true
      }
      emit(choice(delta, null))
    }

    const apply = (event: { type: string; [key: string]: unknown }): void => {
      applyEvent(acc, event)
      switch (event.type) {
        case 'text-delta': {
          const text = typeof event.text === 'string' ? event.text : ''
          if (text.length > 0) emitDelta({ content: text })
          break
        }
        case 'reasoning-delta': {
          const text = typeof event.text === 'string' ? event.text : ''
          if (text.length > 0) emitDelta({ reasoning_content: text })
          break
        }
        case 'tool-call': {
          const tc = acc.toolCalls[acc.toolCalls.length - 1]
          if (tc !== undefined) {
            emitDelta({
              tool_calls: [{
                index: acc.toolCalls.length - 1,
                id: tc.id,
                type: 'function',
                function: { name: tc.name, arguments: tc.arguments },
              }],
            })
          }
          break
        }
        default:
          break
      }
    }

    try {
      for await (const event of openGateway(chat, ctx)) {
        apply(event)
        if (event.type === 'finish-step') break
      }
      logOutcome('ok')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const code = error instanceof GatewayError ? error.code
        : error instanceof ClientError ? 'invalid_request_error'
          : 'INTERNAL'
      logOutcome(`error ${code}`, message)
      // 头已发出，无法改状态码：以事件形式告知客户端。
      emit({ ...meta, choices: [], error: { message, type: code, code } })
    }
    if (!res.writableEnded) {
      emit(choice({}, acc.finishReason ?? 'stop'))
      emit({ ...meta, choices: [], usage: {
        prompt_tokens: acc.promptTokens,
        completion_tokens: acc.completionTokens,
        total_tokens: acc.promptTokens + acc.completionTokens,
        prompt_tokens_details: { cached_tokens: acc.cacheReadTokens },
        completion_tokens_details: { reasoning_tokens: acc.reasoningTokens },
      } })
      recordUsage(acc.promptTokens, acc.completionTokens)
      res.end('data: [DONE]\n\n')
    }
  }

  /* ---------------- /api/* : 控制台管理面 ---------------- */

  async function handleApi(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    const action = pathname.slice('/api'.length) || '/'
    if (req.method === 'GET' && (action === '/status' || action === '/')) {
      json(res, 200, await statusSnapshot())
      return
    }
    if (req.method === 'POST' && action === '/login') {
      await readBody(req)
      const started = await beginLogin()
      json(res, 200, { ok: true, ...started })
      return
    }
    if (req.method === 'POST' && action === '/cancel') {
      await readBody(req)
      await login.stop('用户取消')
      json(res, 200, { ok: true })
      return
    }
    if (req.method === 'POST' && action === '/account/toggle') {
      const body = await readBody(req)
      const id = typeof body.id === 'string' ? body.id : ''
      const enabled = body.enabled === true
      const changed = id.length > 0 && pool.toggle(id, enabled)
      json(res, changed ? 200 : 404, changed ? { ok: true } : { ok: false, error: '账号不存在或状态未变化' })
      return
    }
    if (req.method === 'POST' && action === '/account/remove') {
      const body = await readBody(req)
      const id = typeof body.id === 'string' ? body.id : ''
      if (id.length === 0) {
        json(res, 400, { ok: false, error: 'missing id' })
        return
      }
      const removed = await pool.remove(credentials, id)
      json(res, removed ? 200 : 404, removed ? { ok: true } : { ok: false, error: '账号不存在' })
      return
    }
    if (req.method === 'GET' && action === '/usage') {
      json(res, 200, { ok: true, ...usageSnapshot() })
      return
    }
    if (req.method === 'POST' && action === '/logout') {
      await readBody(req)
      const removed = await pool.clear(credentials)
      json(res, 200, { ok: true, removed })
      return
    }
    json(res, 404, { ok: false, error: `unknown action: ${action}` })
  }

  /* ---------------- 路由 ---------------- */

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.on('error', () => {})
    cors(res)
    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      res.end()
      return
    }
    const url = new URL(req.url ?? '/', 'http://localhost')
    const pathname = url.pathname
    // 访问日志：任何到达桥的请求都会留痕（含客户端断连）。
    const accessStartedAt = Date.now()
    const logAccess = (note = ''): void => {
      const status = res.statusCode === 200 ? '' : ` ${res.statusCode}`
      logLine(`[cmdgo] ${req.method ?? '?'} ${pathname}${status} ${Date.now() - accessStartedAt}ms${note ? ` ${note}` : ''}`)
    }
    res.on('finish', () => logAccess())
    res.on('close', () => { if (!res.writableFinished) logAccess('(client closed)') })
    try {
      // 控制台页面（本机管理面，不开鉴权；监听非回环地址时注意局域网暴露）。
      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        if (indexCache === undefined) {
          json(res, 404, { ok: false, error: 'console page not built' })
        } else {
          res.statusCode = 200
          res.setHeader('Content-Type', 'text/html; charset=utf-8')
          res.end(indexCache)
        }
        return
      }
      if (req.method === 'GET' && pathname === '/favicon.ico') {
        res.statusCode = 204
        res.end()
        return
      }
      if (req.method === 'GET' && pathname === '/health') {
        const snapshot = await statusSnapshot()
        json(res, 200, {
          ok: true,
          service: 'cmdgo-bridge',
          version: '0.1.0',
          accounts: snapshot.accounts.length,
          activeAccounts: snapshot.activeAccounts,
          models: snapshot.modelCount,
        })
        return
      }
      if (pathname.startsWith('/v1/')) {
        if (!authorized(req)) {
          json(res, 401, openaiErrorBody('无效或缺失的 API key（Authorization: Bearer <key>）', 'invalid_api_key'))
          return
        }
        const route = pathname.replace(/\/+$/, '')
        if (req.method === 'GET' && route === '/v1/models') {
          handleModelsList(req, res)
          return
        }
        if (req.method === 'POST' && route === '/v1/chat/completions') {
          await handleChat(req, res)
          return
        }
        json(res, 404, openaiErrorBody(`unknown /v1 route: ${pathname}`, 'not_found'))
        return
      }
      if (pathname.startsWith('/api')) {
        await handleApi(req, res, pathname)
        return
      }
      json(res, 404, { ok: false, error: `not found: ${pathname}` })
    } catch (error) {
      if (res.writableEnded) return
      json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /* ---------------- 模型目录同步 ---------------- */

  async function sync(): Promise<void> {
    const entries = await fetchGoModels()
    if (entries.length === 0) throw new Error('no Go models found; keeping the previous catalog')
    let efforts = new Map<string, string[]>()
    try {
      efforts = await fetchCatalogEfforts()
    } catch (error) {
      console.log(`[cmdgo] effort catalog scan failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    const next = entries.map(entry => ({
      id: entry.id,
      name: entry.name,
      contextWindow: entry.contextWindow,
      ...(efforts.get(entry.id) === undefined ? {} : { efforts: efforts.get(entry.id)! }),
    }))
    const same = next.length === holder.current.length
      && next.every((m, i) => m.id === holder.current[i]?.id)
    if (same) return
    holder.current = next
    console.log(`[cmdgo] synced ${next.length} Go model(s): ${next.map(m => m.id).join(', ')}`)
  }
  void sync().catch((error: unknown) => {
    console.log(`[cmdgo] 初始模型目录扫描失败: ${error instanceof Error ? error.message : String(error)}`)
  })
  const refreshTimer = setInterval(() => {
    void sync().catch((error: unknown) => {
      console.log(`[cmdgo] 模型目录刷新失败: ${error instanceof Error ? error.message : String(error)}`)
    })
  }, REFRESH_MS)
  refreshTimer.unref?.()

  // 监听：主 IPv4 回环；host 为默认回环时同时挂 IPv6 回环——
  // 有些客户端把 localhost 解析成 ::1，只有 IPv4 监听会被拒绝连接。
  const server = createServer((req: IncomingMessage, res: ServerResponse) => { void handleRequest(req, res) })
  if (state.onError !== undefined) server.on('error', state.onError)
  server.listen(cfg.port, cfg.host, state.onListening)
  if (cfg.host === '127.0.0.1') {
    const v6 = createServer((req: IncomingMessage, res: ServerResponse) => { void handleRequest(req, res) })
    v6.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EADDRNOTAVAIL') logLine(`[cmdgo] IPv6 回环监听失败（忽略）: ${error.message}`)
    })
    v6.listen(cfg.port, '::1')
  }
  return server
}

export function buildState(cfg: ServerConfig, dataDir: string): BridgeState {
  const credentials = new FileCredentials(dataDir)
  return {
    cfg,
    credentials,
    pool: new AccountPool({ baseRef: 'COMMANDCODE_API_KEY', dataDir, log: (m) => console.log(`[cmdgo] ${m}`) }),
    login: new CommandCodeLoginManager((m) => console.log(`[cmdgo] ${m}`)),
  }
}