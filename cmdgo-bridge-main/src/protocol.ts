/**
 * Command Code Go wire protocol: serialize a completion call into the private
 * `/alpha/generate` gateway envelope and parse its line-delimited JSON stream
 * back into events.
 *
 * The Go plan is the only Command Code plan without Provider-API access, so
 * the standard OpenAI-compatible endpoints answer 403 `upgrade_required` for
 * a Go subscription. The CLI gateway at `POST /alpha/generate` is the
 * transport every Go-plan request must use.
 *
 * The request envelope shape mirrors the `cmd` CLI (`command-code` npm
 * package): `config.environment` is a plain string (`<os>-<arch>`), not an
 * object; gateway compatibility rides on the `x-command-code-version` header.
 *
 * @module cmdgo-bridge/protocol
 * @see https://github.com/MAXeaglet/commandcode-proxy
 * @see https://github.com/synthetic-coworkers/cmdcode2api
 */

import { platform, arch } from 'node:os'
import type { ContentBlock, GenerateOptions, Message, ToolSchema } from './types.js'

/**
 * Gateway version pinned to a known-good Command Code CLI release. The gateway
 * checks the `x-command-code-version` header against the `User-Agent` version,
 * so both must track the same CLI release (v1.31.0 — envelope verified
 * unchanged against the CLI in use when the reference plugin was written).
 */
export const CC_VERSION = '1.31.0'

/** Last-resort output cap when a request carries no maxTokens. */
export const DEFAULT_MAX_TOKENS = 64_000

/** Line-delimited JSON stream: one JSON object per line (not SSE `data:` framing). */
export interface CcStreamEvent {
  type: string
  [key: string]: unknown
}

export interface CcUsage {
  inputTokens?: number
  outputTokens?: number
  inputTokenDetails?: {
    noCacheTokens?: number
    cacheReadTokens?: number
  }
  outputTokenDetails?: {
    textTokens?: number
    reasoningTokens?: number
  }
}

/** Tool call inside an assistant message, as the gateway wants it. */
interface CcToolCallContent {
  type: 'tool-call'
  toolCallId: string
  toolName: string
  input: unknown
}

/** Tool result inside a tool-role message. */
interface CcToolResultContent {
  type: 'tool-result'
  toolCallId: string
  toolName: string
  output: { type: 'text' | 'error-text'; value: string }
}

type CcMessage =
  | { role: 'user'; content: string | unknown[] }
  | { role: 'assistant'; content: Array<{ type: 'text'; text: string } | { type: 'reasoning'; text: string } | CcToolCallContent> }
  | { role: 'tool'; content: CcToolResultContent[] }

interface CcTool {
  type: 'function'
  name: string
  description?: string
  input_schema: unknown
}

interface CcRequestEnvelope {
  config: {
    workingDir: string
    date: string
    environment: string
    structure: unknown[]
    isGitRepo: boolean
    currentBranch: string
    mainBranch: string
    gitStatus: string
    recentCommits: unknown[]
  }
  memory: string
  taste: string
  skills: null
  permissionMode: string
  params: {
    model: string
    messages: CcMessage[]
    tools: CcTool[]
    system: string
    max_tokens: number
    stream: true
    temperature?: number
    top_p?: number
    reasoning_effort?: string
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The flattened text of a message's content blocks. */
function flattenText(blocks: ContentBlock[]): string {
  return blocks
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

function toolResultOutput(
  result: Extract<ContentBlock, { type: 'tool-result' }>,
): CcToolResultContent['output'] {
  const value = flattenText(result.content)
  return result.isError
    ? { type: 'error-text', value: value || 'Execution denied' }
    : { type: 'text', value: value || '(no output)' }
}

function serializeAssistant(message: Message): Extract<CcMessage, { role: 'assistant' }> {
  const parts: Extract<CcMessage, { role: 'assistant' }>['content'] = []
  for (const block of message.content) {
    if (block.type === 'text') {
      parts.push({ type: 'text', text: block.text })
    } else if (block.type === 'reasoning') {
      parts.push({ type: 'reasoning', text: block.text })
    } else if (block.type === 'tool-call') {
      parts.push({
        type: 'tool-call',
        toolCallId: block.id,
        toolName: block.name,
        input: safeParseJson(block.arguments),
      })
    }
  }
  return { role: 'assistant', content: parts }
}

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

function serializeUser(message: Message): CcMessage {
  const toolResults = message.content.filter(
    (block): block is Extract<ContentBlock, { type: 'tool-result' }> => block.type === 'tool-result',
  )
  const text = flattenText(message.content)
  if (text.length > 0 || toolResults.length === 0) {
    return { role: 'user', content: text }
  }
  return {
    role: 'tool',
    content: toolResults.map(result => ({
      type: 'tool-result' as const,
      toolCallId: result.toolCallId,
      toolName: 'unknown',
      output: toolResultOutput(result),
    })),
  }
}

/** Build the gateway request envelope for one completion call. */
export function buildRequest(options: GenerateOptions): CcRequestEnvelope {
  let system = options.system ?? ''
  const messages: CcMessage[] = []
  for (const message of options.messages) {
    if (message.role === 'system') {
      system += (system ? '\n\n' : '') + flattenText(message.content)
      continue
    }
    messages.push(message.role === 'assistant' ? serializeAssistant(message) : serializeUser(message))
  }

  const tools: CcTool[] = (options.tools ?? [])
    .map((tool: ToolSchema) => ({
      type: 'function' as const,
      name: tool.name,
      ...tool.description === undefined ? {} : { description: tool.description },
      input_schema: tool.parameters,
    }))

  const params: CcRequestEnvelope['params'] = {
    model: options.model,
    messages,
    tools,
    system,
    max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    stream: true,
  }
  if (options.temperature !== undefined) params.temperature = options.temperature
  if (options.topP !== undefined) params.top_p = options.topP
  if (options.reasoningEffort !== undefined && options.reasoningEffort !== 'off') {
    params.reasoning_effort = options.reasoningEffort
  }

  return {
    config: {
      workingDir: process.cwd(),
      date: new Date().toISOString().split('T')[0] ?? '',
      environment: `${platform()}-${arch()}`,
      structure: [],
      isGitRepo: false,
      currentBranch: '',
      mainBranch: '',
      gitStatus: '',
      recentCommits: [],
    },
    memory: '',
    taste: '',
    skills: null,
    permissionMode: 'standard',
    params,
  }
}

function parseEventLine(line: string): CcStreamEvent | undefined {
  if (line.length === 0 || line.startsWith(':')) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  return isRecord(parsed) && typeof parsed.type === 'string' ? parsed as unknown as CcStreamEvent : undefined
}

/**
 * Parse a line-delimited JSON byte stream from `/alpha/generate` into events.
 * Lines are bare JSON objects (the gateway sends no `data:` SSE prefix).
 */
export async function* parseEventStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<CcStreamEvent> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      buffer += done ? '' : decoder.decode(value, { stream: !done })
      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        const event = parseEventLine(line)
        if (event !== undefined) yield event
      }
      if (done) {
        const tail = buffer.trim()
        const event = parseEventLine(tail)
        if (event !== undefined) yield event
        return
      }
    }
  } finally {
    reader.releaseLock()
  }
}

/** Extract the human message from a gateway error body, when present. */
export function gatewayErrorMessage(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as unknown
    if (isRecord(parsed) && isRecord(parsed.error)) {
      const message = parsed.error.message
      if (typeof message === 'string' && message.length > 0) return message
    }
  } catch {
    // Not JSON; caller falls back to the HTTP status.
  }
  return undefined
}