import { startRenderer } from './app'
import { loadConfig } from './config'

const r = await startRenderer(loadConfig())
console.log(`渲染服务已启动：${r.origin}（页面池 ${r.pool.stats().size} 个）`)
const stop = () => void r.close().finally(() => process.exit(0))
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
