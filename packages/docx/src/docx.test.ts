import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { exportInfo, fixExportedDocx, patchImported, prepareForExport, scanDocx, type Doc, type DocxScan, type El } from './index'

const fx = (name: string) => fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__', name))

describe('scanDocx', () => {
  it('自制样例：表格、重复标题行、无边框表、两节纸张、页脚页码、段间距（含样式继承）、不支持的项', async () => {
    const s = await scanDocx(fx('sample-contract.docx'))
    expect(s.tables.length).toBe(3)
    expect(s.tables[0]).toMatchObject({ rows: 29, headerRows: 1, borderless: false })
    expect(s.tables[1]).toMatchObject({ headerRows: 0, borderless: true })
    expect(s.sections).toHaveLength(2)
    expect(s.sections[0]).toEqual({ width: 794, height: 1123, landscape: false, margins: [96, 120, 96, 120] })
    expect(s.sections[1]).toMatchObject({ landscape: true, margins: [120, 96, 120, 96] })
    expect(s.pageNumber).toEqual({ format: '第 {pageNo} 页 共 {pageCount} 页', rowFlex: 'center', literal: '第 1 页 共 7 页' })
    // 正文 64 段（不含表格里的）；标题段落的段间距来自 Heading1 样式（段前 240 缇、段后 120 缇）
    expect(s.paras).toHaveLength(64)
    expect(s.paras[0]).toEqual({ text: '设备采购合同', before: 0, after: 16 })
    expect(s.paras.find((p) => p.text.startsWith('第一条'))).toMatchObject({ before: 16, after: 8 })
    expect(s.tables[1]!.paras.filter((p) => p.before === 4 && p.after === 4).length).toBeGreaterThan(0)
    expect(s.features.spacing).toBe(63)
    expect(s.features.firstLineIndent).toBeGreaterThan(0)
    expect(s.features.numberFormats).toContain('chineseCounting')
    expect(s.bodyText.replace(/\s/g, '').length).toBe(3659)
  })

  it('单节横向文档', async () => {
    const s = await scanDocx(fx('landscape.docx'))
    expect(s.sections).toEqual([{ width: 794, height: 1123, landscape: true, margins: [120, 96, 120, 96] }])
  })

  it('段间距：文档默认 → 样式 basedOn 链 → 段落直接设置，「行」为单位按 1 行 240 缇；字间距不算；mc:Fallback 里重复的字不算', async () => {
    const zip = new JSZip()
    zip.file(
      'word/styles.xml',
      '<w:styles><w:docDefaults><w:pPrDefault><w:pPr><w:spacing w:after="150"/></w:pPr></w:pPrDefault></w:docDefaults>' +
        '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:pPr><w:spacing w:before="30"/></w:pPr></w:style>' +
        '<w:style w:type="paragraph" w:styleId="Base"><w:pPr><w:spacing w:beforeLines="50"/></w:pPr></w:style>' +
        '<w:style w:type="paragraph" w:styleId="Child"><w:basedOn w:val="Base"/><w:pPr><w:spacing w:after="0"/></w:pPr></w:style></w:styles>',
    )
    const p = (pPr: string, text: string) => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}<w:r><w:t>${text}</w:t></w:r></w:p>`
    zip.file(
      'word/document.xml',
      '<w:document><w:body>' +
        p('', '默认') +
        p('<w:pStyle w:val="Child"/>', '子样式') +
        p('<w:pStyle w:val="Child"/><w:spacing w:before="300"/><w:rPr><w:spacing w:val="20"/></w:rPr>', '直接') +
        '<w:p><w:r><mc:AlternateContent><mc:Choice><w:t>框</w:t></mc:Choice><mc:Fallback><w:t>框</w:t></mc:Fallback></mc:AlternateContent></w:r></w:p>' +
        '<w:sectPr/></w:body></w:document>',
    )
    const s = await scanDocx(await zip.generateAsync({ type: 'uint8array' }))
    expect(s.paras.map((x) => [x.text, x.before, x.after])).toEqual([
      ['默认', 2, 10],
      ['子样式', 8, 0],
      ['直接', 20, 0],
      ['框', 2, 10],
    ])
    expect(s.bodyText).toBe('默认子样式直接框')
  })

  it('不是 docx 时报错', async () => {
    const zip = new JSZip()
    zip.file('a.txt', 'x')
    await expect(scanDocx(await zip.generateAsync({ type: 'uint8array' }))).rejects.toThrow('不是 docx')
  })
})

describe('patchImported', () => {
  const cell = (v: string) => ({ value: [{ value: v }] })
  const imported = (): Doc => ({
    header: [{ value: '华东智能装备有限公司合同编号：HD-CG-2026-0318' }],
    main: [
      { value: '设备采购合同' },
      { type: 'table', value: '', trList: [{ tdList: [cell('序号')] }, { tdList: [cell('1')] }] },
      { type: 'table', value: '', trList: [{ tdList: [cell('甲方（盖章）：')] }] },
      { type: 'table', value: '', trList: [{ tdList: [cell('序号')] }] },
    ],
    footer: [{ value: '第 1 页 共 7 页' }],
  })

  it('补回重复标题行、无边框，页码改成自动页码，纸张按第一节写进 doc.page；报告列出不支持的项', async () => {
    const scan = await scanDocx(fx('sample-contract.docx'))
    const r = patchImported(imported(), scan)
    const tables = r.doc.main.filter((e) => e.type === 'table')
    expect(tables[0]!.trList![0]!.pagingRepeat).toBe(true)
    expect(tables[0]!.trList![1]!.pagingRepeat).toBeUndefined()
    expect(tables[1]!.borderType).toBe('empty')
    expect(r.doc.footer).toEqual([])
    expect(r.doc.page).toEqual({
      width: 794,
      height: 1123,
      paperDirection: 'vertical',
      margins: [96, 120, 96, 120],
      pageNumber: { format: '第 {pageNo} 页 共 {pageCount} 页', rowFlex: 'center' },
    })
    const kinds = r.report.items.map((i) => `${i.kind}:${i.level}`)
    expect(kinds).toEqual(expect.arrayContaining(['tableHeader:fixed', 'tableBorder:fixed', 'pageNumber:fixed', 'sections:lost', 'firstLineIndent:lost', 'numbering:lost']))
    // 这里的「导入结果」是手写的，文字当然对不上：报告要指出缺了多少
    expect(r.report.textExact).toBe(false)
    expect(r.report.items[0]).toMatchObject({ kind: 'text', level: 'lost' })
  })

  it('表格数量对不上时不补，报告里说明', async () => {
    const scan = await scanDocx(fx('sample-contract.docx'))
    const doc = imported()
    doc.main = doc.main.slice(0, 2)
    const r = patchImported(doc, scan)
    expect(r.doc.main[1]!.trList![0]!.pagingRepeat).toBeUndefined()
    expect(r.report.items.find((i) => i.kind === 'table')).toMatchObject({ level: 'lost' })
  })

  it('横向：宽高按竖放写、方向写 horizontal，页边距转成竖放的写法（编辑器横放时再转回来）', async () => {
    const scan = await scanDocx(fx('landscape.docx'))
    const r = patchImported({ main: [{ value: '横向对照文档' }] }, scan)
    expect(r.doc.page).toMatchObject({ width: 794, height: 1123, paperDirection: 'horizontal', margins: [96, 120, 96, 120] })
    expect(r.report.items.find((i) => i.kind === 'pageNumber')).toMatchObject({ level: 'fixed', message: expect.stringContaining('没有页码') })
  })

  const scanOf = (paras: DocxScan['paras']): DocxScan => ({
    bodyText: paras.map((p) => p.text).join(''),
    headerText: '',
    footerText: '',
    paras,
    tables: [],
    sections: [],
    pageNumber: null,
    features: { firstLineIndent: 0, spacing: paras.filter((p) => p.before || p.after).length, textBoxes: 0, revisions: 0, comments: 0, footnotes: 0, mixedFonts: 0, numberFormats: [], otherFields: [] },
  })

  it('换行改成下一段的段落属性（插件把它记成上一段的，对齐会错一段）；按文字对上段落补段间距', () => {
    // 插件的写法：每段末尾的换行带本段属性
    const doc: Doc = {
      main: [
        { value: '设备采购合同\n', type: 'text', font: '黑体', size: 29, bold: true, rowFlex: 'center' },
        { value: '合同编号：', type: 'text', size: 16, rowFlex: 'right' },
        { value: 'HD-01\n空一行后\n', type: 'text', size: 16, rowFlex: 'right' },
        { value: '\n' },
        { value: '', type: 'title', level: 'first', valueList: [{ value: '第一条　采购标的', size: 19, bold: true }] },
        { value: '\n' },
        { value: '甲方', type: 'text', size: 16 },
      ],
    }
    const r = patchImported(
      doc,
      scanOf([
        { text: '设备采购合同', before: 0, after: 16 },
        { text: '合同编号：HD-01', before: 4, after: 4 },
        { text: '空一行后', before: 0, after: 0 },
        { text: '', before: 0, after: 0 },
        { text: '第一条采购标的', before: 16, after: 8 },
        { text: '甲方', before: 0, after: 0 },
      ]),
    )
    const m = r.doc.main
    const brief = (e: El) => [e.value, e.rowFlex, e.size, e.bold, e.spacingBefore, e.spacingAfter]
    expect(m.filter((e) => e.type !== 'title').map(brief)).toEqual([
      ['设备采购合同', 'center', 29, true, undefined, 16],
      // 第 2 段的开头：右对齐、16 号、不加粗，带第 2 段的段间距
      ['\n', 'right', 16, undefined, 4, 4],
      ['合同编号：', 'right', 16, undefined, 4, 4],
      ['HD-01', 'right', 16, undefined, 4, 4],
      ['\n', 'right', 16, undefined, undefined, undefined],
      ['空一行后', 'right', 16, undefined, undefined, undefined],
      // 空段：取它自己那个换行原来的属性（插件的写法里在后一个换行上）
      ['\n', undefined, undefined, undefined, undefined, undefined],
      // 标题段的开头：取标题第一个字的属性
      ['\n', undefined, 19, true, 16, 8],
      ['\n', undefined, 16, undefined, undefined, undefined],
      ['甲方', undefined, 16, undefined, undefined, undefined],
    ])
    expect(m.find((e) => e.type === 'title')!.valueList![0]).toMatchObject({ spacingBefore: 16, spacingAfter: 8 })
    expect(r.report.items.find((i) => i.kind === 'spacing')).toMatchObject({ level: 'fixed', count: 3 })
    expect(r.report.textExact).toBe(true)
  })

  it('文档默认字体字号和编辑器的不同时补到元素上', () => {
    const r = patchImported({ main: [{ value: '正文' }, { value: '标题', font: '黑体', size: 29 }] }, scanOf([]), { defaultFont: '仿宋', defaultSize: 21 })
    expect(r.doc.main.map((e) => [e.font, e.size])).toEqual([
      ['仿宋', 21],
      ['黑体', 29],
    ])
  })
})

describe('导出修正', () => {
  it('prepareForExport：控件没设前后缀的设成空字符串，已设的不动；制表符给一个值（插件跳过空值元素）；不改原文档', () => {
    const doc: Doc = {
      header: [{ value: '公司' }, { type: 'tab', value: '' }, { value: '编号' }],
      main: [
        { type: 'control', value: '', control: { value: [] } },
        { type: 'control', value: '', control: { value: [], prefix: '【' } },
        { value: '\n补充：' },
        { type: 'area', value: '', area: { extension: { anchor: 'a', editable: true } }, valueList: [{ value: '双方无其他约定。' }, { type: 'control', value: '', control: { value: [] } }] },
        { type: 'area', value: '', area: { hide: true }, valueList: [{ value: '内部备注' }] },
      ],
    }
    const out = prepareForExport(doc)
    expect(out.main[0]!.control).toMatchObject({ prefix: '', postfix: '' })
    expect(out.main[1]!.control).toMatchObject({ prefix: '【', postfix: '' })
    expect(out.header![1]).toEqual({ type: 'tab', value: '\t' })
    // 区域拆掉、内容放回原处（里面的控件也处理）；隐藏的区域不导出
    expect(out.main.map((e) => e.value)).toEqual(['', '', '\n补充：', '双方无其他约定。', ''])
    expect(out.main[4]!.control).toMatchObject({ prefix: '', postfix: '' })
    expect(doc.main[0]!.control!.prefix).toBeUndefined()
    expect(doc.header![1]!.value).toBe('')
    expect(doc.main).toHaveLength(5)
  })

  it('prepareForExport：列表拆成「编号 ⇥ 原样的文字」段落，按级别各自编号，条目里的样式保留，段首标记缩进；同一条里的换行不编号，空条目也编号', () => {
    const doc: Doc = {
      main: [
        { value: '\n条款：' },
        {
          type: 'list',
          value: '',
          listType: 'ol',
          listStyle: 'decimal',
          valueList: [
            { value: '\n', listLevel: 0 },
            { value: '甲方', listLevel: 0, size: 18, bold: true },
            { value: '\n', listLevel: 1 },
            { value: '子项一', listLevel: 1 },
            { value: '\n', listLevel: 1 },
            { value: '子项二', listLevel: 1, italic: true },
            { value: '\n', listLevel: 1, listWrap: true },
            { value: '子项二续行', listLevel: 1 },
            { value: '\n', listLevel: 0 },
            { value: '乙方', listLevel: 0 },
            { value: '\n', listLevel: 0 },
          ],
        },
      ],
    }
    const out = prepareForExport(doc, { defaultSize: 16 })
    expect(out.main.some((e) => e.type === 'list')).toBe(false)
    const marks = out.main.flatMap((e, i) => (e.value.startsWith('\n\uE000') ? [i] : []))
    // 编号宽 16 + 10 = 26 px = 390 缇；第 2 级再缩进 30 px：左 840、悬挂 390；接着上一行的悬挂 0
    expect(marks.map((i) => /\uE000([\d,]+)\uE001/.exec(out.main[i]!.value)![1])).toEqual(['390,390', '840,390', '840,390', '840,0', '390,390', '390,390'])
    // 编号紧跟在标记后面；接着上一行的没有编号，最后的空条目也编号
    expect(marks.map((i) => out.main[i + 1]!.value)).toEqual(['1.', '1.', '2.', '子项二续行', '2.', '3.'])
    expect(out.main.filter((e) => e.type === 'tab')).toHaveLength(5)
    // 标记那一段带条目第一段文字的字号（插件按它定行高），编号本身不带条目的样式
    expect(out.main[marks[0]!]).toMatchObject({ size: 18 })
    expect(out.main[marks[0]!]).not.toHaveProperty('bold')
    expect(out.main[marks[0]! + 1]).toEqual({ value: '1.' })
    expect(out.main.find((e) => e.value === '子项二')).toMatchObject({ italic: true })
    expect(out.main.find((e) => e.value === '子项二')).not.toHaveProperty('listLevel')
  })

  it('fixExportedDocx：段首带列表标记的段落写悬挂缩进（w:jc 前面、已有的 w:ind 换掉、<w:pPr/> 也认），标记删掉；<w:p/> 不会把两段并成一段', async () => {
    const zip = new JSZip()
    zip.file(
      'word/document.xml',
      '<w:document><w:body><w:p><w:pPr><w:spacing w:line="360"/><w:jc w:val="left"/></w:pPr><w:r><w:t xml:space="preserve">\uE000840,390\uE0011.</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>子项</w:t></w:r></w:p>' +
        '<w:p/><w:p><w:r><w:t>\uE000390,390\uE0012.</w:t></w:r></w:p><w:p><w:r><w:t>普通段落</w:t></w:r></w:p>' +
        '<w:p><w:pPr/><w:r><w:t>\uE000390,0\uE001续行</w:t></w:r></w:p>' +
        '<w:p><w:pPr><w:ind w:firstLine="420"/><w:jc w:val="both"/></w:pPr><w:r><w:t>\uE000390,390\uE0013.</w:t></w:r></w:p></w:body></w:document>',
    )
    const r = await fixExportedDocx(await zip.generateAsync({ type: 'uint8array' }), exportInfo({ main: [] }))
    expect(r.lists).toBe(4)
    const xml = await (await JSZip.loadAsync(r.bytes)).file('word/document.xml')!.async('string')
    expect(xml).toContain('<w:pPr><w:spacing w:line="360"/><w:ind w:left="840" w:hanging="390"/><w:jc w:val="left"/></w:pPr><w:r><w:t xml:space="preserve">1.</w:t>')
    expect(xml).toContain('<w:p/><w:p><w:pPr><w:ind w:left="390" w:hanging="390"/></w:pPr><w:r><w:t>2.</w:t>')
    expect(xml).toContain('<w:p><w:r><w:t>普通段落</w:t></w:r></w:p>')
    expect(xml).toContain('<w:p><w:pPr><w:ind w:left="390" w:hanging="0"/></w:pPr><w:r><w:t>续行</w:t>')
    expect(xml).toContain('<w:pPr><w:ind w:left="390" w:hanging="390"/><w:jc w:val="both"/></w:pPr><w:r><w:t>3.</w:t>')
    expect(xml).not.toContain('firstLine')
    expect(xml).not.toContain('\uE000')
  })

  it('prepareForExport：段前段后间距在每段第一段文字前放标记（标题、单元格各管各的），没有间距的段落不动，不多出空段', () => {
    const doc: Doc = {
      main: [
        { value: '设备采购合同', spacingAfter: 16 },
        { value: '\n', spacingBefore: 4, spacingAfter: 4 },
        { value: '根据民法典', spacingBefore: 4, spacingAfter: 4 },
        { value: '\n普通段落' },
        { type: 'title', value: '', level: 'first', valueList: [{ value: '第一条　标的', spacingBefore: 16, spacingAfter: 8, size: 21, font: '黑体' }] },
        { value: '\n表前段落\n', spacingAfter: 8 },
        { type: 'table', value: '', trList: [{ tdList: [{ value: [{ value: '单元格', spacingBefore: 2 }] }] }] },
      ],
    }
    const out = prepareForExport(doc)
    expect(out.main.map((e) => e.value)).toEqual(['\uE0020,240\uE003设备采购合同', '\n', '\uE00260,60\uE003根据民法典', '\n普通段落', '', '\n\uE0020,120\uE003表前段落\n', ''])
    expect(out.main[4]!.valueList![0]!.value).toBe('\uE002240,120\uE003第一条　标的')
    // 标题元素补上里面的字号、字体（插件按它定标题行高）
    expect(out.main[4]).toMatchObject({ size: 21, font: '黑体' })
    expect(out.main[6]!.trList![0]!.tdList[0]!.value[0]!.value).toBe('\uE00230,0\uE003单元格')
    expect(doc.main[0]!.value).toBe('设备采购合同')
  })

  it('fixExportedDocx：段前段后间距标记写进 w:spacing（换掉插件写的 0，行距不动；没有就按顺序加在 w:ind 前面），段落标记的 rPr 里的字间距不碰', async () => {
    const zip = new JSZip()
    zip.file(
      'word/document.xml',
      '<w:document><w:body>' +
        '<w:p><w:pPr><w:spacing w:line="450" w:lineRule="atLeast" w:before="0" w:after="0"/><w:jc w:val="left"/></w:pPr><w:r><w:t>\uE00260,120\uE003根据</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t>\uE002240,0\uE003标题</w:t></w:r></w:p>' +
        '<w:p><w:pPr><w:jc w:val="left"/><w:rPr><w:spacing w:val="20"/></w:rPr></w:pPr><w:r><w:t>\uE0020,90\uE003\uE000390,390\uE0011.</w:t></w:r></w:p>' +
        // 渲染页把印章插在一页第一个字后面，标记被拆到两个 run 里
        '<w:p><w:r><w:t xml:space="preserve">\uE002</w:t></w:r><w:r><w:drawing><wp:anchor/></w:drawing></w:r><w:r><w:t xml:space="preserve">0,240\uE003设备采购合同</w:t></w:r></w:p>' +
        '</w:body></w:document>',
    )
    const r = await fixExportedDocx(await zip.generateAsync({ type: 'uint8array' }), exportInfo({ main: [] }))
    expect([r.spacing, r.lists]).toEqual([4, 1])
    const split = (await (await JSZip.loadAsync(r.bytes)).file('word/document.xml')!.async('string')).split('<w:p>').at(-1)!
    expect(split).toBe('<w:pPr><w:spacing w:before="0" w:after="240"/></w:pPr><w:r><w:t xml:space="preserve"></w:t></w:r><w:r><w:drawing><wp:anchor/></w:drawing></w:r><w:r><w:t xml:space="preserve">设备采购合同</w:t></w:r></w:p></w:body></w:document>')
    const xml = await (await JSZip.loadAsync(r.bytes)).file('word/document.xml')!.async('string')
    expect(xml).toContain('<w:pPr><w:spacing w:line="450" w:lineRule="atLeast" w:before="60" w:after="120"/><w:jc w:val="left"/></w:pPr><w:r><w:t>根据</w:t>')
    expect(xml).toContain('<w:p><w:pPr><w:spacing w:before="240" w:after="0"/></w:pPr><w:r><w:t>标题</w:t>')
    expect(xml).toContain('<w:pPr><w:spacing w:before="0" w:after="90"/><w:ind w:left="390" w:hanging="390"/><w:jc w:val="left"/><w:rPr><w:spacing w:val="20"/></w:rPr></w:pPr><w:r><w:t>1.</w:t>')
    expect(xml).not.toMatch(/[\uE000-\uE003]/)
  })

  it('fixExportedDocx：套着文本框的段落不改（只改里面的），它的标记也删掉；文字里本来就有的保留字符导出前去掉', async () => {
    const zip = new JSZip()
    zip.file(
      'word/document.xml',
      '<w:document><w:body><w:p><w:r><w:t>\uE000390,390\uE001外</w:t></w:r><w:r><w:pict><v:textbox><w:txbxContent>' +
        '<w:p><w:r><w:t>\uE00260,0\uE003内</w:t></w:r></w:p></w:txbxContent></v:textbox></w:pict></w:r></w:p></w:body></w:document>',
    )
    const r = await fixExportedDocx(await zip.generateAsync({ type: 'uint8array' }), exportInfo({ main: [] }))
    expect([r.lists, r.spacing]).toEqual([0, 1])
    const xml = await (await JSZip.loadAsync(r.bytes)).file('word/document.xml')!.async('string')
    expect(xml).toContain('<w:body><w:p><w:r><w:t>外</w:t>')
    expect(xml).toContain('<w:txbxContent><w:p><w:pPr><w:spacing w:before="60" w:after="0"/></w:pPr><w:r><w:t>内</w:t>')
    expect(xml).not.toMatch(/[\uE000-\uE003]/)
    const out = prepareForExport({ main: [{ value: '甲\uE000390,390\uE001乙' }, { type: 'control', value: '', control: { value: [{ value: '\uE002丙' }] } }] })
    expect(out.main.map((e) => e.value)).toEqual(['甲390,390乙', ''])
    expect(out.main[1]!.control!.value![0]!.value).toBe('丙')
  })

  it('prepareForExport：段前段后是负数、NaN、超大值时按 0 或上限 31680 缇算，标记里一定是非负整数；标题里有没值的元素也不报错', () => {
    const out = prepareForExport({
      main: [
        { value: '甲', spacingBefore: -4, spacingAfter: 1e9 },
        { value: '\n乙', spacingBefore: Number.NaN, spacingAfter: -1 },
        { type: 'title', value: '', valueList: [{ type: 'text' } as El, { value: '标题', spacingBefore: 8 }] },
      ],
    })
    expect(out.main[0]!.value).toBe('\uE0020,31680\uE003甲')
    expect(out.main[1]!.value).toBe('\n乙')
    expect(out.main[2]!.valueList![1]!.value).toBe('\uE002120,0\uE003标题')
  })

  it('fixExportedDocx：页眉页脚里只有落单的标记字符时也清掉写回', async () => {
    const zip = new JSZip()
    zip.file('word/document.xml', '<w:document><w:body><w:p><w:r><w:t>正文</w:t></w:r></w:p></w:body></w:document>')
    zip.file('word/footer1.xml', '<w:ftr><w:p><w:r><w:t>第\uE003页</w:t></w:r></w:p></w:ftr>')
    const r = await fixExportedDocx(await zip.generateAsync({ type: 'uint8array' }), exportInfo({ main: [] }))
    expect(await (await JSZip.loadAsync(r.bytes)).file('word/footer1.xml')!.async('string')).toBe('<w:ftr><w:p><w:r><w:t>第页</w:t></w:r></w:p></w:ftr>')
  })

  it('fixExportedDocx：表格按 tblGrid 写单元格宽度（跨列相加）、表宽、固定列宽、单元格边距；settings 打开行尾空格下划线；修两次结果一样', async () => {
    const cell = (pr: string, s: string) => `<w:tc>${pr}<w:p><w:r><w:t>${s}</w:t></w:r></w:p></w:tc>`
    const table =
      '<w:tbl><w:tblPr><w:tblW w:type="pct" w:w="100%"/><w:tblBorders/></w:tblPr><w:tblGrid><w:gridCol w:w="600"/><w:gridCol w:w="900"/><w:gridCol w:w="1500"/></w:tblGrid>' +
      `<w:tr>${cell('<w:tcPr><w:gridSpan w:val="1"/></w:tcPr>', 'a')}${cell('<w:tcPr/>', 'b')}${cell('', 'c')}</w:tr>` +
      `<w:tr>${cell('<w:tcPr><w:gridSpan w:val="2"/><w:vMerge w:val="restart"/></w:tcPr>', 'd')}${cell('<w:tcPr><w:tcW w:w="999" w:type="dxa"/></w:tcPr>', 'e')}</w:tr></w:tbl>`
    const zip = new JSZip()
    zip.file('word/document.xml', `<w:document><w:body>${table}<w:sectPr/></w:body></w:document>`)
    zip.file('word/settings.xml', '<w:settings><w:compat><w:compatSetting w:val="15" w:name="compatibilityMode"/></w:compat></w:settings>')
    const info = exportInfo({ main: [] })
    const r = await fixExportedDocx(await zip.generateAsync({ type: 'uint8array' }), info)
    expect(r.tables).toBe(1)
    const out = await JSZip.loadAsync(r.bytes)
    const xml = await out.file('word/document.xml')!.async('string')
    expect(xml).toContain('<w:tblPr><w:tblW w:w="3000" w:type="dxa"/><w:tblBorders/><w:tblLayout w:type="fixed"/><w:tblCellMar>')
    expect(xml).toContain('<w:left w:w="75" w:type="dxa"/>')
    const widths = [...xml.matchAll(/<w:tcW w:w="(\d+)"/g)].map((m) => Number(m[1]))
    // 第 1 行 600、900、1500；第 2 行跨两列 1500，已有宽度的不动
    expect(widths).toEqual([600, 900, 1500, 1500, 999])
    expect(xml).toContain('<w:tc><w:tcPr><w:tcW w:w="900" w:type="dxa"/></w:tcPr>')
    expect(xml).toContain('<w:tc><w:tcPr><w:tcW w:w="1500" w:type="dxa"/></w:tcPr><w:p>')
    expect(await out.file('word/settings.xml')!.async('string')).toBe('<w:settings><w:compat><w:ulTrailSpace/><w:compatSetting w:val="15" w:name="compatibilityMode"/></w:compat></w:settings>')
    const again = await fixExportedDocx(r.bytes, info)
    expect(again.tables).toBe(0)
    const twice = await JSZip.loadAsync(again.bytes)
    expect(await twice.file('word/document.xml')!.async('string')).toBe(xml)
    expect(await twice.file('word/settings.xml')!.async('string')).toContain('<w:compat><w:ulTrailSpace/><w:compatSetting')
  })

  it('fixExportedDocx：styles.xml 写默认字体和字号，表头行写 w:tblHeader', async () => {
    const doc: Doc = { main: [{ type: 'table', value: '', trList: [{ pagingRepeat: true, tdList: [] }, { tdList: [] }] }] }
    const info = exportInfo(doc, { defaultFont: '宋体', defaultSize: 16 })
    expect(info.headerRows).toEqual([1])
    const r = await fixExportedDocx(fx('plugin-export.docx'), info)
    expect(r.headerRows).toBe(1)
    const zip = await JSZip.loadAsync(r.bytes)
    const styles = await zip.file('word/styles.xml')!.async('string')
    expect(styles).toContain('<w:rFonts w:ascii="宋体" w:eastAsia="宋体" w:hAnsi="宋体" w:cs="宋体"/><w:sz w:val="24"/>')
    const xml = await zip.file('word/document.xml')!.async('string')
    expect((xml.match(/<w:tblHeader\/>/g) ?? []).length).toBe(1)
    // 再修一次不会重复写
    const again = await fixExportedDocx(r.bytes, info)
    expect(again.headerRows).toBe(0)
  })

  it('fixExportedDocx：字体名里的 $ 和 & 原样写进去', async () => {
    const r = await fixExportedDocx(fx('plugin-export.docx'), exportInfo({ main: [] }, { defaultFont: '$&$1字体' }))
    const styles = await (await JSZip.loadAsync(r.bytes)).file('word/styles.xml')!.async('string')
    expect(styles).toContain('w:ascii="$&amp;$1字体"')
  })

  it('fixExportedDocx：横向页面宽高换回来、页边距转 90°；页眉距离按编辑器的 header.top（30 px = 450 缇），页脚不动；修两次不出错', async () => {
    const zip = new JSZip()
    zip.file('word/document.xml', '<w:document><w:body><w:p/><w:sectPr><w:pgSz w:w="11906" w:h="16838" w:orient="landscape"/><w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800" w:header="851" w:footer="992" w:gutter="0"/></w:sectPr></w:body></w:document>')
    const info = exportInfo({ main: [] })
    expect(info.headerTop).toBe(30)
    const r = await fixExportedDocx(await zip.generateAsync({ type: 'uint8array' }), info)
    expect(r.landscape).toBe(1)
    const xml = await (await JSZip.loadAsync(r.bytes)).file('word/document.xml')!.async('string')
    expect(xml).toContain('<w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/>')
    expect(xml).toContain('<w:pgMar w:top="1800" w:right="1440" w:bottom="1800" w:left="1440" w:header="450" w:footer="992" w:gutter="0"/>')
    const again = await fixExportedDocx(r.bytes, info)
    expect(again.landscape).toBe(0)
    expect(await (await JSZip.loadAsync(again.bytes)).file('word/document.xml')!.async('string')).toBe(xml)
  })
})
