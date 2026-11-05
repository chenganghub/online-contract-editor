// 本机临时环境：临时 MySQL 8（mysql-memory-server，停掉数据就没了）+ 服务端，给端到端测试和演示宿主页（apps/demo/scripts/stack.ts）用。
// mysql-memory-server 是本包的开发依赖，所以放在这里；正式部署用 main.ts
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDB } from 'mysql-memory-server'
import { buildApp } from './app'
import { loadConfig } from './config'
import { openDb } from './db/client'
import { apiClient } from './db/schema'
import type { RendererClient } from './renderer'
import { localFileStore } from './storage'
import { hashKey } from './tokens'

/** 起临时数据库和服务端（不监听端口，要监听自己调 app.listen）；返回宿主后端用的 API Key。中途失败时已起的都收掉 */
export async function startTempServer(renderer?: RendererClient) {
  const mysql = await createDB({ version: '8.4.x' })
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'oe-storage-'))
  const cleanup: (() => Promise<unknown>)[] = [async () => fs.rmSync(storage, { recursive: true, force: true }), () => mysql.stop()]
  const stop = async () => {
    for (const c of cleanup.splice(0).reverse()) await c().catch(() => {})
  }
  try {
    const url = `mysql://${mysql.username}@127.0.0.1:${mysql.port}/${mysql.dbName}`
    const { db, close } = await openDb(url)
    cleanup.push(close)
    const apiKey = `temp-${crypto.randomUUID()}`
    await db.insert(apiClient).values({ id: crypto.randomUUID(), name: '临时环境的宿主', keyHash: hashKey(apiKey) })
    const config = loadConfig({ DATABASE_URL: url, STORAGE_DIR: storage, TOKEN_SECRET: crypto.randomBytes(32).toString('hex') })
    const app = await buildApp({ config, db, store: localFileStore(storage), renderer })
    cleanup.push(() => app.close())
    // db：本机验证脚本直接改库用（比如改一条证据，看证据链能不能发现）
    return { app, apiKey, db, stop }
  } catch (e) {
    await stop()
    throw e
  }
}
