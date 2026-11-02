// 导入前先把 docx 扫一遍：canvas-editor 的 docx 插件（npm 1.0.0）会丢掉的信息在这里记下来，导入后补回编辑器 JSON；
// 补不回的写进导入报告。插件的 TS 源码拿不到（GitHub 直连不通，jsDelivr 上的 main 分支是另一个旧版本），所以不 fork，包一层。
import JSZip from 'jszip'
import { attr, directChildren, spans, texts, type Span } from './xml'

export interface ParaInfo {
  /** 段落文字，去掉空白 */
  text: string
  /** 段前、段后（编辑器像素），已按样式继承算好 */
  before: number
  after: number
}

export interface TableInfo {
  rows: number
  /** 开头连续几行是「重复标题行」 */
  headerRows: number
  /** 四周和内部边框都是 none / nil */
  borderless: boolean
  /** 表格里的段落，按行、单元格的顺序 */
  paras: ParaInfo[]
}

export interface SectionInfo {
  /** 竖放时的宽高（编辑器像素，96 dpi）；横放用 landscape 表示 */
  width: number
  height: number
  landscape: boolean
  /** 上、右、下、左（编辑器像素），按页面实际朝向 */
  margins: [number, number, number, number]
}

export interface PageNumberInfo {
  /** canvas-editor 的页码格式，如「第 {pageNo} 页 共 {pageCount} 页」 */
  format: string
  rowFlex: 'left' | 'center' | 'right'
  /** 页码那一段在 docx 里显示的固定文字（域的缓存结果），插件导入后会变成这段固定文字 */
  literal: string
}

export interface DocxFeatures {
  firstLineIndent: number
  spacing: number
  textBoxes: number
  revisions: number
  comments: number
  footnotes: number
  mixedFonts: number
  numberFormats: string[]
  otherFields: string[]
}

export interface DocxScan {
  /** document.xml 里全部 w:t（正文、表格、文本框） */
  bodyText: string
  headerText: string
  /** 页脚文字，不含页码域 */
  footerText: string
  /** 正文段落（不含表格、文本框里的），按顺序 */
  paras: ParaInfo[]
  tables: TableInfo[]
  sections: SectionInfo[]
  pageNumber: PageNumberInfo | null
  features: DocxFeatures
}

// 1 缇 = 1/1440 英寸；编辑器 96 dpi：1 px = 15 缇。不是数字（缺了、写错）时用默认值
const px = (twips: string | undefined, fallback: number) => {
  const n = Number(twips)
  return twips === undefined || twips === '' || !Number.isFinite(n) ? fallback : Math.round(n / 15)
}

// mc:Fallback 是给老版本 Word 的备用写法（VML），内容和 mc:Choice 重复；不去掉的话文本框里的字会算两遍
const dropFallback = (xml: string) => xml.replace(/<mc:Fallback\b[\s\S]*?<\/mc:Fallback>/g, '')

function readSection(sect: string): SectionInfo {
  const sz = /<w:pgSz\b[^>]*>/.exec(sect)?.[0] ?? ''
  const mar = /<w:pgMar\b[^>]*>/.exec(sect)?.[0] ?? ''
  const w = px(attr(sz, 'w:w'), 794)
  const h = px(attr(sz, 'w:h'), 1123)
  const landscape = attr(sz, 'w:orient') === 'landscape' || w > h
  return {
    width: Math.min(w, h),
    height: Math.max(w, h),
    landscape,
    margins: [px(attr(mar, 'w:top'), 96), px(attr(mar, 'w:right'), 120), px(attr(mar, 'w:bottom'), 96), px(attr(mar, 'w:left'), 120)],
  }
}

// ---------- 段间距：直接写在段落上的 → 段落样式（沿 basedOn 往上）→ 文档默认，逐项取最近的 ----------
interface Spacing {
  before?: number
  after?: number
  beforeLines?: number
  afterLines?: number
}
interface Styles {
  byId: Map<string, { basedOn?: string; spacing: Spacing }>
  defaultId?: string
  docDefault: Spacing
}

function readSpacing(pPr: string): Spacing {
  // 段落标记的字符属性（w:rPr）里也有 w:spacing，那是字间距，不算
  const tag = /<w:spacing\b[^>]*>/.exec(pPr.replace(/<w:rPr\b[^>]*\/>|<w:rPr\b[^>]*>[\s\S]*?<\/w:rPr>/g, ''))?.[0]
  if (!tag) return {}
  const n = (name: string) => {
    const v = attr(tag, name)
    return v === undefined || v === '' ? undefined : Number(v)
  }
  return { before: n('w:before'), after: n('w:after'), beforeLines: n('w:beforeLines'), afterLines: n('w:afterLines') }
}

function readStyles(xml: string): Styles {
  const byId: Styles['byId'] = new Map()
  let defaultId: string | undefined
  for (const m of xml.matchAll(/<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/g)) {
    const open = m[1]!
    const id = attr(open, 'w:styleId')
    if (attr(open, 'w:type') !== 'paragraph' || !id) continue
    if (['1', 'true', 'on'].includes(attr(open, 'w:default') ?? '')) defaultId = id
    const pPr = /<w:pPr>([\s\S]*?)<\/w:pPr>/.exec(m[2]!)?.[1] ?? ''
    byId.set(id, { basedOn: attr(/<w:basedOn\b[^>]*>/.exec(m[2]!)?.[0] ?? '', 'w:val'), spacing: readSpacing(pPr) })
  }
  return { byId, defaultId, docDefault: readSpacing(/<w:pPrDefault>([\s\S]*?)<\/w:pPrDefault>/.exec(xml)?.[1] ?? '') }
}

function resolveSpacing(direct: Spacing, styleId: string | undefined, st: Styles): { before: number; after: number } {
  const chain: Spacing[] = [direct]
  const seen = new Set<string>()
  for (let id = styleId ?? st.defaultId; id && !seen.has(id); ) {
    seen.add(id)
    const s = st.byId.get(id)
    if (!s) break
    chain.push(s.spacing)
    id = s.basedOn
  }
  chain.push(st.docDefault)
  // 「行」为单位时（WPS 常用）按 1 行 = 240 缇算
  const side = (tw: 'before' | 'after', lines: 'beforeLines' | 'afterLines') => {
    const level = chain.find((c) => c[tw] !== undefined || c[lines] !== undefined)
    const l = level?.[lines]
    return Math.max(0, Math.round(l ? (l * 2.4) / 15 : (level?.[tw] ?? 0) / 15))
  }
  return { before: side('before', 'beforeLines'), after: side('after', 'afterLines') }
}

const within = (s: Span, outer: Span) => s.start > outer.start && s.end <= outer.end

/** 正文段落和每张表里的段落。文本框里的段落不算（插件导入后位置不定） */
function readParas(doc: string, st: Styles, tables: Span[]): { body: ParaInfo[]; inTables: ParaInfo[][] } {
  const boxes = spans(doc, 'w:txbxContent')
  const top = tables.filter((t) => !tables.some((o) => o !== t && within(t, o)))
  const body: ParaInfo[] = []
  const inTables: ParaInfo[][] = top.map(() => [])
  for (const p of spans(doc, 'w:p')) {
    if (boxes.some((b) => within(p, b))) continue
    let xml = doc.slice(p.start, p.end)
    // 段落里嵌的文本框：文字不算这一段的
    for (const b of boxes.filter((b) => within(b, p)).reverse()) xml = xml.slice(0, b.start - p.start) + xml.slice(b.end - p.start)
    const pPr = /^<w:p\b[^>]*>\s*<w:pPr>([\s\S]*?)<\/w:pPr>/.exec(xml)?.[1] ?? ''
    const styleId = attr(/<w:pStyle\b[^>]*>/.exec(pPr)?.[0] ?? '', 'w:val')
    const info: ParaInfo = { text: texts(xml).join('').replace(/[\s\u200B]/g, ''), ...resolveSpacing(readSpacing(pPr), styleId, st) }
    const t = top.findIndex((t) => within(p, t))
    if (t < 0) body.push(info)
    else inTables[t]!.push(info)
  }
  return { body, inTables }
}

/** 只列顶层表：canvas-editor 的表格不能嵌套，导入后和编辑器里的表一一对应的是顶层表 */
function readTables(doc: string, list: Span[], paras: ParaInfo[][]): TableInfo[] {
  const top = list.filter((t) => !list.some((o) => o !== t && within(t, o)))
  return top.map((t, i) => {
    const xml = doc.slice(t.start, t.end)
    const rows = directChildren(doc, t, 'w:tr', 'w:tbl')
    let headerRows = 0
    for (const r of rows) {
      const trPr = /<w:trPr>[\s\S]*?<\/w:trPr>/.exec(doc.slice(r.start, r.end))?.[0] ?? ''
      const h = /<w:tblHeader\b[^>]*>/.exec(trPr)?.[0]
      if (!h || ['false', '0', 'off'].includes(attr(h, 'w:val') ?? 'true')) break
      headerRows++
    }
    const tblPr = /<w:tblPr>[\s\S]*?<\/w:tblPr>/.exec(xml)?.[0] ?? ''
    const borders = /<w:tblBorders>([\s\S]*?)<\/w:tblBorders>/.exec(tblPr)?.[1]
    const vals = borders ? [...borders.matchAll(/w:val="([^"]*)"/g)].map((m) => m[1]) : []
    const borderless = borders ? vals.length > 0 && vals.every((v) => v === 'none' || v === 'nil') : !/<w:tblStyle\b/.test(tblPr)
    return { rows: rows.length, headerRows, borderless, paras: paras[i] ?? [] }
  })
}

/** 页脚里含 PAGE / NUMPAGES 域的那一段：拼出页码格式和显示的固定文字 */
function readPageNumber(footer: string): { info: PageNumberInfo | null; rest: string } {
  for (const p of spans(footer, 'w:p')) {
    const xml = footer.slice(p.start, p.end)
    if (!/PAGE|NUMPAGES/.test(xml)) continue
    let format = ''
    let literal = ''
    let depth = 0
    let instr = ''
    let inResult = false
    const tokens = /<w:fldChar\b[^>]*w:fldCharType="(begin|separate|end)"[^>]*>|<w:instrText(?:\s[^>]*)?>([^<]*)<\/w:instrText>|<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:fldSimple\b[^>]*w:instr="([^"]*)"[^>]*>|<\/w:fldSimple>/g
    let simple: string | null = null
    for (const m of xml.matchAll(tokens)) {
      if (m[1] === 'begin') {
        depth++
        instr = ''
        inResult = false
      } else if (m[1] === 'separate') inResult = true
      else if (m[1] === 'end') {
        const code = instr.trim().split(/\s+/)[0]
        format += code === 'PAGE' ? '{pageNo}' : code === 'NUMPAGES' || code === 'SECTIONPAGES' ? '{pageCount}' : ''
        depth = Math.max(0, depth - 1)
        inResult = false
      } else if (m[2] !== undefined) instr += m[2]
      else if (m[4] !== undefined) {
        simple = m[4].trim().split(/\s+/)[0]!
        format += simple === 'PAGE' ? '{pageNo}' : simple === 'NUMPAGES' ? '{pageCount}' : ''
      } else if (m[0] === '</w:fldSimple>') simple = null
      else if (m[3] !== undefined) {
        literal += m[3]
        if (depth === 0 && !simple && !inResult) format += m[3]
      }
    }
    if (!format.includes('{pageNo}')) continue
    const jc = attr(/<w:jc\b[^>]*>/.exec(xml)?.[0] ?? '', 'w:val')
    const rowFlex = jc === 'center' ? 'center' : jc === 'right' || jc === 'end' ? 'right' : 'left'
    return { info: { format: format.trim(), rowFlex, literal: literal.trim() }, rest: footer.slice(0, p.start) + footer.slice(p.end) }
  }
  return { info: null, rest: footer }
}

export async function scanDocx(bytes: Uint8Array | ArrayBuffer): Promise<DocxScan> {
  const zip = await JSZip.loadAsync(bytes)
  const read = async (name: string) => dropFallback((await zip.file(name)?.async('string')) ?? '')
  const doc = await read('word/document.xml')
  if (!doc) throw new Error('不是 docx 文件（没有 word/document.xml）；.doc 老格式要先另存为 docx')
  const names = Object.keys(zip.files)
  const headers = await Promise.all(names.filter((n) => /^word\/header\d*\.xml$/.test(n)).map(read))
  const footers = await Promise.all(names.filter((n) => /^word\/footer\d*\.xml$/.test(n)).map(read))
  const numbering = await read('word/numbering.xml')
  const footnotes = await read('word/footnotes.xml')
  const styles = readStyles(await read('word/styles.xml'))

  let pageNumber: PageNumberInfo | null = null
  const footerRest: string[] = []
  for (const f of footers) {
    const r = readPageNumber(f)
    pageNumber ??= r.info
    footerRest.push(r.rest)
  }
  const fields = [...doc.matchAll(/<w:instrText(?:\s[^>]*)?>([^<]*)<\/w:instrText>|w:instr="([^"]*)"/g)]
    .map((m) => (m[1] ?? m[2] ?? '').trim().split(/\s+/)[0]!)
    .filter((c) => c && !['PAGE', 'NUMPAGES'].includes(c))
  const formats = [...numbering.matchAll(/<w:numFmt\b[^>]*w:val="([^"]*)"/g)].map((m) => m[1]!)
  const rFonts = [...doc.matchAll(/<w:rFonts\b[^>]*>/g)].map((m) => m[0])
  const tableSpans = spans(doc, 'w:tbl')
  const paras = readParas(doc, styles, tableSpans)

  return {
    bodyText: texts(doc).join(''),
    headerText: headers.map((h) => texts(h).join('')).join(''),
    footerText: footerRest.map((f) => texts(f).join('')).join(''),
    paras: paras.body,
    tables: readTables(doc, tableSpans, paras.inTables),
    sections: (doc.match(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g) ?? []).map(readSection),
    pageNumber,
    features: {
      firstLineIndent: [...doc.matchAll(/<w:ind\b[^>]*w:firstLine(?:Chars)?="(\d+)"/g)].filter((m) => Number(m[1]) > 0).length,
      spacing: [...paras.body, ...paras.inTables.flat()].filter((p) => p.before || p.after).length,
      textBoxes: (doc.match(/<w:txbxContent\b/g) ?? []).length,
      revisions: (doc.match(/<w:(?:ins|del)\b[^>]*w:author=/g) ?? []).length,
      comments: (doc.match(/<w:commentReference\b/g) ?? []).length,
      footnotes: (footnotes.match(/<w:footnote\b(?![^>]*w:type="(?:separator|continuationSeparator)")/g) ?? []).length,
      mixedFonts: rFonts.filter((f) => {
        const a = attr(f, 'w:ascii')
        const e = attr(f, 'w:eastAsia')
        return a && e && a !== e
      }).length,
      numberFormats: [...new Set(formats.filter((f) => !['decimal', 'bullet', 'none'].includes(f)))],
      otherFields: [...new Set(fields)],
    },
  }
}
