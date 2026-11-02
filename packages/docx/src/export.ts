// 插件导出 docx 后再修一遍（方案 4.10）：写默认字体、写重复标题行、横向页面、页眉距离、表格列宽和单元格边距、行尾空格的下划线。
// 控件的花括号、制表符在导出前处理（prepareForExport）。
import JSZip from 'jszip'
import { DEFAULT_FONT, DEFAULT_SIZE } from '@oe/core'
import { tablesOf, walk, type Doc, type El } from './model'
import { attr, directChildren, escapeAttr, spans } from './xml'

export interface ExportInfo {
  defaultFont: string
  /** 编辑器字号（px） */
  defaultSize: number
  /** 正文里每张表（先序）开头连续几行是重复标题行 */
  headerRows: number[]
  /** 编辑器页眉离纸张上边的距离（px，canvas-editor 的 header.top） */
  headerTop: number
}

/** canvas-editor 默认的 header.top（编辑器、渲染页都没改） */
const HEADER_TOP = 30

/**
 * 导出前（只给 docx 用，PDF 照原文档出）：
 * - 控件没设前后缀的，设成空字符串。插件导出时按「控件 prefix ?? "{"」写，不设就会把花括号写进正文（K7）。
 * - 制表符：插件按段落拆文字时跳过值为空的元素，制表符元素的值是空的，整个丢掉（导入的页眉「公司名 ⇥ 合同编号」就挤在一起）；
 *   给它一个值，插件才会写出 <w:tab/>。
 * - 区域、列表：见 flatten；段前段后间距：见 markSpacing（s13 WPS 对比）
 */
export function prepareForExport<T extends Doc>(doc: T, options: { defaultSize?: number } = {}): T {
  const out = structuredClone(doc)
  const size = options.defaultSize ?? DEFAULT_SIZE
  // 标记用的私用区字符是保留的：文字里本来就有的先去掉，免得被当成标记
  for (const zone of [out.header, out.main, out.footer]) for (const el of walk(zone)) if (typeof el.value === 'string') el.value = el.value.replace(RESERVED, '')
  out.header = flatten(out.header, size)
  out.main = flatten(out.main, size) ?? []
  out.footer = flatten(out.footer, size)
  for (const zone of [out.header, out.main, out.footer]) {
    titleMetrics(zone)
    markSpacing(zone)
  }
  for (const zone of [out.header, out.main, out.footer])
    for (const el of walk(zone)) {
      if (el.type === 'control' && el.control) {
        el.control.prefix ??= ''
        el.control.postfix ??= ''
      }
      if (el.type === 'tab' && !el.value) el.value = '\t'
    }
  return out
}

/**
 * 插件导出不了的两种容器，导出前拆成普通段落：
 * - 区域（可编辑区等）：插件不认 area 元素，值是空的整个跳过，里面的字就丢了。拆掉区域、把内容放回原处；
 *   隐藏的区域在编辑器和 PDF 里都不显示，docx 里也不要。
 * - 列表：插件把每一条拼成一个不带样式的字符串（条目里的粗体、斜体、字体都丢了），多级列表也拉成一级连着编号。
 *   拆成「编号 ⇥ 条目原样的文字」的段落，按级别各自编号（和编辑器一样）；悬挂缩进按编辑器的列表排版，
 *   段首放一个标记（LIST_MARK），fixExportedDocx 按它写 w:ind 再删掉
 */
function flatten(list: El[] | undefined, size: number): El[] | undefined {
  if (!list) return list
  return list.flatMap((el) => {
    if (el.type === 'area') return el.area?.hide ? [] : (flatten(el.valueList, size) ?? [])
    if (el.type === 'list') return listParagraphs(el, size).flatMap((e) => flatten([e], size) ?? [])
    if (el.valueList) el.valueList = flatten(el.valueList, size)
    if (el.type === 'control' && Array.isArray(el.control?.value)) el.control.value = flatten(el.control.value, size) ?? []
    if (el.type === 'table') for (const tr of el.trList ?? []) for (const td of tr.tdList ?? []) td.value = flatten(td.value, size) ?? []
    return [el]
  })
}

/**
 * 标题：插件按标题元素自己的字号、字体、行距定行高，这些在标题里面的字上、标题元素上没有，就按默认字号算，
 * WPS 里标题行比编辑器矮。拿标题第一段字的补上（只补没有的）
 */
function titleMetrics(list: El[] | undefined) {
  for (const el of walk(list)) {
    if (el.type !== 'title') continue
    const first = firstText(el)
    for (const k of ['size', 'font', 'rowMargin'] as const) if (el[k] === undefined && first?.[k] !== undefined) el[k] = first[k]
  }
}

// 段落标记（导出前放进文字、fixExportedDocx 读出来再删）：私用区字符 \uE000-\uE003 保留给它们用。
// 列表：\uE000左缩进,悬挂缩进\uE001；段前段后间距：\uE002段前,段后\uE003（都是缇）。生成只用 listMark、spacingMark，读只用下面两个正则
const LIST_MARK = /\uE000(\d+),(\d+)\uE001/
const SPACING_MARK = /\uE002(\d+),(\d+)\uE003/
const RESERVED = /[\uE000-\uE003]/g
const twips = (px: number) => Math.round(px * 15)
const listMark = (left: number, hanging: number) => `\uE000${left},${hanging}\uE001`
/** 段前段后（px）换成缇：文档 JSON 没有逐项校验，负数、Infinity 按 0 算，最多 31680 缇（OOXML 的上限），标记里一定是非负整数 */
const spacingTwips = (v: unknown) => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.min(31680, twips(n)) : 0
}
const spacingMark = (el: El | undefined) => {
  const before = spacingTwips(el?.spacingBefore)
  const after = spacingTwips(el?.spacingAfter)
  return before > 0 || after > 0 ? `\uE002${before},${after}\uE003` : ''
}
const isPlainRun = (el: El) => el.type === undefined || el.type === 'text'
/** 标题里第一段有字的文字（插件按它定标题行高，段落标记也放在它前面） */
const firstText = (title: El) => title.valueList?.find((v) => isPlainRun(v) && typeof v.value === 'string' && v.value.replace(/\n/g, ''))

/**
 * 段前段后间距：编辑器的段落属性 spacingBefore / spacingAfter（px，在段落的每个字上，开头那个换行上也有），
 * 插件导出时写死成 0，WPS / Word 里段落之间就比编辑器紧。导出前在每段第一段文字前面放一个标记（SPACING_MARK），
 * fixExportedDocx 按它写 w:spacing 的 w:before / w:after 再删掉。标记放在文字前面、不单独成段，插件定行高用的还是原来那段文字。
 * 只看一层（正文、页眉页脚、每个单元格各自一层）：标题自己一段，表格、分隔线另起一段
 */
function markSpacing(list: El[] | undefined) {
  if (!list) return
  // 等着放标记的段落间距（段落开头还没遇到文字）
  let pending = spacingMark(list.find(isPlainRun))
  for (const el of list) {
    if (el.type === 'table') {
      for (const tr of el.trList ?? []) for (const td of tr.tdList ?? []) markSpacing(td.value)
      pending = ''
      continue
    }
    if (el.type === 'title') {
      // 标题里没有字就没有段落可放标记
      const first = firstText(el)
      const mark = spacingMark(first)
      if (first && mark) first.value = mark + first.value
      pending = ''
      continue
    }
    if (el.type === 'separator') {
      pending = ''
      continue
    }
    // 控件、图片、日期这些行内的东西不放标记，留给这一段后面的文字
    if (!isPlainRun(el) || typeof el.value !== 'string') continue
    el.value = el.value
      .split('\n')
      .map((seg, i) => {
        if (i > 0) pending = spacingMark(el)
        if (!seg || !pending) return seg
        const out = pending + seg
        pending = ''
        return out
      })
      .join('\n')
  }
}

// canvas-editor 的列表排版（ListParticle）：有序列表编号宽 = 「0.」（100 条以上「00.」）的宽度 + 10 px，每级缩进 30 px；
// 无序列表的符号宽 20 px，复选框 14 + 10 px。数字和点是半角，宽度按字号的一半算
const LIST_GAP = 10
const LIST_INDENT = 30
const BULLETS: Record<string, string> = { disc: '•', circle: '◦', square: '▪' }

/** 编号（符号）占的宽度（px）：有序列表按「0.」，100 条以上「00.」 */
function labelWidth(style: string, count: number, size: number): number {
  if (style === 'decimal') return (count >= 100 ? 1.5 : 1) * size + LIST_GAP
  if (style === 'checkbox') return 14 + LIST_GAP
  return 20
}
function labelText(style: string, n: number, head: El): string {
  if (style === 'decimal') return `${n}.`
  if (style === 'checkbox') return (head.checkbox as { value?: boolean } | undefined)?.value ? '☑' : '☐'
  return BULLETS[style] ?? '•'
}
/** 段落级的属性：插件按段落第一段文字定行高（字号、字体、行距）和对齐，标记那一段要带上；段前段后间距给 markSpacing 用 */
const PARAGRAPH_ATTRS = ['size', 'font', 'rowMargin', 'rowFlex', 'spacingBefore', 'spacingAfter'] as const
const LIST_ATTRS = ['listId', 'listType', 'listStyle', 'listLevel', 'listWrap']

interface ListLine {
  head: El
  runs: El[]
  /** 同一条里的换行（listWrap）：接着上一行，不编号 */
  wrap: boolean
}
/** 按换行拆成行：换行开始新的一条（级别、复选框状态在这个换行上）；带 listWrap 的换行是同一条里换行。空的条目也留着（编辑器里也有编号） */
function listLines(el: El): ListLine[] {
  const lines: ListLine[] = []
  for (const v of el.valueList ?? []) {
    if (v.type !== undefined && v.type !== 'text') {
      // 控件、图片、上下标：放进当前这一条
      if (!lines.length) lines.push({ head: v, runs: [], wrap: false })
      lines.at(-1)!.runs.push(v)
      continue
    }
    String(v.value ?? '')
      .split('\n')
      .forEach((text, i) => {
        if (i > 0) lines.push({ head: v, runs: [], wrap: !!v.listWrap })
        else if (text && !lines.length) lines.push({ head: v, runs: [], wrap: false })
        if (text) lines.at(-1)!.runs.push({ ...v, value: text })
      })
  }
  return lines
}

function listParagraphs(el: El, size: number): El[] {
  const style = String(el.listStyle ?? (el.listType === 'ul' ? 'disc' : 'decimal'))
  const lines = listLines(el)
  const width = labelWidth(style, lines.filter((l) => !l.wrap).length, size)
  const counters: number[] = []
  let level = 0
  const clean = (e: El): El => {
    const out: El = { ...e }
    for (const k of LIST_ATTRS) delete out[k]
    return out
  }
  return lines.flatMap(({ head, runs, wrap }) => {
    if (!wrap) {
      level = Math.max(0, Math.min(8, Number(head.listLevel ?? 0) || 0))
      counters[level] = (counters[level] ?? 0) + 1
      counters.length = level + 1
    }
    const left = twips(width + LIST_INDENT * level)
    const first = runs.find((r) => r.type === undefined || r.type === 'text') ?? head
    const para: El = { value: '' }
    for (const k of PARAGRAPH_ATTRS) if (first[k] !== undefined) para[k] = first[k]
    // 每一条自己的对齐优先，没有才用整个列表的
    if (para.rowFlex === undefined && el.rowFlex !== undefined) para.rowFlex = el.rowFlex
    // 接着上一行的：和条目文字对齐，不编号，也没有段前段后间距（编辑器里同一条里换行不加间距）
    if (wrap) {
      const line: El = { ...para, value: `\n${listMark(left, 0)}` }
      delete line.spacingBefore
      delete line.spacingAfter
      return [line, ...runs.map(clean)]
    }
    // 编号按编辑器的画法用默认字体字号（不带条目文字的样式），后面一个制表符到悬挂缩进的位置
    return [{ ...para, value: `\n${listMark(left, twips(width))}` }, { value: labelText(style, counters[level]!, head) }, { type: 'tab', value: '\t' }, ...runs.map(clean)]
  })
}

export function exportInfo(doc: Doc, options: { defaultFont?: string; defaultSize?: number; headerTop?: number } = {}): ExportInfo {
  return {
    defaultFont: options.defaultFont ?? DEFAULT_FONT,
    defaultSize: options.defaultSize ?? DEFAULT_SIZE,
    headerRows: tablesOf(doc.main).map((t) => {
      let n = 0
      while (t.trList?.[n]?.pagingRepeat) n++
      return n
    }),
    headerTop: options.headerTop ?? HEADER_TOP,
  }
}

function patchStyles(xml: string, font: string, sizePx: number): string {
  // 编辑器 px → 磅（× 0.75）→ 半磅（× 2）
  const hp = Math.round(sizePx * 1.5)
  const f = escapeAttr(font)
  const rPr = `<w:rPrDefault><w:rPr><w:rFonts w:ascii="${f}" w:eastAsia="${f}" w:hAnsi="${f}" w:cs="${f}"/><w:sz w:val="${hp}"/><w:szCs w:val="${hp}"/></w:rPr></w:rPrDefault>`
  // 替换都用函数：字体名里有 $ 时，替换串里的 $& $1 之类不会被展开
  if (/<w:docDefaults\s*\/>/.test(xml)) return xml.replace(/<w:docDefaults\s*\/>/, () => `<w:docDefaults>${rPr}</w:docDefaults>`)
  if (xml.includes('<w:docDefaults>'))
    return xml.replace(/<w:docDefaults>([\s\S]*?)<\/w:docDefaults>/, (_, inner: string) => `<w:docDefaults>${rPr}${inner.replace(/<w:rPrDefault\s*\/>|<w:rPrDefault>[\s\S]*?<\/w:rPrDefault>/g, '')}</w:docDefaults>`)
  return xml.replace(/(<w:styles\b[^>]*>)/, (open: string) => `${open}<w:docDefaults>${rPr}</w:docDefaults>`)
}

function patchHeaderRows(xml: string, headerRows: number[]): { xml: string; rows: number } {
  const edits: { at: number; del: number; ins: string }[] = []
  spans(xml, 'w:tbl').forEach((t, i) => {
    const n = headerRows[i] ?? 0
    if (!n) return
    for (const r of directChildren(xml, t, 'w:tr', 'w:tbl').slice(0, n)) {
      const row = xml.slice(r.start, r.end)
      if (/<w:tblHeader\b/.test(row.slice(0, row.indexOf('<w:tc') < 0 ? row.length : row.indexOf('<w:tc')))) continue
      const open = /^<w:tr\b[^>]*>/.exec(row)![0]
      const selfClosed = /<w:trPr\s*\/>/.exec(row)
      const trPr = /<w:trPr>/.exec(row)
      if (selfClosed) edits.push({ at: r.start + selfClosed.index, del: selfClosed[0].length, ins: '<w:trPr><w:tblHeader/></w:trPr>' })
      else if (trPr) edits.push({ at: r.start + trPr.index + trPr[0].length, del: 0, ins: '<w:tblHeader/>' })
      else {
        // trPr 要放在 tblPrEx 后面、第一个单元格前面
        const ex = /^<w:tblPrEx>[\s\S]*?<\/w:tblPrEx>|^<w:tblPrEx\s*\/>/.exec(row.slice(open.length))
        edits.push({ at: r.start + open.length + (ex ? ex[0].length : 0), del: 0, ins: '<w:trPr><w:tblHeader/></w:trPr>' })
      }
    }
  })
  let out = xml
  for (const e of edits.sort((a, b) => b.at - a.at)) out = out.slice(0, e.at) + e.ins + out.slice(e.at + e.del)
  return { xml: out, rows: edits.length }
}

/**
 * 横向页面：插件把宽高交换了一次，docx 库按 landscape 又换了一次，写出来是「竖着的宽高 + landscape」；
 * 页边距也是按竖放写的。宽小于高的 landscape 页面把宽高换回来、页边距转 90°（已经对的不动，修两次不会出错）。
 */
function patchLandscape(xml: string): { xml: string; fixed: number } {
  let fixed = 0
  const out = xml.replace(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g, (sect) => {
    const sz = /<w:pgSz\b[^>]*>/.exec(sect)?.[0]
    if (!sz || attr(sz, 'w:orient') !== 'landscape') return sect
    const w = Number(attr(sz, 'w:w'))
    const h = Number(attr(sz, 'w:h'))
    if (!(w < h)) return sect
    fixed++
    const swapped = sz.replace(/w:w="\d+"/, `w:w="${h}"`).replace(/w:h="\d+"/, `w:h="${w}"`)
    return sect.replace(sz, () => swapped).replace(/<w:pgMar\b[^>]*>/, (mar) => {
      const v = (k: string) => attr(mar, k) ?? '0'
      // 竖放的上、右、下、左 → 横放的：上 ← 右，右 ← 下，下 ← 左，左 ← 上
      const [top, right, bottom, left] = [v('w:right'), v('w:bottom'), v('w:left'), v('w:top')]
      return mar
        .replace(/w:top="-?\d+"/, `w:top="${top}"`)
        .replace(/w:right="-?\d+"/, `w:right="${right}"`)
        .replace(/w:bottom="-?\d+"/, `w:bottom="${bottom}"`)
        .replace(/w:left="-?\d+"/, `w:left="${left}"`)
    })
  })
  return { xml: out, fixed }
}

/**
 * 页眉离纸张上边的距离：插件按 docx 库的默认值写 w:header="708"（12.5 mm），编辑器是 header.top（30 px，约 8 mm），
 * WPS 里页眉比编辑器低 5 mm 左右。按编辑器的写，已经对的不动（s13 WPS 对比）。
 * 页脚不改：编辑器的页码画在离纸张下边 60 px 的地方，和插件写的 w:footer 差不到 2 mm
 */
function patchHeaderDistance(xml: string, headerTop: number): { xml: string; fixed: number } {
  let fixed = 0
  const want = String(twips(headerTop))
  const out = xml.replace(/<w:pgMar\b[^>]*\/>/g, (mar) => {
    if (attr(mar, 'w:header') === want) return mar
    fixed++
    return setAttrs(mar, { 'w:header': want })
  })
  return { xml: out, fixed }
}

/** canvas-editor 单元格内边距（table.tdPadding 默认 [0, 5, 5, 5] px，上右下左），换成缇（1 px = 15 缇） */
const CELL_MARGIN = `<w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="75" w:type="dxa"/><w:bottom w:w="75" w:type="dxa"/><w:right w:w="75" w:type="dxa"/></w:tblCellMar>`

/**
 * 表格：插件只写了列宽（tblGrid），表宽写成 100%、单元格不写宽度，Word / WPS 按内容重新分列宽，和编辑器对不上；
 * 也没写单元格边距，WPS 里字贴着竖线。按 tblGrid 给每个单元格写宽度（跨列的加起来）、表宽写成各列之和、固定列宽，
 * 单元格边距按编辑器的。已经有的不动，修两次结果一样（s13 WPS 对比）
 */
function patchTables(xml: string): { xml: string; fixed: number } {
  const edits: { at: number; del: number; ins: string }[] = []
  let fixed = 0
  for (const t of spans(xml, 'w:tbl')) {
    const tbl = xml.slice(t.start, t.end)
    // 这张表自己的 tblPr、tblGrid 在第一行之前（内层表格的在单元格里，更靠后）
    const firstRow = tbl.search(/<w:tr\b/)
    const head = firstRow < 0 ? tbl : tbl.slice(0, firstRow)
    const grid = /<w:tblGrid>([\s\S]*?)<\/w:tblGrid>/.exec(head)
    const pr = /<w:tblPr>([\s\S]*?)<\/w:tblPr>/.exec(head)
    if (!grid || !pr) continue
    const cols = [...grid[1]!.matchAll(/<w:gridCol\b[^>]*>/g)].map((m) => Number(attr(m[0], 'w:w')))
    if (!cols.length || cols.some((w) => !(w > 0))) continue
    let changed = false
    const prAt = t.start + pr.index + '<w:tblPr>'.length
    const inner = pr[1]!
    const tblW = /<w:tblW\b[^>]*\/>/.exec(inner)
    const want = `<w:tblW w:w="${cols.reduce((a, b) => a + b, 0)}" w:type="dxa"/>`
    if (tblW && tblW[0] !== want) {
      edits.push({ at: prAt + tblW.index, del: tblW[0].length, ins: want })
      changed = true
    }
    // tblLayout、tblCellMar 在 tblBorders、shd 后面，tblLook 前面
    const add = `${/<w:tblLayout\b/.test(inner) ? '' : '<w:tblLayout w:type="fixed"/>'}${/<w:tblCellMar\b/.test(inner) ? '' : CELL_MARGIN}`
    if (add) {
      const look = /<w:tblLook\b/.exec(inner)
      edits.push({ at: prAt + (look ? look.index : inner.length), del: 0, ins: add })
      changed = true
    }
    for (const r of directChildren(xml, t, 'w:tr', 'w:tbl')) {
      const row = xml.slice(r.start, r.end)
      let col = Number(attr(/<w:gridBefore\b[^>]*>/.exec(row)?.[0] ?? '', 'w:val') ?? 0)
      for (const c of directChildren(xml, r, 'w:tc', 'w:tbl')) {
        const open = /^<w:tc\b[^>]*>/.exec(xml.slice(c.start, c.end))![0]
        const rest = xml.slice(c.start + open.length, c.end)
        const tcPr = /^<w:tcPr\s*\/>|^<w:tcPr>([\s\S]*?)<\/w:tcPr>/.exec(rest)
        const span = Number(attr(/<w:gridSpan\b[^>]*>/.exec(tcPr?.[1] ?? '')?.[0] ?? '', 'w:val') ?? 1) || 1
        const width = cols.slice(col, col + span).reduce((a, b) => a + b, 0)
        col += span
        if (!width || /<w:tcW\b/.test(tcPr?.[1] ?? '')) continue
        const tcW = `<w:tcW w:w="${width}" w:type="dxa"/>`
        const at = c.start + open.length
        if (!tcPr) edits.push({ at, del: 0, ins: `<w:tcPr>${tcW}</w:tcPr>` })
        else if (tcPr[1] === undefined) edits.push({ at, del: tcPr[0].length, ins: `<w:tcPr>${tcW}</w:tcPr>` })
        else edits.push({ at: at + '<w:tcPr>'.length, del: 0, ins: tcW })
        changed = true
      }
    }
    if (changed) fixed++
  }
  let out = xml
  for (const e of edits.sort((a, b) => b.at - a.at)) out = out.slice(0, e.at) + e.ins + out.slice(e.at + e.del)
  return { xml: out, fixed }
}

/**
 * 行尾的空格（合同里常见的「联系电话：＿＿＿」是带下划线的空格）：编辑器画下划线，Word / WPS 默认不画。
 * 在 settings.xml 的兼容选项里打开 ulTrailSpace（s13 WPS 对比）
 */
function patchSettings(xml: string): string {
  if (/<w:ulTrailSpace\b/.test(xml)) return xml
  if (/<w:compat\s*\/>/.test(xml)) return xml.replace(/<w:compat\s*\/>/, '<w:compat><w:ulTrailSpace/></w:compat>')
  // compat 里的开关在 compatSetting 前面
  return xml.replace(/<w:compat>/, '<w:compat><w:ulTrailSpace/>')
}

/**
 * prepareForExport 放的段落标记：LIST_MARK 写悬挂缩进 w:ind（编号在左，换行和正文对齐），
 * SPACING_MARK 写段前段后间距（w:spacing 的 w:before、w:after，行距那两个属性不动），然后删掉标记
 */
function patchParagraphMarks(xml: string): { xml: string; lists: number; spacing: number } {
  // 段落可能是自闭合的 <w:p/>（不算），也可能嵌在文本框里：按标记开头那个字的位置找包着它的最里层段落。
  // spans 按开始位置排好了序：二分找开始位置在标记前面的最后一段，没包住标记的（文本框里已经结束的段落）往前退
  const paragraphs = spans(xml, 'w:p').filter((s) => xml.startsWith('</w:p>', s.end - 6))
  const marked = new Map<number, (typeof paragraphs)[number]>()
  for (const m of xml.matchAll(/[\uE000\uE002]/g)) {
    let lo = 0
    let hi = paragraphs.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (paragraphs[mid]!.start < m.index) lo = mid + 1
      else hi = mid - 1
    }
    let k = hi
    while (k >= 0 && paragraphs[k]!.end <= m.index) k--
    if (k >= 0) marked.set(paragraphs[k]!.start, paragraphs[k]!)
  }
  // 套着别的要改的段落的（文本框所在的段落）跳过：改动不互相覆盖。按开始位置排好后，下一段在它结束前开始就是套在它里面
  const all = [...marked.values()].sort((a, b) => a.start - b.start)
  const targets = all.filter((p, i) => !(all[i + 1] && all[i + 1]!.start < p.end))
  let lists = 0
  let spacing = 0
  // 改好的段落按顺序拼回去（一次拼完，不在整份 XML 上反复切）
  const parts: string[] = []
  let last = 0
  for (const p of targets) {
    const { text, ind, sp } = takeMarks(xml.slice(p.start, p.end))
    let next = text
    if (sp) {
      next = withPPr(next, 'spacing', (old) => setAttrs(old ?? '<w:spacing/>', { 'w:before': sp[0], 'w:after': sp[1] }))
      spacing++
    }
    if (ind) {
      next = withPPr(next, 'ind', () => `<w:ind w:left="${ind[0]}" w:hanging="${ind[1]}"/>`)
      lists++
    }
    parts.push(xml.slice(last, p.start), next)
    last = p.end
  }
  parts.push(xml.slice(last))
  // 兜底：上面跳过的段落里的标记（还有落单的标记字符）也不留在正文里，只是不写缩进、间距
  const out = parts.join('').replace(/(<w:t(?:\s[^>]*)?>)([^<]*)(<\/w:t>)/g, (all, open: string, s: string, close: string) =>
    /[\uE000-\uE003]/.test(s) ? open + s.replace(new RegExp(`${LIST_MARK.source}|${SPACING_MARK.source}`, 'g'), '').replace(RESERVED, '') + close : all,
  )
  return { xml: out, lists, spacing }
}

/**
 * 一个段落里的标记：把所有 w:t 的文字连起来找（渲染页会把印章插在一页第一个字后面，可能正好插在标记中间，
 * 标记被拆到两个 run 里），找到的、还有落单的标记字符都从各个 w:t 里删掉
 */
function takeMarks(p: string): { text: string; ind?: [string, string]; sp?: [string, string] } {
  const ts = [...p.matchAll(/(<w:t(?:\s[^>]*)?>)([^<]*)(<\/w:t>)/g)]
  const joined = ts.map((m) => m[2]).join('')
  const cut: [number, number][] = []
  const li = LIST_MARK.exec(joined)
  const sm = SPACING_MARK.exec(joined)
  if (li) cut.push([li.index, li.index + li[0].length])
  if (sm) cut.push([sm.index, sm.index + sm[0].length])
  for (const m of joined.matchAll(/[\uE000-\uE003]/g)) cut.push([m.index, m.index + 1])
  // 标记都是基本平面里的字符，按下标删不会拆开别的字
  const keep = (at: number) => !cut.some(([a, b]) => at >= a && at < b)
  let text = ''
  let last = 0
  let offset = 0
  for (const m of ts) {
    const s = m[2]!
    let kept = ''
    for (let k = 0; k < s.length; k++) if (keep(offset + k)) kept += s[k]
    offset += s.length
    text += p.slice(last, m.index) + m[1] + kept + m[3]
    last = m.index + m[0].length
  }
  text += p.slice(last)
  return { text, ind: li ? [li[1]!, li[2]!] : undefined, sp: sm ? [sm[1]!, sm[2]!] : undefined }
}

/** pPr 里的子元素按 OOXML 规定的顺序排：w:spacing、w:ind 插在排在它们后面的第一个元素之前 */
const PPR_AFTER = {
  spacing: /<w:(ind|contextualSpacing|mirrorIndents|suppressOverlap|jc|textDirection|textAlignment|textboxTightWrap|outlineLvl|divId|cnfStyle|rPr|sectPr|pPrChange)\b/,
  ind: /<w:(contextualSpacing|mirrorIndents|suppressOverlap|jc|textDirection|textAlignment|textboxTightWrap|outlineLvl|divId|cnfStyle|rPr|sectPr|pPrChange)\b/,
}
/** 改段落自己的 pPr 里的一个子元素（自闭合的那种）：有就交给 make 改，没有就按顺序插进去；pPr 没有或是 <w:pPr/> 也行 */
function withPPr(p: string, tag: keyof typeof PPR_AFTER, make: (old: string | undefined) => string): string {
  const open = /^<w:p\b[^>]*>/.exec(p)![0]
  const rest = p.slice(open.length)
  // 段落自己的 pPr 紧跟在开始标签后面
  const pPr = /^<w:pPr\s*\/>|^<w:pPr>([\s\S]*?)<\/w:pPr>/.exec(rest)
  if (!pPr) return `${open}<w:pPr>${make(undefined)}</w:pPr>${rest}`
  let inner = pPr[1] ?? ''
  // 只在 pPr 自己的子元素里找：段落标记的 w:rPr 里也可能有 w:spacing（那是字间距）
  const cut = inner.search(/<w:rPr\b/)
  const own = new RegExp(`<w:${tag}\\b[^>]*/>`).exec(cut < 0 ? inner : inner.slice(0, cut))
  if (own) inner = inner.slice(0, own.index) + make(own[0]) + inner.slice(own.index + own[0].length)
  else {
    const next = PPR_AFTER[tag].exec(inner)
    const el = make(undefined)
    inner = next ? inner.slice(0, next.index) + el + inner.slice(next.index) : inner + el
  }
  return `${open}<w:pPr>${inner}</w:pPr>${rest.slice(pPr[0].length)}`
}
/** 给一个自闭合的元素设属性（有就换值，没有就加上） */
function setAttrs(el: string, attrs: Record<string, string>): string {
  let out = el
  for (const [k, v] of Object.entries(attrs)) {
    const re = new RegExp(`\\s${k}="[^"]*"`)
    out = re.test(out) ? out.replace(re, () => ` ${k}="${v}"`) : out.replace(/\s*\/>$/, () => ` ${k}="${v}"/>`)
  }
  return out
}

/** 修插件导出的 docx：默认字体、重复标题行、横向页面、页眉距离、表格列宽和边距、列表缩进、段前段后间距、行尾空格的下划线。返回新文件和改了几处 */
export async function fixExportedDocx(
  bytes: Uint8Array | ArrayBuffer,
  info: ExportInfo,
): Promise<{ bytes: Uint8Array; headerRows: number; landscape: number; tables: number; lists: number; spacing: number }> {
  const zip = await JSZip.loadAsync(bytes)
  const styles = await zip.file('word/styles.xml')?.async('string')
  if (styles !== undefined) zip.file('word/styles.xml', patchStyles(styles, info.defaultFont, info.defaultSize))
  const settings = await zip.file('word/settings.xml')?.async('string')
  if (settings !== undefined) zip.file('word/settings.xml', patchSettings(settings))
  const docFile = zip.file('word/document.xml')
  if (!docFile) throw new Error('导出的 docx 里没有 word/document.xml')
  const doc = await docFile.async('string')
  const r = patchHeaderRows(doc, info.headerRows)
  const l = patchLandscape(r.xml)
  const h = patchHeaderDistance(l.xml, info.headerTop)
  const t = patchTables(h.xml)
  const m = patchParagraphMarks(t.xml)
  zip.file('word/document.xml', m.xml)
  // 页眉页脚里的表格、段落标记也一样（导入的页眉可能是表格）
  let { lists, spacing } = m
  let tables = t.fixed
  for (const name of Object.keys(zip.files).filter((n) => /^word\/(header|footer)\d*\.xml$/.test(n))) {
    const orig = await zip.file(name)!.async('string')
    const part = patchTables(orig)
    const marks = patchParagraphMarks(part.xml)
    // 按内容有没有变写回：只清掉了落单标记的也要写
    if (marks.xml !== orig) zip.file(name, marks.xml)
    tables += part.fixed
    lists += marks.lists
    spacing += marks.spacing
  }
  return { bytes: await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }), headerRows: r.rows, landscape: l.fixed, tables, lists, spacing }
}
