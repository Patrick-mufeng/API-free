/**
 * OpenAI-compatible translation: parse `/v1/chat/completions` bodies into the
 * harness-neutral vocabulary, drive the `/alpha/generate` gateway with
 * multi-account failover, and translate gateway events back into OpenAI
 * stream / non-stream shapes.
 *
 * @module cmdgo-bridge/openai
 */

import { randomBytes } from 'node:crypto'
import type { ServerConfig } from './config.js'
import type { AccountPool, CredentialsSeam, PoolAccount } from './pool.js'
import {
  CC_VERSION,
  DEFAULT_MAX_TOKENS,
  buildRequest,
  gatewayErrorMessage,
  parseEventStream,
} from './protocol.js'
import type { CcStreamEvent } from './protocol.js'
import { CallId } from './types.js'
import type { ContentBlock, GenerateOptions, Message, ToolSchema } from './types.js'

/** Parsed and normalized chat completion request. */
export interface ChatRequest {
  model: string
  messages: Message[]
  stream: boolean
  maxTokens?: number
  temperature?: number
  topP?: number
  reasoningEffort?: string
  tools?: ToolSchema[]
}

/** Request-side validation failure; mapped to a 4xx JSON error. */
export class ClientError extends Error {
  constructor(message: string, readonly httpStatus = 400) {
    super(message)
  }
}

/** Gateway-side failure; carries the HTTP status to surface to the client. */
export class GatewayError extends Error {
  constructor(message: string, readonly httpStatus: number, readonly code: string) {
    super(message)
  }
}

/** Error codes that justify switching to another account within one request. */
const FAILOVER_CODES = new Set(['AUTH', 'RATE_LIMIT', 'SERVER', 'TRANSPORT'])

/** Hard cap on same-request key failovers, even for very large pools. */
const MAX_FAILOVER_ATTEMPTS = 4

/** Total per-request budget for a single upstream exchange. */
export const REQUEST_TIMEOUT_MS = 300_000

/** CLI-shaped session id, mirroring the id the official `cmd` CLI mints. */
const SESSION_ID = `cli-${new Date().toISOString().replace(/\.\d{3}Z$/, '').replace(/:/g, '-')}`

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/* ---------------- request parsing ---------------- */

function parseContent(raw: unknown): ContentBlock[] {
  const blocks: ContentBlock[] = []
  if (typeof raw === 'string') {
    if (raw.length > 0) blocks.push({ type: 'text', text: raw })
  } else if (Array.isArray(raw)) {
    for (const part of raw) {
      if (!isRecord(part)) continue
      if (part.type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
        blocks.push({ type: 'text', text: part.text })
      }
      // image_url parts are skipped: the gateway envelope in this bridge is text-only.
    }
  }
  return blocks
}

/** OpenAI chat messages → harness Message[] (system stays a role; buildRequest merges it). */
function convertMessages(rawMessages: unknown): Message[] {
  if (!Array.isArray(rawMessages)) throw new ClientError('"messages" must be an array')
  const messages: Message[] = []
  for (const raw of rawMessages) {
    if (!isRecord(raw)) throw new ClientError('every message must be an object')
    const role = raw.role
    const blocks = parseContent(raw.content)
    if (role === 'system' || role === 'developer') {
      messages.push({ role: 'system', content: blocks })
      continue
    }
    if (role === 'user') {
      messages.push({ role: 'user', content: blocks })
      continue
    }
    if (role === 'assistant' || role === 'reasoning') {
      const reasoning = role === 'reasoning'
        ? blocks.map(b => b.type === 'text' ? { type: 'reasoning' as const, text: b.text } : b)
        : (optionalString(raw.reasoning_content) === undefined ? [] : [{ type: 'reasoning' as const, text: optionalString(raw.reasoning_content)! }])
      for (const block of reasoning) blocks.push(block)
      if (Array.isArray(raw.tool_calls)) {
        for (const toolCall of raw.tool_calls) {
          if (!isRecord(toolCall)) continue
          const fn = isRecord(toolCall.function) ? toolCall.function : {}
          const name = optionalString(fn.name) ?? ''
          const args = typeof fn.arguments === 'string'
            ? fn.arguments
            : JSON.stringify(fn.arguments ?? {})
          blocks.push({
            type: 'tool-call',
            id: CallId(optionalString(toolCall.id) ?? ''),
            name,
            arguments: args,
          })
        }
      }
      messages.push({ role: 'assistant', content: blocks })
      continue
    }
    if (role === 'tool') {
      const toolCallId = optionalString(raw.tool_call_id)
      if (toolCallId === undefined) throw new ClientError('tool message missing "tool_call_id"')
      messages.push({
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: CallId(toolCallId), content: blocks, isError: false }],
      })
      continue
    }
    throw new ClientError(`unsupported message role: ${String(role)}`)
  }
  return messages
}

function positiveInt(value: unknown, fallback: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function parseChatRequest(body: unknown): ChatRequest {
  if (!isRecord(body)) throw new ClientError('request body must be a JSON object')
  const model = optionalString(body.model)
  if (model === undefined) throw new ClientError('missing required field: "model"')
  const rawTools = Array.isArray(body.tools) ? body.tools : undefined
  const tools: ToolSchema[] | undefined = rawTools?.map((raw): ToolSchema => {
    if (isRecord(raw) && isRecord(raw.function)) {
      const fn = raw.function
      const description = optionalString(fn.description)
      return {
        name: optionalString(fn.name) ?? '',
        ...(description === undefined ? {} : { description }),
        parameters: fn.parameters ?? { type: 'object', properties: {} },
      }
    }
    return { name: '', parameters: { type: 'object', properties: {} } }
  }).filter(tool => tool.name.length > 0)
  const maxTokens = positiveInt(body.max_tokens, positiveInt(body.max_completion_tokens, undefined))
    ?? DEFAULT_MAX_TOKENS
  return {
    model,
    messages: convertMessages(body.messages),
    stream: body.stream === true,
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(optionalNumber(body.temperature) === undefined ? {} : { temperature: optionalNumber(body.temperature) }),
    ...(optionalNumber(body.top_p) === undefined ? {} : { topP: optionalNumber(body.top_p) }),
    ...(optionalString(body.reasoning_effort) === undefined ? {} : { reasoningEffort: optionalString(body.reasoning_effort) }),
    ...(tools === undefined ? {} : { tools }),
  }
}

/* ---------------- gateway call with multi-account failover ---------------- */

export interface CompletionContext {
  cfg: ServerConfig
  pool: AccountPool
  credentials: CredentialsSeam
  /** Optional external abort (e.g. client disconnect). */
  signal?: AbortSignal
  /** Called with the account selected for each attempt (logging). */
  onAccount?: (account: PoolAccount) => void
}

/** Map a gateway HTTP status / error body to a stable failure code. */
function gatewayCode(status: number, body: string): string {
  if (status === 401 || status === 403) {
    // MODEL_NOT_IN_PLAN is a plan/permission failure, not a credential one.
    return body.includes('MODEL_NOT_IN_PLAN') ? 'PERMISSION' : 'AUTH'
  }
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) {
    return /context|token limit|too many tokens|context length/i.test(body) ? 'CONTEXT_WINDOW_EXCEEDED' : 'INVALID_REQUEST'
  }
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

/** Failure code → HTTP status surfaced on the OpenAI side. */
export function clientStatus(code: string): number {
  switch (code) {
    case 'MISSING_CREDENTIAL':
    case 'AUTH':
      return 401
    case 'PERMISSION':
      return 403
    case 'RATE_LIMIT':
      return 429
    case 'CONTEXT_WINDOW_EXCEEDED':
    case 'INVALID_REQUEST':
      return 400
    case 'TIMEOUT':
      return 504
    default:
      return 502
  }
}

function toGenerateOptions(req: ChatRequest): GenerateOptions {
  return {
    model: req.model,
    messages: req.messages,
    ...(req.tools === undefined ? {} : { tools: req.tools }),
    ...(req.maxTokens === undefined ? {} : { maxTokens: req.maxTokens }),
    ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
    ...(req.topP === undefined ? {} : { topP: req.topP }),
    ...(req.reasoningEffort === undefined ? {} : { reasoningEffort: req.reasoningEffort }),
  }
}

/** One guarded upstream exchange; account success clears its failure bookkeeping. */
async function* gatewayStream(
  req: ChatRequest,
  ctx: CompletionContext,
  apiKey: string,
  account: PoolAccount,
): AsyncGenerator<CcStreamEvent> {
  const body = buildRequest(toGenerateOptions(req))
  const totalBudget = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const signal = ctx.signal === undefined ? totalBudget : AbortSignal.any([ctx.signal, totalBudget])
  let response: Response
  try {
    response = await fetch(`${ctx.cfg.baseURL.replace(/\/+$/, '')}/alpha/generate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // 请求指纹与官方 cmd CLI 对齐：UA 版本与 x-command-code-version 必须一致。
        'user-agent': `commandcode/${CC_VERSION}`,
        'x-command-code-version': CC_VERSION,
        'x-cli-environment': 'production',
        'x-taste-learning': 'false',
        'x-session-id': SESSION_ID,
        'x-project-slug': 'cmdgo-bridge',
        'authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    })
  } catch (error) {
    if (ctx.signal?.aborted) throw error
    if (signal.aborted) throw new GatewayError('Command Code 网关请求超时', 504, 'TIMEOUT')
    throw new GatewayError(
      `Command Code 请求失败：${error instanceof Error ? error.message : String(error)}`,
      502,
      'TRANSPORT',
    )
  }
  if (!response.ok) {
    const raw = await response.text().catch(() => '')
    const message = gatewayErrorMessage(raw) ?? `Command Code API error (HTTP ${response.status})`
    const code = gatewayCode(response.status, raw)
    throw new GatewayError(`${message} [model=${req.model}]`, clientStatus(code), code)
  }
  // 网关已接受该 key：清掉账号上的失败记账。
  ctx.pool.reportSuccess(account)
  if (!response.body) throw new GatewayError('Command Code 网关返回了空响应体', 502, 'EMPTY_RESPONSE')
  yield* parseEventStream(response.body)
}

/**
 * Stream gateway events for one completion, failing over to the next pool
 * account on pre-first-byte auth / rate-limit / server / transport errors.
 * Once an event has been yielded, errors propagate unchanged — a half-delivered
 * answer must never be silently replayed.
 */
export async function* openGateway(req: ChatRequest, ctx: CompletionContext): AsyncGenerator<CcStreamEvent> {
  const attempts = Math.max(1, Math.min(Math.max(1, ctx.pool.size), MAX_FAILOVER_ATTEMPTS))
  for (let attempt = 0; attempt < attempts; attempt++) {
    const account = ctx.pool.size > 0 ? ctx.pool.pick() : undefined
    const apiKey = account === undefined ? undefined : await ctx.pool.keyOf(ctx.credentials, account)
    if (account === undefined || apiKey === undefined) {
      throw new GatewayError('没有可用的 Command Code 账号凭据；请先在控制台完成 OAuth 登录', 401, 'MISSING_CREDENTIAL')
    }
    ctx.onAccount?.(account)
    let yielded = false
    try {
      for await (const event of gatewayStream(req, ctx, apiKey, account)) {
        yielded = true
        yield event
      }
      return
    } catch (error) {
      if (yielded || attempt >= attempts - 1) throw error
      if (!(error instanceof GatewayError) || !FAILOVER_CODES.has(error.code)) throw error
      ctx.pool.reportFailure(account, error.message)
    }
  }
}

/* ---------------- event accumulation ---------------- */

export interface ToolCallRecord {
  id: string
  name: string
  arguments: string
}

export interface Accumulator {
  content: string
  reasoning: string
  toolCalls: ToolCallRecord[]
  finishReason: string | null
  promptTokens: number
  completionTokens: number
  cacheReadTokens: number
  reasoningTokens: number
}

export function emptyAccumulator(): Accumulator {
  return {
    content: '',
    reasoning: '',
    toolCalls: [],
    finishReason: null,
    promptTokens: 0,
    completionTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
  }
}

/** Fold one gateway event into the accumulator. */
export function applyEvent(acc: Accumulator, event: CcStreamEvent): void {
  switch (event.type) {
    case 'text-delta': {
      const text = typeof event.text === 'string' ? event.text : ''
      acc.content += text
      break
    }
    case 'reasoning-delta': {
      const text = typeof event.text === 'string' ? event.text : ''
      acc.reasoning += text
      break
    }
    case 'tool-call': {
      const id = typeof event.toolCallId === 'string' ? event.toolCallId
        : typeof event.id === 'string' ? event.id
          : ''
      const name = typeof event.toolName === 'string' ? event.toolName : ''
      const input = event.input ?? event.args ?? event.arguments
      acc.toolCalls.push({
        id,
        name,
        arguments: JSON.stringify(input ?? {}),
      })
      break
    }
    case 'finish-step': {
      acc.finishReason = finishReasonOf(event.finishReason ?? event.rawFinishReason ?? 'stop')
      const usage = isRecord(event.usage) ? event.usage : undefined
      if (usage !== undefined) {
        const inputDetails = isRecord(usage.inputTokenDetails) ? usage.inputTokenDetails : undefined
        const outputDetails = isRecord(usage.outputTokenDetails) ? usage.outputTokenDetails : undefined
        const cacheRead = optionalNumber(inputDetails?.cacheReadTokens)
        const noCache = optionalNumber(inputDetails?.noCacheTokens)
        const totalInput = optionalNumber(usage.inputTokens)
        acc.promptTokens = noCache ?? (totalInput !== undefined && cacheRead !== undefined
          ? Math.max(0, totalInput - cacheRead)
          : totalInput) ?? 0
        acc.cacheReadTokens = cacheRead ?? 0
        acc.completionTokens = optionalNumber(usage.outputTokens) ?? optionalNumber(outputDetails?.textTokens) ?? 0
        acc.reasoningTokens = optionalNumber(outputDetails?.reasoningTokens) ?? 0
      }
      break
    }
    default:
      break
  }
}

/** Map the gateway finish-reason vocabulary to the OpenAI one. */
function finishReasonOf(raw: unknown): string {
  const reason = typeof raw === 'string' ? raw : 'stop'
  switch (reason) {
    case 'stop':
    case 'end_turn':
      return 'stop'
    case 'tool_calls':
    case 'tool-calls':
      return 'tool_calls'
    case 'length':
    case 'max_tokens':
    case 'max-output-tokens':
      return 'length'
    default:
      return 'stop'
  }
}

/* ---------------- response assembly ---------------- */

export function chatCompletionId(): string {
  return `chatcmpl-${randomBytes(8).toString('hex')}`
}

function usageObject(acc: Accumulator): unknown {
  return {
    prompt_tokens: acc.promptTokens,
    completion_tokens: acc.completionTokens,
    total_tokens: acc.promptTokens + acc.completionTokens,
    prompt_tokens_details: { cached_tokens: acc.cacheReadTokens },
    completion_tokens_details: { reasoning_tokens: acc.reasoningTokens },
  }
}

function toolCallsObject(calls: ToolCallRecord[]): unknown[] {
  return calls.map(call => ({
    id: call.id,
    type: 'function',
    function: { name: call.name, arguments: call.arguments },
  }))
}

/** Non-streaming chat completion body. */
export function buildNonStream(req: ChatRequest, acc: Accumulator): unknown {
  return {
    id: chatCompletionId(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: req.model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: acc.content,
        ...(acc.reasoning.length > 0 ? { reasoning_content: acc.reasoning } : {}),
        ...(acc.toolCalls.length > 0 ? { tool_calls: toolCallsObject(acc.toolCalls) } : {}),
      },
      finish_reason: acc.finishReason ?? 'stop',
    }],
    usage: usageObject(acc),
  }
}