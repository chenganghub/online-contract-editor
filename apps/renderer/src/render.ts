// 一次渲染：装文档 → 页面图 → 文字位置 → （worker 里）拼 PDF；docx 在页面里导出。
// 规则来自方案第 12 节：页数以页面图张数为准，和期望页数不一致时重建页面重试一次，仍不一致返回 409；
// 单次限时、总限时，超时也重试一次。
import { layoutOptions, type DocData } from '@oe/core'
import { exportInfo, fixExportedDocx, prepareForExport, type Doc } from '@oe/docx'
import { HttpError } from './errors'
import type { FontConfig } from './fonts'
import { buildPdfInWorker } from './pdf'
import type { PagePool, Slot } from './pool'
import { buildPages, type Positions } from './text-layer'

export type Output = 'pdf' | 'docx' | 'pages'

export interface RenderInput {
  doc: DocData
  /** 额外的 canvas-editor 选项，盖在 layoutOptions(doc.page) 上面（一般不用传，纸张设置在 doc.page） */
  options?: Record<string, unknown>
  /** 编辑器保存时的页数；给了就核对 */
  expectedPages?: number
  documentId?: string
  version?: number
  title?: string
  outputs: Output[]
  /** 页面图倍率：预览 2，正式件 3（约 300 dpi） */
  pixelRatio: number
}

export interface RenderResult {
  pageCount: number
  pdf?: Uint8Array
  docx?: Uint8Array
  /** 文档里用了、但字体配置里没有的字体：排版会用替代字体，分页可能和屏幕不一样 */
  unknownFonts: string[]
  attempts: number
  timings: Record<string, number>
}

export interface RenderLimits {
  attemptTimeoutMs: number
  totalTimeoutMs: number
  queueTimeoutMs: number
}

export type RendererWindow = {
  __renderer: {
    load(a: { doc: unknown; options: unknown }): Promise<{ fonts: string[] }>
    images(pixelRatio: number): Promise<string[]>
    positions(pageCount: number): Positions
    docx(): Promise<string>
    importDocx(b64: string, options: unknown): Promise<{ data: Doc; options: { defaultFont?: string; defaultSize?: number } & Record<string, unknown> }>
  }
}

/** 渲染页用的编辑器选项：和前端编辑器同一套（@oe/core 的 layoutOptions），再盖上请求里额外给的 */
export const editorOptions = (doc: DocData, extra?: Record<string, unknown>) => ({ ...layoutOptions(doc.page), ...extra })

const now = () => performance.now()

export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new HttpError(503, 'RENDER_TIMEOUT', `${what}超过 ${ms} 毫秒`)), ms)
    }),
  ])
}

interface Rendered {
  pageCount: number
  images?: string[]
  positions?: Positions
  docx?: string
  fonts: string[]
  timings: Record<string, number>
}

/** docxDoc：导出 docx 用的文档（prepareForExport 拆过区域、列表）；PDF 和页数照原文档出，和编辑器一样 */
async function renderOnce(slot: Slot, input: RenderInput, docxDoc?: DocData): Promise<Rendered> {
  const { page } = slot
  const timings: Record<string, number> = {}
  const wantPdf = input.outputs.includes('pdf')
  const needLayout = wantPdf || input.outputs.includes('pages') || input.expectedPages !== undefined
  // 页面里现在装的是哪一份：先装出 PDF、数页数要的原文档；只要 docx 时直接装 docx 用的
  let loaded: DocData | undefined
  const load = async (doc: DocData) => {
    loaded = doc
    return page.evaluate((a) => (window as unknown as RendererWindow).__renderer.load(a), { doc, options: editorOptions(doc, input.options) })
  }
  let t = now()
  const { fonts } = await load(needLayout || !docxDoc ? input.doc : docxDoc)
  timings.loadMs = Math.round(now() - t)
  const out: Rendered = { pageCount: 0, fonts, timings }
  // 不出 PDF 时也要数页数（要求核对页数或要页数时）：用很小的倍率出图，只数张数
  if (needLayout) {
    t = now()
    const images = await page.evaluate((r) => (window as unknown as RendererWindow).__renderer.images(r), wantPdf ? input.pixelRatio : 0.1)
    timings.imagesMs = Math.round(now() - t)
    out.pageCount = images.length
    if (wantPdf) out.images = images
  }
  if (wantPdf) {
    t = now()
    out.positions = await page.evaluate((n) => (window as unknown as RendererWindow).__renderer.positions(n), out.pageCount)
    timings.positionsMs = Math.round(now() - t)
  }
  if (docxDoc) {
    // 换装 docx 用的文档单独计时（docxLoadMs），docxMs 只算插件导出
    if (loaded !== docxDoc) {
      t = now()
      await load(docxDoc)
      timings.docxLoadMs = Math.round(now() - t)
    }
    t = now()
    out.docx = await page.evaluate(() => (window as unknown as RendererWindow).__renderer.docx())
    timings.docxMs = Math.round(now() - t)
  }
  return out
}

export async function render(pool: PagePool, fonts: FontConfig, limits: RenderLimits, input: RenderInput): Promise<RenderResult> {
  const start = now()
  // 要 docx 时另备一份导出用的文档：控件前后缀设成空字符串（插件按 prefix ?? "{" 写）、区域和列表拆成普通段落（插件导不好，见 @oe/docx）。
  // PDF 和页数照原文档出
  const docxDoc = input.outputs.includes('docx')
    ? (prepareForExport(input.doc as unknown as Doc, { defaultSize: editorOptions(input.doc, input.options).defaultSize }) as unknown as DocData)
    : undefined
  const left = () => limits.totalTimeoutMs - (now() - start)
  let mismatch: number | null = null
  let lastError: unknown = null
  let attempts = 0
  let done: Rendered | null = null
  while (attempts < 2 && !done) {
    if (left() <= 0) break
    attempts++
    const t = now()
    const slot = await pool.acquire(Math.min(limits.queueTimeoutMs, left()))
    const queueMs = Math.round(now() - t)
    let broken = false
    try {
      const r = await withTimeout(renderOnce(slot, input, docxDoc), Math.min(limits.attemptTimeoutMs, left()), '渲染')
      r.timings.queueMs = queueMs
      if (input.expectedPages !== undefined && r.pageCount !== input.expectedPages) {
        // 页数不一致：可能是页面状态不干净或字体没加载好，重建这个标签再试一次
        mismatch = r.pageCount
        broken = true
      } else done = r
    } catch (e) {
      lastError = e
      broken = true
    } finally {
      await pool.release(slot, { broken })
    }
  }
  if (!done) {
    if (mismatch !== null)
      throw new HttpError(409, 'PAGE_COUNT_MISMATCH', `渲染出 ${mismatch} 页，和编辑器保存时的 ${input.expectedPages} 页不一致`, {
        expected: input.expectedPages,
        actual: mismatch,
      })
    if (lastError instanceof HttpError) throw lastError
    throw new HttpError(503, 'RENDER_FAILED', `渲染失败：${lastError instanceof Error ? lastError.message : String(lastError ?? '总时间用完')}`)
  }

  const result: RenderResult = {
    pageCount: done.pageCount,
    unknownFonts: done.fonts.filter((f) => !(f in fonts.families)),
    attempts,
    timings: { ...done.timings },
  }
  if (done.docx && docxDoc) {
    const t = now()
    const o = editorOptions(docxDoc, input.options)
    const fixed = await fixExportedDocx(Buffer.from(done.docx, 'base64'), exportInfo(docxDoc as unknown as Doc, { defaultFont: o.defaultFont, defaultSize: o.defaultSize }))
    result.docx = fixed.bytes
    result.timings.docxFixMs = Math.round(now() - t)
  }
  if (done.images && done.positions) {
    const t = now()
    const pages = buildPages(done.positions, done.pageCount)
    const pdf = await buildPdfInWorker(
      {
        images: done.images,
        pages,
        width: done.positions.options.width,
        height: done.positions.options.height,
        fonts: fonts.textLayer,
        meta: { documentId: input.documentId, version: input.version, title: input.title },
      },
      Math.max(1000, left()),
    )
    result.pdf = pdf.bytes
    result.timings.pdfMs = Math.round(now() - t)
    result.timings.glyphs = pdf.glyphs
    result.timings.skippedGlyphs = pdf.skipped
  }
  result.timings.totalMs = Math.round(now() - start)
  return result
}
