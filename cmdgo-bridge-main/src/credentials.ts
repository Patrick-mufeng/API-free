/**
 * File-backed credential store implementing the pool's CredentialsSeam:
 * a flat JSON map of ref → key in the data directory.
 *
 * @module cmdgo-bridge/credentials
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { CredentialRef, CredentialsSeam } from './pool.js'

type StoreShape = Record<string, { value: string; source?: string }>

export class FileCredentials implements CredentialsSeam {
  private readonly file: string
  private cache: StoreShape | undefined

  constructor(dataDir: string) {
    this.file = join(dataDir, 'credentials.json')
  }

  private async read(): Promise<StoreShape> {
    if (this.cache !== undefined) return this.cache
    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw) as unknown
      this.cache = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? parsed as StoreShape
        : {}
    } catch {
      this.cache = {}
    }
    return this.cache
  }

  private async write(): Promise<void> {
    const store = await this.read()
    await mkdir(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${randomBytes(4).toString('hex')}.tmp`
    await writeFile(tmp, JSON.stringify(store, null, 2), 'utf8')
    await rename(tmp, this.file)
  }

  async resolve(ref: CredentialRef): Promise<{ value: string } | undefined> {
    const store = await this.read()
    const entry = store[ref]
    return entry !== undefined && entry.value.length > 0 ? { value: entry.value } : undefined
  }

  async describe(ref: CredentialRef): Promise<{ configured: boolean; source?: string }> {
    const store = await this.read()
    const entry = store[ref]
    const configured = entry !== undefined && entry.value.length > 0
    return {
      configured,
      ...(configured ? { source: entry.source ?? 'file' } : {}),
    }
  }

  async set(ref: CredentialRef, value: string): Promise<void> {
    const store = await this.read()
    store[ref] = { value, ...(store[ref]?.source === undefined ? {} : { source: store[ref].source }) }
    await this.write()
  }

  async unset(ref: CredentialRef): Promise<void> {
    const store = await this.read()
    if (store[ref] === undefined) return
    delete store[ref]
    await this.write()
  }
}