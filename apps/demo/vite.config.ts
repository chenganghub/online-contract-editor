import type { IncomingMessage } from 'node:http'
import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import { CUSTOMERS, HOST_TOKEN, queryCustomers } from './src/customers'
import { createFromOrder, issueToken, openTemplate, type ServerApi, type TokenRequest } from './src/host-backend'
import { PAY_OPTIONS } from './src/sample'

// 开发时的模拟客户接口（npx vite 时可用）；没带宿主登录态返回 401
const mockApi = (): Plugin => ({
  name: 'oe-demo-mock-api',
  configureServer(server) {
    server.middlewares.use('/api/payment-methods', (req, res) => {
      if (req.headers.authorization !== HOST_TOKEN) { res.statusCode = 401; return res.end() }
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify(PAY_OPTIONS))
    })
    server.middlewares.use('/api/customers', (req, res) => {
      if (req.headers.authorization !== HOST_TOKEN) {
        res.statusCode = 401
        return res.end()
      }
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify(queryCustomers(CUSTOMERS, new URL(req.url ?? '/', 'http://x').searchParams)))
    })
  },
})

// 演示宿主的后端：scripts/stack.ts 起整套环境时给 OE_SERVER_URL 和 OE_API_KEY。
// /host/token 用宿主登录态换文档令牌（host-backend.ts）；/api/documents 原样转给服务端
const SERVER = process.env.OE_SERVER_URL
const API_KEY = process.env.OE_API_KEY
/** 读请求体；超过 64 KB（按字节）的不再往内存里攒，读完返回 null（要令牌的请求体只有几百字节） */
const readBody = (req: IncomingMessage, limit = 64 * 1024) =>
  new Promise<string | null>((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size <= limit) chunks.push(c)
    })
    req.on('end', () => resolve(size > limit ? null : Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
const hostBackend = (): Plugin => ({
  name: 'oe-demo-host-backend',
  configureServer(server) {
    server.middlewares.use('/host', async (req, res, next) => {
      const route = new URL(req.url ?? '/', 'http://x').pathname
      if (route !== '/token' && route !== '/template' && route !== '/contract') return next()
      const send = (status: number, json: unknown) => {
        res.statusCode = status
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify(json))
      }
      if (req.method !== 'POST') return send(405, { code: 'METHOD_NOT_ALLOWED', message: '只收 POST' })
      if (!SERVER || !API_KEY) return send(503, { code: 'NO_SERVER', message: '没有接服务端，用 scripts/stack.ts 启动' })
      const api: ServerApi = async (method, url, body) => {
        const r = await fetch(new URL(url, SERVER), {
          method,
          headers: { authorization: `Bearer ${API_KEY}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
          body: body === undefined ? undefined : JSON.stringify(body),
        })
        return { status: r.status, json: await r.json().catch(() => ({})) }
      }
      let body: unknown
      try {
        const raw = await readBody(req)
        if (raw === null) return send(413, { code: 'TOO_LARGE', message: '请求体太大' })
        body = JSON.parse(raw)
      } catch {
        return send(400, { code: 'BAD_REQUEST', message: '请求体不是 JSON' })
      }
      try {
        const r = route === '/contract'
          ? await createFromOrder(api, req.headers.authorization, body as { templateId: string; versionNo: number; orderId: string })
          : route === '/template'
          ? await openTemplate(api, req.headers.authorization, body as { templateId: string })
          : await issueToken(api, req.headers.authorization, body as TokenRequest)
        send(r.status, r.json)
      } catch (e) {
        send(502, { code: 'SERVER_UNAVAILABLE', message: `服务端不可用：${e instanceof Error ? e.message : String(e)}` })
      }
    })
  },
})

// 导入 Word 走本机渲染服务（apps/renderer，默认 3200 端口）
export default defineConfig({
  base: './',
  plugins: [vue(), mockApi(), hostBackend()],
  server: { proxy: { '/convert': 'http://127.0.0.1:3200', ...(SERVER ? { '/api/documents': SERVER, '/api/templates': SERVER } : {}) } },
})
