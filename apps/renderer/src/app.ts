import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import Fastify, { type FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { DocData } from '@oe/core'
import type { RendererConfig } from './config'
import { HttpError } from './errors'
import { checkFonts, loadFontConfig, type FontConfig } from './fonts'
import { convert } from './convert'
import { PagePool } from './pool'
import { render } from './render'

const here = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const pkgDir = (name: string) => path.dirname(require.resolve(`${name}/package.json`))

// 渲染页和它要的两个 ES 构建，只发这几个文件
const FILES: Record<string, { file: string; type: string }> = {
  '/page/index.html': { file: path.join(here, '..', 'page', 'index.html'), type: 'text/html; charset=utf-8' },
  '/page/render.js': { file: path.join(here, '..', 'page', 'render.js'), type: 'text/javascript; charset=utf-8' },
  '/vendor/canvas-editor.js': { file: path.join(pkgDir('@hufe921/canvas-editor'), 'dist', 'canvas-editor.js'), type: 'text/javascript; charset=utf-8' },
  '/vendor/docx.js': { file: path.join(pkgDir('@hufe921/canvas-editor-plugin-docx'), 'dist', 'docx.js'), type: 'text/javascript; charset=utf-8' },
}

const OUTPUT = z.enum(['pdf', 'docx', 'pages'])
const BODY = z.object({
  doc: z.object({ main: z.array(z.any()), header: z.array(z.any()).optional(), footer: z.array(z.any()).optional() }).passthrough(),
  options: z.record(z.string(), z.unknown()).optional(),
  expectedPages: z.number().int().positive().optional(),
  documentId: z.string().max(100).optional(),
  version: z.number().int().nonnegative().optional(),
  title: z.string().max(200).optional(),
  outputs: z.array(OUTPUT).min(1).default(['pdf']),
  pixelRatio: z.number().min(1).max(4).default(2),
})
// docx 最大约 30 MB（base64 后 40 MB，请求体上限 50 MB）
const CONVERT = z.object({ docx: z.string().min(1).max(40 * 1024 * 1024) })

const badRequest = (e: z.ZodError) => new HttpError(400, 'BAD_REQUEST', e.issues.map((i) => `${i.path.join('.') || '入参'}：${i.message}`).join('；'))

export interface Renderer {
  app: FastifyInstance
  pool: PagePool
  origin: string
  fonts: FontConfig
  close(): Promise<void>
}

/** 启动渲染服务：先检查字体，再起 HTTP 服务（同时发渲染页），最后拉起 Chrome 和页面池 */
export async function startRenderer(config: RendererConfig): Promise<Renderer> {
  const fonts = loadFontConfig(config.FONT_CONFIG)
  checkFonts(fonts)
  for (const { file } of Object.values(FILES)) if (!fs.existsSync(file)) throw new Error(`渲染页文件不存在：${file}`)

  // 文档里可能有印章图片（base64），放宽请求体
  const app = Fastify({ bodyLimit: 50 * 1024 * 1024, logger: false })
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ code: err.code, message: err.message, ...err.detail })
    const status = (err as { statusCode?: number }).statusCode
    if (status && status < 500) return reply.status(status).send({ code: 'BAD_REQUEST', message: err instanceof Error ? err.message : String(err) })
    return reply.status(500).send({ code: 'INTERNAL', message: '渲染服务内部错误' })
  })
  for (const [url, { file, type }] of Object.entries(FILES)) app.get(url, (_req, reply) => reply.type(type).send(fs.createReadStream(file)))

  let pool: PagePool | null = null
  app.get('/health', async () => ({ ok: true, pool: pool?.stats() }))
  const limits = { attemptTimeoutMs: config.ATTEMPT_TIMEOUT_MS, totalTimeoutMs: config.TOTAL_TIMEOUT_MS, queueTimeoutMs: config.QUEUE_TIMEOUT_MS }
  app.post('/render', async (req) => {
    const r = BODY.safeParse(req.body)
    if (!r.success) throw badRequest(r.error)
    const result = await render(pool!, fonts, limits, { ...r.data, doc: r.data.doc as unknown as DocData })
    return {
      pageCount: result.pageCount,
      pdf: result.pdf ? Buffer.from(result.pdf).toString('base64') : undefined,
      docx: result.docx ? Buffer.from(result.docx).toString('base64') : undefined,
      unknownFonts: result.unknownFonts,
      attempts: result.attempts,
      timings: result.timings,
    }
  })
  // docx（base64）→ 编辑器文档 + 导入报告 + 页数
  app.post('/convert', async (req) => {
    const r = CONVERT.safeParse(req.body)
    if (!r.success) throw badRequest(r.error)
    const bytes = Buffer.from(r.data.docx, 'base64')
    // docx 是 zip，开头是 PK；.doc 老格式不是
    if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new HttpError(400, 'BAD_DOCX', '不是 docx 文件；.doc 老格式要先另存为 docx')
    return convert(pool!, fonts, limits, bytes)
  })

  await app.listen({ host: config.RENDERER_HOST, port: config.RENDERER_PORT })
  const addr = app.server.address()
  const port = typeof addr === 'object' && addr ? addr.port : config.RENDERER_PORT
  const origin = `http://${config.RENDERER_HOST}:${port}`
  pool = new PagePool({ chromePath: config.CHROME_PATH, size: config.POOL_SIZE, pageUrl: `${origin}/page/index.html`, recycleAfter: config.RECYCLE_AFTER })
  try {
    await pool.start()
  } catch (e) {
    await app.close()
    throw e
  }
  const p = pool
  return {
    app,
    pool: p,
    origin,
    fonts,
    close: async () => {
      await p.close()
      await app.close()
    },
  }
}
