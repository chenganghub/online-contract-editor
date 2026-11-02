// docx 导入导出的集成测试：真的起渲染服务、拉起系统 Chrome，跑插件 + @oe/docx 的补丁（s3，验收 2、3 的机器可测部分）
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { PDFDocument } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { applyBatch, type DocData, type FieldDef } from '@oe/core'
import type { El, ImportReport } from '@oe/docx'
import { startRenderer, type Renderer } from './app'
import { loadConfig } from './config'
import fixture from './__fixtures__/contract.json'

const samples = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages', 'docx', 'src', '__fixtures__')
const b64 = (name: string) => fs.readFileSync(path.join(samples, name)).toString('base64')
const evidence = process.env.OE_EVIDENCE_DIR ?? path.resolve('test-results')
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='

let renderer: Renderer
const post = (url: string, body: unknown) => renderer.app.inject({ method: 'POST', url, payload: body as object })
interface Converted {
  doc: DocData & { main: El[]; footer?: El[] }
  report: ImportReport
  pageCount: number
  timings: Record<string, number>
}
const convert = async (name: string) => {
  const res = await post('/convert', { docx: b64(name) })
  expect(res.statusCode, res.body).toBe(200)
  return res.json() as Converted
}
const docxXml = async (b64docx: string, file: string) => (await JSZip.loadAsync(Buffer.from(b64docx, 'base64'))).file(file)!.async('string')

beforeAll(async () => {
  renderer = await startRenderer({ ...loadConfig({}), RENDERER_PORT: 0, POOL_SIZE: 1 })
}, 60_000)
afterAll(async () => {
  await renderer?.close()
}, 30_000)

describe('docx 导入（/convert）', () => {
  it('自制样例：文字一字不差，表头重复、无边框签字表、页码、段间距、对齐都对，报告列出不支持的项', async () => {
    const r = await convert('sample-contract.docx')
    expect(r.report.textExact).toBe(true)
    const tables = r.doc.main.filter((e) => e.type === 'table')
    expect(tables).toHaveLength(3)
    expect(tables[0]!.trList![0]!.pagingRepeat).toBe(true)
    expect(tables[1]!.borderType).toBe('empty')
    // 页脚的固定页码去掉了，换成编辑器的自动页码
    expect(r.doc.footer).toEqual([])
    expect(r.doc.page).toEqual({ width: 794, height: 1123, paperDirection: 'vertical', margins: [96, 120, 96, 120], pageNumber: { format: '第 {pageNo} 页 共 {pageCount} 页', rowFlex: 'center' } })
    // 对齐：「合同编号」那段开头的换行是右对齐（插件导入时是上一段标题的居中）
    const at = r.doc.main.findIndex((e) => e.value === '合同编号：')
    expect(r.doc.main[at - 1]).toMatchObject({ value: '\n', rowFlex: 'right', size: 16 })
    // 段间距：标题段后 240 缇 = 16 px；条款标题来自 Heading1 样式
    expect(r.doc.main[0]).toMatchObject({ value: '设备采购合同', spacingAfter: 16 })
    const clause = r.doc.main.find((e) => e.type === 'title')!
    expect(clause.valueList![0]).toMatchObject({ spacingBefore: 16, spacingAfter: 8 })
    const items = Object.fromEntries(r.report.items.map((i) => [`${i.kind}:${i.level}`, i]))
    expect(items['spacing:fixed']).toMatchObject({ count: 63 })
    expect(items['spacing:lost']).toBeUndefined()
    for (const k of ['tableHeader:fixed', 'tableBorder:fixed', 'pageNumber:fixed', 'sections:lost', 'firstLineIndent:lost', 'numbering:lost', 'mixedFont:lost']) expect(items[k], k).toBeDefined()
    expect(r.pageCount).toBeGreaterThanOrEqual(7)
    fs.mkdirSync(evidence, { recursive: true })
    fs.writeFileSync(path.join(evidence, 's3-import-sample.json'), JSON.stringify({ pageCount: r.pageCount, page: r.doc.page, timings: r.timings, report: r.report }, null, 1))
  }, 60_000)

  it('单节横向：doc.page 是横向；出的 PDF 页面宽大于高，导出的 docx 也是横向（宽大于高、页边距按横向）', async () => {
    const r = await convert('landscape.docx')
    expect(r.report.textExact).toBe(true)
    expect(r.doc.page).toMatchObject({ paperDirection: 'horizontal', width: 794, height: 1123 })
    const res = await post('/render', { doc: r.doc, outputs: ['pdf', 'docx'] })
    expect(res.statusCode, res.body).toBe(200)
    const pdf = await PDFDocument.load(Buffer.from(res.json().pdf, 'base64'))
    const size = pdf.getPage(0).getSize()
    expect(size.width).toBeGreaterThan(size.height)
    const xml = await docxXml(res.json().docx, 'word/document.xml')
    const sz = /<w:pgSz\b[^>]*>/.exec(xml)![0]
    expect(sz).toContain('w:orient="landscape"')
    expect(Number(/w:w="(\d+)"/.exec(sz)![1])).toBeGreaterThan(Number(/w:h="(\d+)"/.exec(sz)![1]))
    // 原文档上下 3.18 cm（1800 缇）、左右 2.54 cm（1440 缇）
    expect(/<w:pgMar\b[^>]*>/.exec(xml)![0]).toMatch(/w:top="1800" w:right="1440" w:bottom="1800" w:left="1440"/)
  }, 60_000)

  it('不是 docx 返回 400', async () => {
    const res = await post('/convert', { docx: Buffer.from('not a docx').toString('base64') })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('BAD_DOCX')
  })
})

describe('表格循环（验收 10 的 PDF、docx 部分）', () => {
  it('30 条数据：PDF 跨页、30 行都在文字层；docx 里表头 + 30 行，只有表头是重复标题行', async () => {
    const fields: FieldDef[] = [{ key: 'items', label: '设备清单', type: 'loop', loop: { columns: ['name', 'qty'], labels: ['品名', '数量'] } }]
    const ctl = (c: string) => ({ type: 'control', value: '', control: { type: 'text', value: null, conceptId: c, placeholder: c, prefix: '', postfix: '' } })
    const cell = (value: unknown[]) => ({ colspan: 1, rowspan: 1, value })
    // 和前端插入的循环表格同一个结构（packages/web/src/elements.ts）
    const doc = {
      main: [
        { value: '设备清单' },
        {
          type: 'table',
          value: '',
          colgroup: [{ width: 277 }, { width: 277 }],
          trList: [
            { height: 40, pagingRepeat: true, tdList: [cell([{ value: '品名' }]), cell([{ value: '数量' }])] },
            { height: 40, extension: { loop: 'items' }, tdList: [cell([ctl('name')]), cell([ctl('qty')])] },
          ],
        },
      ],
    } as unknown as DocData
    const rows = Array.from({ length: 30 }, (_, i) => ({ name: `数控车床 ${i + 1} 号`, qty: (i % 3) + 1 }))
    const r = applyBatch(doc, [{ op: 'setData', values: { items: rows } }], { fields })
    expect(r.ok, r.ok ? '' : r.error).toBe(true)
    if (!r.ok) return
    const res = await post('/render', { doc: r.data, outputs: ['pdf', 'docx'] })
    expect(res.statusCode, res.body).toBe(200)
    const body = res.json()
    expect(body.pageCount).toBeGreaterThanOrEqual(2)
    const pdf = await getDocument({ data: new Uint8Array(Buffer.from(body.pdf, 'base64')), disableFontFace: true, useSystemFonts: false, verbosity: 0 }).promise
    let text = ''
    for (let n = 1; n <= pdf.numPages; n++) text += (await (await pdf.getPage(n)).getTextContent()).items.map((it) => ('str' in it ? it.str : '')).join('') + '\n'
    for (const row of rows) expect(text).toContain(row.name)
    const xml = await docxXml(body.docx, 'word/document.xml')
    const tr = xml.match(/<w:tr[ >][\s\S]*?<\/w:tr>/g) ?? []
    expect(tr).toHaveLength(31)
    expect(tr[0]).toContain('<w:tblHeader')
    expect(tr.slice(1).some((x) => x.includes('<w:tblHeader'))).toBe(false)
  }, 60_000)
})

describe('docx 导出（/render outputs docx）', () => {
  it('没有花括号、styles.xml 有默认字体字号、表头行有 w:tblHeader、浮动图片（印章）是 wp:anchor', async () => {
    const extra: El[] = [
      { value: '\n乙方：' },
      // 没设前后缀的控件：插件会按 prefix ?? "{" 写出花括号
      { type: 'control', value: '', control: { type: 'text', value: [{ value: '苏州精工机械制造有限公司' }], placeholder: '乙方' } },
      { value: '\n' },
      {
        type: 'table',
        value: '',
        colgroup: [{ width: 277 }, { width: 277 }],
        trList: [
          { height: 40, pagingRepeat: true, tdList: [{ colspan: 1, rowspan: 1, value: [{ value: '名称' }] }, { colspan: 1, rowspan: 1, value: [{ value: '数量' }] }] },
          { height: 40, tdList: [{ colspan: 1, rowspan: 1, value: [{ value: '数控车床' }] }, { colspan: 1, rowspan: 1, value: [{ value: '2' }] }] },
        ],
      },
      { type: 'image', value: PNG, width: 120, height: 120, imgDisplay: 'float-top', imgFloatPosition: { x: 420, y: 600, pageNo: 0 } },
      // 段前段后间距（px）
      { value: '\n这一段前后有间距', spacingBefore: 8, spacingAfter: 4 },
      // 两级编号列表，条目里有斜体
      { value: '\n' },
      {
        type: 'list',
        value: '',
        listType: 'ol',
        listStyle: 'decimal',
        valueList: [
          { value: '\n', listLevel: 0 },
          { value: '质量标准', listLevel: 0 },
          { value: '\n', listLevel: 1 },
          { value: '随机附带合格证', listLevel: 1 },
          { value: '（中文版）', listLevel: 1, italic: true },
          { value: '\n', listLevel: 0 },
          { value: '权利保证', listLevel: 0 },
        ],
      },
    ]
    // 页眉里「公司名 ⇥ 合同编号」（导入的页眉常见写法）
    const header: El[] = [{ value: '华东智能装备有限公司' }, { type: 'tab', value: '' }, { value: '合同编号：HD-01' }]
    const doc = { ...fixture.doc, header, main: [...fixture.doc.main, ...extra] }
    const res = await post('/render', { doc, outputs: ['docx'] })
    expect(res.statusCode, res.body).toBe(200)
    const body = res.json()
    const xml = await docxXml(body.docx, 'word/document.xml')
    const text = [...xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('')
    expect(text).toContain('苏州精工机械制造有限公司')
    expect(text).not.toMatch(/[{}]/)
    const styles = await docxXml(body.docx, 'word/styles.xml')
    expect(styles).toMatch(/<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="宋体" w:eastAsia="宋体" w:hAnsi="宋体" w:cs="宋体"\/><w:sz w:val="24"\/>/)
    expect((xml.match(/<w:tblHeader\b/g) ?? []).length).toBe(1)
    expect(xml).toContain('<wp:anchor')
    // 表格按编辑器的列宽（277 px = 4155 缇）固定，单元格边距按编辑器的；制表符写出来；行尾空格画下划线
    expect(xml).toContain('<w:tblW w:w="8310" w:type="dxa"/>')
    expect(xml).toContain('<w:tblLayout w:type="fixed"/>')
    expect((xml.match(/<w:tcW w:w="4155" w:type="dxa"\/>/g) ?? []).length).toBe(4)
    expect(await docxXml(body.docx, 'word/header1.xml')).toMatch(/华东智能装备有限公司<\/w:t><\/w:r><w:r>(?:<w:rPr\/>|<w:rPr>[\s\S]*?<\/w:rPr>)?<w:tab\/><\/w:r>/)
    expect(await docxXml(body.docx, 'word/settings.xml')).toContain('<w:ulTrailSpace/>')
    // 列表：按级别编号（1. 1. 2.）、悬挂缩进、条目里的斜体还在，标记都删掉了
    const paragraphs = [...xml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)].map((m) => m[1]!)
    const listParas = paragraphs.filter((p) => /<w:ind w:left="\d+" w:hanging="390"\/>/.test(p))
    const textOf = (p: string) => [...p.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('')
    expect(listParas.map(textOf)).toEqual(['1.质量标准', '1.随机附带合格证（中文版）', '2.权利保证'])
    // 编号后面是制表符（跳到悬挂缩进的位置）
    expect(listParas.every((p) => /1\.<\/w:t><\/w:r><w:r>(?:<w:rPr\/>|<w:rPr>[\s\S]*?<\/w:rPr>)?<w:tab\/>|2\.<\/w:t><\/w:r><w:r>(?:<w:rPr\/>|<w:rPr>[\s\S]*?<\/w:rPr>)?<w:tab\/>/.test(p))).toBe(true)
    expect(listParas[1]).toContain('<w:ind w:left="840" w:hanging="390"/>')
    expect(listParas[1]).toMatch(/<w:i\/>[\s\S]*?（中文版）/)
    expect(xml).not.toMatch(/[\uE000-\uE003]/)
    expect(text).toContain('随机附带合格证（中文版）')
    // 段前段后间距：8 px、4 px = 120、60 缇，行距照插件算的
    const spaced = paragraphs.find((p) => p.includes('这一段前后有间距'))!
    expect(spaced).toMatch(/<w:spacing w:line="\d+" w:lineRule="atLeast" w:before="120" w:after="60"\/>/)
  }, 60_000)
})
