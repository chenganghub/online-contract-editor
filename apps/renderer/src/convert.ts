// docx 转编辑器文档（方案 4.10、验收 3）：Node 里先扫一遍 docx；渲染页里用插件导入（另开一个编辑器）；
// Node 里补回插件丢掉的、出导入报告；最后按补好的文档在打印模式下数页数。
import { layoutOptions, type DocData } from '@oe/core'
import { patchImported, scanDocx, type DocxScan, type ImportReport } from '@oe/docx'
import { HttpError } from './errors'
import type { FontConfig } from './fonts'
import type { PagePool } from './pool'
import { render, withTimeout, type RendererWindow, type RenderLimits } from './render'

export interface ConvertResult {
  doc: DocData
  report: ImportReport
  pageCount: number
  unknownFonts: string[]
  timings: Record<string, number>
}

export async function convert(pool: PagePool, fonts: FontConfig, limits: RenderLimits, bytes: Uint8Array): Promise<ConvertResult> {
  const start = performance.now()
  let scan: DocxScan
  try {
    scan = await scanDocx(bytes)
  } catch (e) {
    throw new HttpError(400, 'BAD_DOCX', e instanceof Error ? e.message : String(e))
  }
  const scanMs = Math.round(performance.now() - start)

  const slot = await pool.acquire(Math.max(1, Math.min(limits.queueTimeoutMs, limits.totalTimeoutMs - (performance.now() - start))))
  const t = performance.now()
  let broken = false
  let imported: Awaited<ReturnType<RendererWindow['__renderer']['importDocx']>>
  try {
    imported = await withTimeout(
      slot.page.evaluate(([b64, o]) => (window as unknown as RendererWindow).__renderer.importDocx(b64, o), [Buffer.from(bytes).toString('base64'), layoutOptions()] as const),
      limits.attemptTimeoutMs,
      'docx 导入',
    )
  } catch (e) {
    // 插件出错或超时：这个标签的状态不可信，重建
    broken = true
    if (e instanceof HttpError) throw e
    throw new HttpError(422, 'IMPORT_FAILED', `docx 导入失败：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    await pool.release(slot, { broken })
  }
  const importMs = Math.round(performance.now() - t)

  // 页面返回的是反序列化后的任意值：结构不对就当导入失败，不让补丁里抛 TypeError 变成 500
  if (!imported || typeof imported !== 'object' || !Array.isArray(imported.data?.main))
    throw new HttpError(422, 'IMPORT_FAILED', 'docx 导入失败：插件没有返回文档内容')
  let patched: ReturnType<typeof patchImported>
  try {
    patched = patchImported(imported.data, scan, { defaultFont: imported.options?.defaultFont, defaultSize: imported.options?.defaultSize })
  } catch (e) {
    throw new HttpError(422, 'IMPORT_FAILED', `docx 导入后整理失败：${e instanceof Error ? e.message : String(e)}`)
  }
  const doc = patched.doc as unknown as DocData
  const left = limits.totalTimeoutMs - (performance.now() - start)
  if (left <= 0) throw new HttpError(503, 'RENDER_TIMEOUT', `docx 转换超过 ${limits.totalTimeoutMs} 毫秒`)
  const counted = await render(pool, fonts, { ...limits, totalTimeoutMs: left }, { doc, outputs: ['pages'], pixelRatio: 1 })
  const report = patched.report
  if (counted.unknownFonts.length)
    report.items.push({
      kind: 'font',
      level: 'lost',
      message: `字体 ${counted.unknownFonts.join('、')} 服务器上没有，显示和 PDF 用替代字体，分页可能和 Word 不同`,
      sample: counted.unknownFonts.join('、'),
    })
  return {
    doc,
    report,
    pageCount: counted.pageCount,
    unknownFonts: counted.unknownFonts,
    timings: { scanMs, importMs, pagesMs: counted.timings.totalMs ?? 0, totalMs: Math.round(performance.now() - start) },
  }
}
