// 本机整套演示环境：临时 MySQL 8 + 服务端（3100）+ 渲染服务（3200）+ 演示页（5173），建一份样例合同，打印四种模式的地址。
// 在仓库根目录运行：npx tsx apps/demo/scripts/stack.ts。Ctrl+C 停止；用的是临时数据库，停了数据就没了
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { startRenderer } from '../../renderer/src/app'
import { loadConfig } from '../../renderer/src/config'
import { httpRenderer } from '../../server/src/renderer'
import { startTempServer } from '../../server/src/temp-server'
import { FIELDS, sampleDoc } from '../src/sample'

const SERVER_PORT = 3100
const DEMO_PORT = 5173
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cleanups: (() => Promise<unknown>)[] = []
let stopping = false
async function stop(code: number) {
  if (stopping) return
  stopping = true
  for (const c of [...cleanups].reverse()) await c().catch(() => {})
  process.exit(code)
}
process.on('SIGINT', () => void stop(0))
process.on('SIGTERM', () => void stop(0))

try {
  const renderer = await startRenderer(loadConfig())
  cleanups.push(() => renderer.close())
  const server = await startTempServer(httpRenderer(renderer.origin, 60_000))
  cleanups.push(() => server.stop())
  await server.app.listen({ host: '127.0.0.1', port: SERVER_PORT })

  // 宿主后端建模板、建文档（API Key 只在后端）
  const host = { authorization: `Bearer ${server.apiKey}` }
  const library = await server.app.inject({ method: 'PUT', url: '/api/field-library', headers: host, payload: { version: 0, fields: FIELDS } })
  if (library.statusCode !== 200) throw new Error(`登记字段库失败：${library.body}`)
  const t = await server.app.inject({ method: 'POST', url: '/api/templates', headers: host, payload: { name: '采购合同', doc: sampleDoc(), fields: FIELDS } })
  if (t.statusCode !== 200) throw new Error(`建模板失败：${t.body}`)
  const d = await server.app.inject({ method: 'POST', url: '/api/documents', headers: host, payload: { templateId: t.json().id, versionNo: 1 } })
  if (d.statusCode !== 200) throw new Error(`建文档失败：${d.body}`)

  // 演示宿主的后端（vite.config.ts）从环境变量拿服务端地址和 API Key
  process.env.OE_SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`
  process.env.OE_API_KEY = server.apiKey
  const vite = await createServer({ root, server: { host: '127.0.0.1', port: DEMO_PORT, strictPort: true } })
  cleanups.push(() => vite.close())
  await vite.listen()

  const url = (q: string) => `http://127.0.0.1:${DEMO_PORT}/?doc=${d.json().id}&${q}`
  console.log(
    [
      '演示环境已启动（Ctrl+C 停止，数据不保留）',
      `新建模板：http://127.0.0.1:${DEMO_PORT}/?template=new`,
      `编辑：${url('mode=edit')}`,
      `填写：${url('mode=fill&perm=contractNo:readonly')}`,
      `盖章：${url('mode=seal')}`,
      `只读：${url('mode=view')}`,
      `本地版（不接服务端）：http://127.0.0.1:${DEMO_PORT}/`,
      '打开盖章地址时开始盖章，盖完点「完成」；之后编辑和填写都只能只读打开',
      `签署（两方按顺序签保密协议）：http://127.0.0.1:${DEMO_PORT}/?signdemo（甲方张三先签；签完把地址里的 user=张三&signer=a 换成 user=李四&signer=b；短信验证码是 123456）`,
    ].join('\n'),
  )
} catch (e) {
  console.error(e)
  await stop(1)
}
