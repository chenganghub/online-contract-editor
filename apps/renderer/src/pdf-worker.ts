// PDF 拼装在 worker 线程里做：pdf-lib 嵌图占出 PDF 耗时的 75%～80%（K8），放主线程会堵住其他请求。
// 每页先画打印模式页面图，再在每个字的位置写不可见文字（K9b），字能选、能搜。
// 这个文件由 worker_threads 直接加载（Node 24 原生去掉类型），所以只用包导入、不导入本地 .ts 文件。
import fs from 'node:fs'
import { parentPort, workerData } from 'node:worker_threads'
import fontkit from '@pdf-lib/fontkit'
import {
  PDFDocument,
  PDFHexString,
  TextRenderingMode,
  beginText,
  endText,
  popGraphicsState,
  pushGraphicsState,
  setCharacterSqueeze,
  setFontAndSize,
  setTextMatrix,
  setTextRenderingMode,
  showText,
  type PDFFont,
} from 'pdf-lib'

interface Run {
  zone: string
  size: number
  base: number
  chars: { v: string; x: number; r: number }[]
}
export interface PdfJob {
  images: string[]
  pages: Run[][]
  width: number
  height: number
  /** 文字层字体文件，按顺序找第一个有这个字的 */
  fonts: string[]
  meta: { documentId?: string; version?: number; title?: string }
}

const rd = (v: number) => Math.round(v * 1000) / 1000

async function build(job: PdfJob) {
  const doc = await PDFDocument.create()
  doc.setTitle(job.meta.title ?? '合同')
  doc.setLanguage('zh-CN')
  doc.setCreator('在线编辑器渲染服务')
  doc.setProducer('在线编辑器渲染服务')
  // 文档 id 和版本号写进文档信息（关键词），宿主拿到文件能核对是哪一版（方案第 12 节第 2 轮第 1 条）
  const keywords = [
    ...(job.meta.documentId ? [`oe-document:${job.meta.documentId}`] : []),
    ...(job.meta.version !== undefined ? [`oe-version:${job.meta.version}`] : []),
  ]
  if (keywords.length) doc.setKeywords(keywords)
  if (job.meta.documentId) doc.setSubject(`文档 ${job.meta.documentId}${job.meta.version !== undefined ? ` 第 ${job.meta.version} 版` : ''}`)
  // 编辑器 96 dpi 像素 → PDF 72 pt
  const W = job.width * 0.75
  const H = job.height * 0.75
  const sx = W / job.width
  const sy = H / job.height

  doc.registerFontkit(fontkit)
  const kits = job.fonts.map((file) => ({ file, bytes: fs.readFileSync(file) }))
  const faces = kits.map((k) => fontkit.create(k.bytes) as unknown as { hasGlyphForCodePoint(cp: number): boolean })
  const pick = (ch: string) => faces.findIndex((f) => f.hasGlyphForCodePoint(ch.codePointAt(0)!))
  const embedded = new Map<number, PDFFont>()
  const need = new Set<number>()
  for (const list of job.pages) for (const r of list) for (const c of r.chars) need.add(pick(c.v))
  for (const i of need) if (i >= 0) embedded.set(i, await doc.embedFont(kits[i]!.bytes, { subset: true }))
  const hex = new Map<string, string>()
  const hexOf = (fi: number, ch: string) => {
    const key = `${fi}|${ch}`
    if (!hex.has(key)) hex.set(key, embedded.get(fi)!.encodeText(ch).asString())
    return hex.get(key)!
  }

  let glyphs = 0
  let skipped = 0
  for (let pg = 0; pg < job.images.length; pg++) {
    const page = doc.addPage([W, H])
    const url = job.images[pg]!
    const data = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64')
    const img = url.startsWith('data:image/jpeg') ? await doc.embedJpg(data) : await doc.embedPng(data)
    page.drawImage(img, { x: 0, y: 0, width: W, height: H })
    const keys = new Map<number, ReturnType<typeof page.node.newFontDictionary>>()
    const fontKey = (fi: number) => {
      if (!keys.has(fi)) keys.set(fi, page.node.newFontDictionary(embedded.get(fi)!.name, embedded.get(fi)!.ref))
      return keys.get(fi)!
    }
    const ops = [pushGraphicsState(), beginText(), setTextRenderingMode(TextRenderingMode.Invisible)]
    let tz: number | null = null
    for (const run of job.pages[pg] ?? []) {
      // 按字体切段；所有字体都没有的字、宽度为 0 的字跳过
      const segs: { fi: number; chars: Run['chars'] }[] = []
      for (const c of run.chars) {
        const fi = pick(c.v)
        if (fi < 0 || !(c.r > c.x)) {
          skipped++
          continue
        }
        const last = segs.at(-1)
        if (last && last.fi === fi) last.chars.push(c)
        else segs.push({ fi, chars: [c] })
      }
      for (const seg of segs) {
        const font = embedded.get(seg.fi)!
        ops.push(setFontAndSize(fontKey(seg.fi), run.size))
        let pen: number | null = null
        let buf: string[] = []
        const flush = () => {
          if (buf.length) ops.push(showText(PDFHexString.of(buf.join(''))))
          buf = []
        }
        for (const c of seg.chars) {
          // 文字矩阵把编辑器像素缩成 pt，字号用编辑器像素；水平缩放 Tz 把字体字宽拉成编辑器里的字宽，
          // 每个字的起点和编辑器一致，字与字之间没有空隙（空隙大了阅读器会当成空格）
          const w = font.widthOfTextAtSize(c.v, run.size)
          const want = Math.round((10000 * (c.r - c.x)) / w) / 100
          if (pen === null || Math.abs(pen - c.x) > 0.05) {
            flush()
            ops.push(setTextMatrix(sx, 0, 0, sy, rd(c.x * sx), rd(H - run.base * sy)))
            pen = c.x
          }
          if (want !== tz) {
            flush()
            ops.push(setCharacterSqueeze(want))
            tz = want
          }
          buf.push(hexOf(seg.fi, c.v))
          pen += (w * tz) / 100
          glyphs++
        }
        flush()
      }
    }
    ops.push(endText(), popGraphicsState())
    page.pushOperators(...ops)
  }
  const bytes = await doc.save()
  return { bytes, glyphs, skipped }
}

const port = parentPort
if (port) {
  build(workerData as PdfJob).then(
    (r) => port.postMessage({ ok: true, bytes: r.bytes, glyphs: r.glyphs, skipped: r.skipped }, [r.bytes.buffer as ArrayBuffer]),
    (e: unknown) => port.postMessage({ ok: false, error: String(e instanceof Error ? (e.stack ?? e.message) : e) }),
  )
}
