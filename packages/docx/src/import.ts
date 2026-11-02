// 插件导入后补回它丢掉的信息，并出导入报告（方案 4.10、验收 3）
import { A4, DEFAULT_FONT, DEFAULT_SIZE, type PageSetup } from '@oe/core'
import { squeeze, tablesOf, textOf, walk, type Doc, type El } from './model'
import { applySpacing, fixBreaks, paragraphsOf, splitBreaks } from './paragraphs'
import type { DocxScan } from './scan'

export interface ReportItem {
  kind: string
  /** ok：保留了；fixed：插件丢了、我们补回了（或替用户做了处理）；lost：没保留，提示用户 */
  level: 'ok' | 'fixed' | 'lost'
  message: string
  count?: number
  sample?: string
}

export interface ImportReport {
  items: ReportItem[]
  /** 正文文字去空白后和 docx 是否一字不差 */
  textExact: boolean
}

export interface PatchResult {
  /** 补好的文档，纸张设置在 doc.page */
  doc: Doc
  report: ImportReport
}

export interface PatchOptions {
  /** 插件按 docx 的文档默认值设的字体、字号：元素上没写的补上，换到编辑器的默认值下也不变 */
  defaultFont?: string
  defaultSize?: number
}

/** 两段文字的差异：缺了哪些字、多了哪些字、第一处不一样的位置前后 */
function diffText(source: string, got: string) {
  const count = (s: string) => {
    const m = new Map<string, number>()
    for (const ch of s) m.set(ch, (m.get(ch) ?? 0) + 1)
    return m
  }
  const a = count(source)
  const b = count(got)
  const missing = [...a].filter(([ch, n]) => n > (b.get(ch) ?? 0)).map(([ch, n]) => ch.repeat(n - (b.get(ch) ?? 0)))
  const extra = [...b].filter(([ch, n]) => n > (a.get(ch) ?? 0)).map(([ch, n]) => ch.repeat(n - (a.get(ch) ?? 0)))
  let i = 0
  while (i < source.length && source[i] === got[i]) i++
  return { missing: missing.join('').slice(0, 40), extra: extra.join('').slice(0, 40), at: source.slice(Math.max(0, i - 10), i + 10) }
}

/** 一段内容（正文、页眉、页脚、单元格）：拆换行、改换行的段落属性；表格里的单元格也做 */
function fixFlow(list: El[] | undefined): El[] {
  const out = splitBreaks(list ?? [])
  fixBreaks(out)
  for (const el of out) if (el.type === 'table') for (const tr of el.trList ?? []) for (const td of tr.tdList ?? []) td.value = fixFlow(td.value)
  return out
}

export function patchImported(imported: Doc, scan: DocxScan, opts: PatchOptions = {}): PatchResult {
  const doc = structuredClone(imported)
  const items: ReportItem[] = []

  // 文档默认字体字号：插件导入时设成了编辑器选项，存下来的文档不带选项，补到元素上
  const font = opts.defaultFont && opts.defaultFont !== DEFAULT_FONT ? opts.defaultFont : undefined
  const size = opts.defaultSize && opts.defaultSize !== DEFAULT_SIZE ? opts.defaultSize : undefined
  if (font || size)
    for (const zone of [doc.header, doc.main, doc.footer])
      for (const el of walk(zone)) {
        if (!(el.type === undefined || el.type === 'text') || el.value === '\n') continue
        if (font) el.font ??= font
        if (size) el.size ??= size
      }

  doc.header = fixFlow(doc.header)
  doc.main = fixFlow(doc.main)
  doc.footer = fixFlow(doc.footer)

  // 表格：按出现顺序和 docx 里的表一一对应
  const tables = tablesOf(doc.main)
  const tablesMatch = tables.length === scan.tables.length
  if (tablesMatch) {
    let repeat = 0
    let borderless = 0
    tables.forEach((t, i) => {
      const info = scan.tables[i]!
      const n = Math.min(info.headerRows, t.trList?.length ?? 0)
      for (let r = 0; r < n; r++) t.trList![r]!.pagingRepeat = true
      if (n) repeat++
      if (info.borderless) {
        t.borderType = 'empty'
        borderless++
      }
    })
    if (tables.length) items.push({ kind: 'table', level: 'ok', message: `表格 ${tables.length} 张，合并单元格保留`, count: tables.length })
    if (repeat) items.push({ kind: 'tableHeader', level: 'fixed', message: `${repeat} 张表的重复标题行已补回（跨页时每页重复表头）`, count: repeat })
    if (borderless) items.push({ kind: 'tableBorder', level: 'fixed', message: `${borderless} 张无边框表已改回无边框`, count: borderless })
  } else if (scan.tables.length)
    items.push({ kind: 'table', level: 'lost', message: `docx 里有 ${scan.tables.length} 张表，导入后 ${tables.length} 张，重复标题行、无边框、表格里的段间距没有补`, count: scan.tables.length })

  // 段前段后间距：正文按段落文字对上；表格对得上时，表格里的段落也对
  const sp = applySpacing(scan.paras, paragraphsOf(doc.main))
  if (tablesMatch)
    tables.forEach((t, i) => {
      const cells = (t.trList ?? []).flatMap((tr) => (tr.tdList ?? []).flatMap((td) => paragraphsOf(td.value)))
      const r = applySpacing(scan.tables[i]!.paras, cells)
      sp.applied += r.applied
      sp.wanted += r.wanted
    })
  if (sp.applied) items.push({ kind: 'spacing', level: 'fixed', message: `段前段后间距已补回 ${sp.applied} 段`, count: sp.applied })
  if (scan.features.spacing > sp.applied)
    items.push({ kind: 'spacing', level: 'lost', message: `还有 ${scan.features.spacing - sp.applied} 段的段间距没对上段落，没有补`, count: scan.features.spacing - sp.applied })

  // 纸张：编辑器整篇只有一种纸张，按第一节。横放时编辑器把页边距转 90°，这里先转回竖放的写法
  const first = scan.sections[0]
  const m = first?.margins ?? A4.margins
  const page: PageSetup = {
    width: first?.width ?? A4.width,
    height: first?.height ?? A4.height,
    paperDirection: first?.landscape ? 'horizontal' : 'vertical',
    margins: first?.landscape ? [m[3], m[0], m[1], m[2]] : [m[0], m[1], m[2], m[3]],
  }
  items.push({
    kind: 'paper',
    level: 'ok',
    message: `纸张 ${Math.round((page.width * 25.4) / 96)} × ${Math.round((page.height * 25.4) / 96)} mm${first?.landscape ? '，横向' : ''}，页边距已按第一节设置`,
  })
  const distinct = new Set(scan.sections.map((s) => `${s.width}x${s.height}:${s.landscape}:${s.margins.join(',')}`))
  if (distinct.size > 1)
    items.push({ kind: 'sections', level: 'lost', message: `文档分 ${scan.sections.length} 节，纸张、方向或页边距不同；编辑器整篇只有一种纸张，都按第一节`, count: scan.sections.length })

  // 页码：页脚的 PAGE / NUMPAGES 域在插件里变成固定文字，换成编辑器自己的页码
  if (scan.pageNumber) {
    page.pageNumber = { format: scan.pageNumber.format, rowFlex: scan.pageNumber.rowFlex }
    const whole = squeeze(textOf(doc.footer)) === squeeze(scan.pageNumber.literal)
    if (whole) doc.footer = []
    items.push(
      whole
        ? { kind: 'pageNumber', level: 'fixed', message: `页脚页码已改成自动页码（${scan.pageNumber.format}）` }
        : { kind: 'pageNumber', level: 'lost', message: '页脚里除了页码还有别的内容，页码那段留成了固定文字；已另外打开自动页码，请删掉页脚里的固定页码' },
    )
  } else items.push({ kind: 'pageNumber', level: 'fixed', message: 'docx 里没有页码，已加上编辑器的自动页码' })
  doc.page = page

  // 文字比对：正文（含表格、文本框）去空白后一字不差
  const source = squeeze(scan.bodyText)
  const got = squeeze(textOf(doc.main))
  const textExact = source === got
  items.unshift(
    textExact
      ? { kind: 'text', level: 'ok', message: `正文文字一字不差（${source.length} 字）`, count: source.length }
      : (() => {
          const d = diffText(source, got)
          return { kind: 'text', level: 'lost' as const, message: `正文文字有出入：docx ${source.length} 字，导入后 ${got.length} 字`, sample: `缺「${d.missing}」多「${d.extra}」，第一处在「${d.at}」附近` }
        })(),
  )
  if (squeeze(scan.headerText) && squeeze(textOf(doc.header)) !== squeeze(scan.headerText))
    items.push({ kind: 'header', level: 'lost', message: '页眉文字和 docx 不一致', sample: textOf(doc.header).slice(0, 40) })

  // 行距：插件把 Word 的倍数行距直接当编辑器的行距倍数，两边算法不同，行高会比 Word 大一些
  if ([...walk(doc.main)].some((e) => typeof e.rowMargin === 'number' && e.rowMargin !== 1))
    items.push({ kind: 'lineSpacing', level: 'lost', message: '行距按编辑器的算法换算，行高和 Word 不完全一样，页数可能不同' })

  // 编辑器不支持、只能提示的
  const f = scan.features
  const lost = (kind: string, count: number, message: string) => count && items.push({ kind, level: 'lost', count, message })
  lost('firstLineIndent', f.firstLineIndent, `首行缩进 ${f.firstLineIndent} 段没有保留（编辑器不支持首行缩进，可以在段首加两个全角空格）`)
  lost('textBox', f.textBoxes, `文本框 ${f.textBoxes} 个：里面的文字导入成了正文或丢失，请核对`)
  lost('revision', f.revisions, `修订痕迹 ${f.revisions} 处没有保留，请先在 Word 里接受或拒绝修订`)
  lost('comment', f.comments, `批注 ${f.comments} 条没有导入`)
  lost('footnote', f.footnotes, `脚注 ${f.footnotes} 条没有导入`)
  lost('mixedFont', f.mixedFonts, `中英文分别设了字体的地方 ${f.mixedFonts} 处，导入后统一用中文字体`)
  if (f.numberFormats.length) items.push({ kind: 'numbering', level: 'lost', message: `编号格式 ${f.numberFormats.join('、')} 不支持，导入后是阿拉伯数字编号`, sample: f.numberFormats.join('、') })
  if (f.otherFields.length) items.push({ kind: 'field', level: 'lost', message: `域 ${f.otherFields.join('、')} 导入后是固定文字`, sample: f.otherFields.join('、') })

  return { doc, report: { items, textExact } }
}
