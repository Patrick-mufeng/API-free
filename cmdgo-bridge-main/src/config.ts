/**
 * Server configuration: tiny JSON file, auto-created on first run with a
 * random client API key (the token agent tools must present as Bearer).
 *
 * @module cmdgo-bridge/config
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'

export interface ServerConfig {
  /** Listen host. Loopback only by default; the /v1 token protects wider binds. */
  host: string
  /** Listen port. */
  port: number
  /** Command Code gateway base URL; `/alpha/generate` is appended. */
  baseURL: string
  /** Client bearer token for the OpenAI-compatible endpoints. */
  apiKey: string
  /** Default per-request output cap. */
  maxTokens: number
  /** Model context fallback when the catalog discloses none. */
  defaultContextWindow: number
}

export const DEFAULT_DATA_DIR = join(homedir(), '.cmdgo-bridge')

export function defaultConfig(): ServerConfig {
  return {
    host: '127.0.0.1',
    port: 11435,
    baseURL: 'https://api.commandcode.ai',
    apiKey: randomBytes(24).toString('hex'),
    maxTokens: 64_000,
    defaultContextWindow: 1_000_000,
  }
}

export class ConfigStore {
  private readonly file: string
  private readonly dir: string

  constructor(dataDir: string = DEFAULT_DATA_DIR) {
    this.dir = dataDir
    this.file = join(dataDir, 'config.json')
  }

  get dataDir(): string {
    return this.dir
  }

  async load(): Promise<ServerConfig> {
    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw) as Partial<ServerConfig>
      const cfg = defaultConfig()
      if (typeof parsed.host === 'string' && parsed.host.length > 0) cfg.host = parsed.host
      if (typeof parsed.port === 'number' && Number.isInteger(parsed.port) && parsed.port > 0 && parsed.port < 65536) {
        cfg.port = parsed.port
      }
      if (typeof parsed.baseURL === 'string' && parsed.baseURL.length > 0) cfg.baseURL = parsed.baseURL
      if (typeof parsed.apiKey === 'string' && parsed.apiKey.length >= 8) cfg.apiKey = parsed.apiKey
      if (typeof parsed.maxTokens === 'number' && Number.isSafeInteger(parsed.maxTokens) && parsed.maxTokens > 0) {
        cfg.maxTokens = parsed.maxTokens
      }
      if (typeof parsed.defaultContextWindow === 'number' && Number.isSafeInteger(parsed.defaultContextWindow) && parsed.defaultContextWindow > 0) {
        cfg.defaultContextWindow = parsed.defaultContextWindow
      }
      return cfg
    } catch {
      // Missing or corrupt: start fresh (still valid — the client key regenerates).
      return defaultConfig()
    }
  }

  async save(config: ServerConfig): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const tmp = `${this.file}.${randomBytes(4).toString('hex')}.tmp`
    await writeFile(tmp, JSON.stringify(config, null, 2), 'utf8')
    await rename(tmp, this.file)
  }
}