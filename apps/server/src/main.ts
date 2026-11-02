import { buildApp } from './app'
import { loadConfig } from './config'
import { openDb } from './db/client'
import { httpRenderer } from './renderer'
import { localFileStore } from './storage'
const config = loadConfig()
const { db } = await openDb(config.DATABASE_URL)
const app = await buildApp({ config, db, store: localFileStore(config.STORAGE_DIR), renderer: httpRenderer(config.RENDERER_URL, config.RENDER_TIMEOUT_MS) })
await app.listen({ host: config.HOST, port: config.PORT })
console.log(`在线编辑器服务已启动：http://${config.HOST}:${config.PORT}（渲染服务 ${config.RENDERER_URL}）`)
