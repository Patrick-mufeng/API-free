#!/usr/bin/env node
/**
 * cmdgo-bridge — CommandCode Go 套餐独立桥接服务入口。
 *
 * 把只能走 CLI 私有网关 `POST /alpha/generate` 的 Go 订阅暴露成 OpenAI
 * 兼容 API，附自带控制台页面（OAuth 登录 / 多账号池管理 / 接入信息）。
 *
 * 用法：
 *   node dist/index.js [--host 127.0.0.1] [--port 11435] [--data-dir ~/.cmdgo-bridge]
 *
 * @module cmdgo-bridge
 */

import { ConfigStore, DEFAULT_DATA_DIR } from './config.js'
import { buildState, createBridgeServer } from './server.js'
import { initUsage } from './usage.js'

function parseArgs(argv: string[]): { host?: string; port?: number; dataDir?: string; help: boolean } {
  const out: { host?: string; port?: number; dataDir?: string; help: boolean } = { help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      out.help = true
    } else if (arg === '--host' || arg === '--port' || arg === '--data-dir') {
      const value = argv[i + 1]
      if (value === undefined) continue
      if (arg === '--host') out.host = value
      else if (arg === '--port') {
        const port = Number(value)
        if (Number.isInteger(port) && port > 0 && port < 65536) out.port = port
      } else out.dataDir = value
      i += 1
    }
  }
  return out
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(`cmdgo-bridge — CommandCode Go 套餐 OpenAI 兼容桥

用法:
  node dist/index.js [选项]

选项:
  --host <addr>     监听地址（默认 127.0.0.1）
  --port <port>     监听端口（默认 11435）
  --data-dir <dir>  数据目录（默认 ${DEFAULT_DATA_DIR}）
  --help            显示本帮助

首次运行自动生成 config.json（含客户端 API key）。浏览器打开
http://127.0.0.1:<port>/ 使用控制台完成 OAuth 登录。`)
    return
  }

  const store = new ConfigStore(args.dataDir ?? DEFAULT_DATA_DIR)
  const cfg = await store.load()
  if (args.host !== undefined) cfg.host = args.host
  if (args.port !== undefined) cfg.port = args.port
  await store.save(cfg)

  const state = buildState(cfg, store.dataDir)
  initUsage(store.dataDir)
  state.onError = (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`[cmdgo] 端口 ${cfg.port} 已被占用；换端口：node dist/index.js --port <port>`)
      process.exit(1)
    }
    console.error(`[cmdgo] 服务器错误: ${error.message}`)
    process.exit(1)
  }
  state.onListening = () => {
    const base = `http://${cfg.host === '127.0.0.1' ? '127.0.0.1' : cfg.host}:${cfg.port}`
    console.log('')
    console.log('  ┌────────────────────────────────────────────────┐')
    console.log('  │  cmdgo-bridge · Command Code Go → OpenAI 兼容   │')
    console.log('  └────────────────────────────────────────────────┘')
    console.log(`  控制台（OAuth 登录 / 账号池 / 接入信息）: ${base}/`)
    console.log(`  OpenAI 端点: ${base}/v1`)
    console.log(`  客户端 API key: ${cfg.apiKey}`)
    console.log(`  网关: ${cfg.baseURL}/alpha/generate`)
    console.log(`  数据目录: ${store.dataDir}`)
    console.log('')
    console.log('  Agent 工具接入示例:')
    console.log(`    baseURL: ${base}/v1`)
    console.log(`    apiKey : ${cfg.apiKey}`)
    console.log('')
  }
  createBridgeServer(state)
}

main().catch((error: unknown) => {
  console.error(`[cmdgo] 启动失败：${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})