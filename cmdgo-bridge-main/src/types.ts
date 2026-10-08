/**
 * Standalone harness-neutral type vocabulary: the subset of message/tool
 * shapes the protocol layer needs. Mirrors the dsh-llm shapes the original
 * plugin used, so `buildRequest` translation stays byte-identical.
 *
 * @module cmdgo-bridge/types
 */

/** Opaque tool-call id on the wire. */
export type CallId = string & { readonly __callId?: never }

export function CallId(id: string): CallId {
  return id as CallId
}

export interface TextBlock {
  type: 'text'
  text: string
}

export interface ReasoningBlock {
  type: 'reasoning'
  text: string
}

export interface ToolCallBlock {
  type: 'tool-call'
  id: CallId
  name: string
  arguments: string
}

export interface ToolResultBlock {
  type: 'tool-result'
  toolCallId: CallId
  content: ContentBlock[]
  isError: boolean
}

export type ContentBlock = TextBlock | ReasoningBlock | ToolCallBlock | ToolResultBlock

export interface Message {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: ContentBlock[]
}

export interface ToolSchema {
  name: string
  description?: string
  parameters: unknown
}

/** One harness completion call, protocol-layer view. */
export interface GenerateOptions {
  model: string
  messages: Message[]
  tools?: ToolSchema[]
  system?: string
  maxTokens?: number
  temperature?: number
  topP?: number
  reasoningEffort?: string
}