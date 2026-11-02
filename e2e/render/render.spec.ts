// 验收 1、15：同一份约 10 页的合同，浏览器里的编辑器（打印模式）和渲染服务出的 PDF：页数相同、每页正文第一行相同、
// 关键字和字段值的次数相同、印章位置偏差不超过 1 mm；渲染服务 60 秒内出 PDF。
// 两份样例：带字段的合同正文复制 5 遍（字段值、计算字段）；自制样例 docx 导入后的 9 页合同（表格、合并单元格、跨页重复表头、「不可抗力」）
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, type Page } from '@playwright/test'
import { applyBatch, layoutOptions, type DocData, type FieldDef } from '../../packages/core/src/index'
import { startRenderer, type Renderer } from '../../apps/renderer/src/app'
import { loadConfig } from '../../apps/renderer/src/config'
import { serve } from '../helpers/serve'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const fixture = JSON.parse(fs.readFileSync(path.join(root, 'apps', 'renderer', 'src', '__fixtures__', 'contract.json'), 'utf8')) as { doc: DocData; fields: FieldDef[] }
const evidence = process.env.OE_EVIDENCE_DIR ?? path.join(root, 'test-results')
type W = Window & {
  ready?: boolean
  redSeal(): string
  createEditor(d: unknown, o: unknown): Promise<boolean>
  editorFacts(words: string[], sealPage: number): Promise<Facts>
  pdfFacts(b64: string, words: string[], sealPage: number, mainTop: number): Promise<Facts>
}
interface Facts {
  pages: number
  firstLines: string[]
  counts: Record<string, number>
  seal: { x: number; y: number; n: number } | null
}
const squeeze = (s: string) => s.replace(/[\s\u200B]/g, '')

/** 带字段的样例复制几份能排满 10 页（验收 1 写的是 10 页的样例合同） */
const COPIES = 6

/** 第 sealPage 页放一个章（压在文字上），渲染服务出 PDF，同一份文档装进浏览器里的编辑器，逐页比对，结果写进证据；给了 pages 就核对页数 */
async function compare(page: Page, renderer: Renderer, origin: string, base: DocData, fields: FieldDef[], words: string[], sealPage: number, name: string, pages?: number) {
  await page.goto(`${origin}/e2e/render/fixture/index.html`)
  await page.waitForFunction(() => (window as unknown as W).ready)
  const sealURL = await page.evaluate(() => (window as unknown as W).redSeal())
  const sealed = applyBatch(base, [{ op: 'placeSeal', seal: { id: 'seal-1', dataURL: sealURL, pageNo: sealPage, x: 420, y: 520, width: 151, height: 151, sealId: 'contract', name: '合同专用章' } }], { fields })
  if (!sealed.ok) throw new Error(sealed.error)
  const doc = sealed.data

  const t0 = Date.now()
  const res = await renderer.app.inject({ method: 'POST', url: '/render', payload: { doc, outputs: ['pdf'], pixelRatio: 2, documentId: 'doc-1', version: 1 } as object })
  const ms = Date.now() - t0
  expect(res.statusCode, res.body).toBe(200)
  expect(ms).toBeLessThan(60_000)

  // 编辑器：和前端、渲染页同一套排版选项（@oe/core 的 layoutOptions），控件不画括号
  await page.evaluate(([d, o]) => (window as unknown as W).createEditor(d, o), [doc, { ...layoutOptions(doc.page), control: { bracketColor: 'transparent' } }] as const)
  const ed = await page.evaluate(([w, p]) => (window as unknown as W).editorFacts(w, p), [words, sealPage] as const)
  // 正文区从上页边距开始，PDF 里比这更靠上的是页眉
  const mainTop = layoutOptions(doc.page).margins[0] - 4
  const pdf = await page.evaluate(([b, w, p, t]) => (window as unknown as W).pdfFacts(b, w, p, t), [res.json().pdf as string, words, sealPage, mainTop] as const)

  if (pages) expect(ed.pages).toBe(pages)
  else expect(ed.pages).toBeGreaterThanOrEqual(8)
  expect(pdf.pages).toBe(ed.pages)
  expect(res.json().pageCount).toBe(ed.pages)
  for (let i = 0; i < ed.pages; i++) expect(squeeze(pdf.firstLines[i]!), `第 ${i + 1} 页第一行`).toBe(squeeze(ed.firstLines[i]!))
  expect(pdf.counts).toEqual(ed.counts)
  // 每个字都在渲染服务配的字体里（PDF 文字层按字找字体，找不到的记 skippedGlyphs）：页面上不会有方块字
  expect(res.json().timings).toMatchObject({ skippedGlyphs: 0 })
  expect(res.json().timings.glyphs).toBeGreaterThan(1000)
  for (const w of words) expect(ed.counts[w], w).toBeGreaterThan(0)
  // 印章：两边红色像素的重心，偏差换算成毫米（96 dpi：1 px = 25.4 / 96 mm）
  expect(ed.seal && pdf.seal, JSON.stringify({ editor: ed.seal, pdf: pdf.seal, editorAll: (ed as { seals?: unknown }).seals })).toBeTruthy()
  const mm = (Math.hypot(ed.seal!.x - pdf.seal!.x, ed.seal!.y - pdf.seal!.y) * 25.4) / 96
  expect(mm).toBeLessThanOrEqual(1)

  fs.mkdirSync(evidence, { recursive: true })
  fs.writeFileSync(
    path.join(evidence, name),
    JSON.stringify({ pages: ed.pages, renderMs: ms, timings: res.json().timings, counts: ed.counts, sealEditor: ed.seal, sealPdf: pdf.seal, sealDeviationMm: Number(mm.toFixed(3)), firstLines: ed.firstLines.map((l, i) => [squeeze(l), squeeze(pdf.firstLines[i]!)]) }, null, 1),
  )
}

test('10 页的合同：编辑器和渲染服务的 PDF 逐页一致，「不可抗力」和字段值次数一样，印章偏差不超过 1 mm，60 秒内出 PDF（验收 1、15）', async ({ page }) => {
  test.setTimeout(120_000)
  const server = await serve(root)
  const renderer = await startRenderer({ ...loadConfig({}), RENDERER_PORT: 0, POOL_SIZE: 1 })
  try {
    // 样例：填好值的合同正文加一条「不可抗力」，复制到排满 10 页，第 3 页放一个印章
    const filled = applyBatch(fixture.doc, [{ op: 'setData', values: { contractNo: 'HT-2026-0318', partyA: '某某科技有限公司', amount: '358600', payMethod: 'stage' } }], { fields: fixture.fields })
    if (!filled.ok) throw new Error(filled.error)
    const base = filled.data
    const one = [...base.main, { value: '\n第九条　不可抗力', bold: true }, { value: '\n因不可抗力不能履行合同的，根据不可抗力的影响，部分或者全部免除责任，但法律另有规定的除外。' }] as DocData['main']
    const long: DocData = { ...base, main: [...one, ...Array.from({ length: COPIES - 1 }, () => structuredClone(one)).flat()] }
    await compare(page, renderer, server.origin, long, fixture.fields, ['不可抗力', '违约', '某某科技有限公司', '叁拾伍万捌仟陆佰元整'], 2, 's11-render-compare.json', 10)
  } finally {
    await renderer.close()
    await server.close()
  }
})

test('导入的 9 页合同（表格、合并单元格、跨页重复表头）：编辑器和渲染服务的 PDF 逐页一致，搜「不可抗力」次数一样（验收 1）', async ({ page }) => {
  test.setTimeout(120_000)
  const server = await serve(root)
  const renderer = await startRenderer({ ...loadConfig({}), RENDERER_PORT: 0, POOL_SIZE: 1 })
  try {
    const docx = fs.readFileSync(path.join(root, 'packages', 'docx', 'src', '__fixtures__', 'sample-contract.docx'))
    const conv = await renderer.app.inject({ method: 'POST', url: '/convert', payload: { docx: docx.toString('base64') } })
    expect(conv.statusCode, conv.body).toBe(200)
    await compare(page, renderer, server.origin, conv.json().doc as DocData, [], ['不可抗力', '违约', '数控车床'], 2, 's13-render-compare-docx.json')
  } finally {
    await renderer.close()
    await server.close()
  }
})
