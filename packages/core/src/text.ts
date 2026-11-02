// 文字定位和改写。规则照 canvas-editor 自己的实现（formatElementList / zipElementList / insertElementList），
// 目标是同一组操作在这里执行，和在编辑器里执行后 getValue() 的结果相同（K8 已验证，e2e/core 回归）。
import { OpError } from './errors'
import { clone, type El } from './model'

// 能参与关键字匹配、能拆开 / 合并的文字元素（没有 type 就是文字）
const TEXT_TYPES = new Set([undefined, 'text', 'subscript', 'superscript'])
// 编辑器插入元素时，从光标前一个字带过来的段落属性
export const CONTEXT_ATTRS = ['rowFlex', 'rowMargin', 'spacingBefore', 'spacingAfter'] as const
// 控件自己的文字样式，会带到控件的值上
export const CONTROL_STYLE_ATTRS = ['font', 'size', 'bold', 'highlight', 'italic', 'strikeout'] as const
// 段落级的块元素：改整段时遇到它们就是段落边界
const BLOCK_TYPES = new Set(['table', 'title', 'list', 'area', 'separator', 'pageBreak', 'block'])
// 找关键字时会进去找的容器；超链接、日期、控件的内容不进去
const SEARCH_INTO = new Set(['title', 'list', 'area'])

// 不写成类型守卫：元素本来就是 El，守卫的 false 分支会被收窄成 never
export const isText = (el: El | undefined): boolean => !!el && TEXT_TYPES.has(el.type)

export const pick = (obj: Record<string, unknown> | undefined, keys: readonly string[]): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const k of keys) if (obj && obj[k] !== undefined) out[k] = obj[k]
  return out
}

const sameAttrs = (a: El, b: El): boolean => {
  const ka = Object.keys(a).filter((k) => k !== 'value')
  const kb = Object.keys(b).filter((k) => k !== 'value')
  if (ka.length !== kb.length) return false
  return ka.every((k) => k in b && (a[k] === b[k] || JSON.stringify(a[k]) === JSON.stringify(b[k])))
}

/** 和编辑器 getValue() 一样：去掉空文字元素，相邻且样式相同的文字合并 */
export function canonicalize(list: El[]): El[] {
  for (let i = list.length - 1; i >= 0; i--) if (isText(list[i]) && list[i]!.value === '') list.splice(i, 1)
  for (let i = list.length - 1; i > 0; i--) {
    const a = list[i - 1]!
    const b = list[i]!
    if (isText(a) && isText(b) && sameAttrs(a, b)) {
      a.value += b.value
      list.splice(i, 1)
    }
  }
  return list
}

/** 编辑器插入元素时的做法：前一个字有的段落属性带过来，没有的删掉 */
export function applyContext(el: El, ctx: El | undefined): El {
  for (const k of CONTEXT_ATTRS) {
    if (ctx && ctx[k] !== undefined) el[k] = clone(ctx[k])
    else delete el[k]
  }
  return el
}

interface RunItem {
  index: number
  start: number
  end: number
}
/** 同一个容器里相邻的文字元素拼成的一串 */
export interface Run {
  list: El[]
  where: string
  items: RunItem[]
  text: string
}

export function textRuns(list: El[]): Run[] {
  const runs: Run[] = []
  const visit = (container: El[], where: string) => {
    let run: Run | null = null
    container.forEach((el, index) => {
      if (isText(el)) {
        run ??= { list: container, where, items: [], text: '' }
        run.items.push({ index, start: run.text.length, end: run.text.length + el.value.length })
        run.text += el.value
        return
      }
      if (run) runs.push(run)
      run = null
      if (SEARCH_INTO.has(el.type ?? '') && Array.isArray(el.valueList)) visit(el.valueList, `${where}[${index}].valueList`)
      if (el.type === 'table')
        (el.trList ?? []).forEach((tr, r) =>
          (tr.tdList ?? []).forEach((td, d) => visit(td.value ?? [], `${where}[${index}].trList[${r}].tdList[${d}].value`)),
        )
    })
    if (run) runs.push(run)
  }
  visit(list, '')
  return runs
}

export interface Match {
  run: Run
  start: number
  end: number
  total: number
}

/** 找第 occurrence 处关键字（从 0 计，-1 是最后一处）。可以跨样式不同的相邻文字元素 */
export function findText(list: El[], keyword: string, occurrence = 0): Match {
  if (!keyword) throw new OpError('BAD_ARGUMENT', '要找的文字不能为空')
  const matches: Omit<Match, 'total'>[] = []
  for (const run of textRuns(list)) {
    let at = run.text.indexOf(keyword)
    while (at !== -1) {
      matches.push({ run, start: at, end: at + keyword.length })
      at = run.text.indexOf(keyword, at + keyword.length)
    }
  }
  if (!matches.length) throw new OpError('TARGET_NOT_FOUND', `找不到「${keyword}」`)
  const i = occurrence < 0 ? matches.length + occurrence : occurrence
  const m = matches[i]
  if (!m) throw new OpError('OCCURRENCE_OUT_OF_RANGE', `「${keyword}」只有 ${matches.length} 处，没有第 ${occurrence} 处`)
  return { ...m, total: matches.length }
}

const itemAt = (run: Run, pos: number) => run.items.find((it) => pos >= it.start && pos < it.end)

/** 把文字段里 [start, end) 的字拿掉，在原位置放 insert；map 可以改写被拿掉的那几段（用来改样式） */
export function spliceRun(run: Run, start: number, end: number, insert: El[], map?: (piece: El) => El): void {
  const { list, items } = run
  const first = items[0]!.index
  const last = items[items.length - 1]!.index
  const out: El[] = []
  let inserted = false
  const put = () => {
    if (!inserted) out.push(...insert)
    inserted = true
  }
  for (const it of items) {
    const el = list[it.index]!
    if (it.end <= start || it.start >= end) {
      if (it.start >= end) put()
      out.push(el)
      continue
    }
    const from = Math.max(0, start - it.start)
    const to = Math.min(el.value.length, end - it.start)
    if (from > 0) out.push({ ...el, value: el.value.slice(0, from) })
    if (map) out.push(map({ ...clone(el), value: el.value.slice(from, to) }))
    else put()
    if (to < el.value.length) out.push({ ...clone(el), value: el.value.slice(to) })
  }
  if (map) inserted = true
  put()
  list.splice(first, last - first + 1, ...out)
  canonicalize(list)
}

/** 编辑器插入元素时取段落属性的那个字：光标前一个字；它是换行或在容器开头时，取后一个字 */
export function contextAt(run: Run, pos: number): El | undefined {
  if (pos > 0 && run.text[pos - 1] !== '\n') return run.list[itemAt(run, pos - 1)!.index]
  if (pos === 0) {
    const prev = run.list[run.items[0]!.index - 1]
    if (prev && !isText(prev)) return prev
  }
  const it = itemAt(run, pos) ?? itemAt(run, pos - 1) ?? run.items[0]!
  return run.list[it.index]
}

/** 整段换成新文字：沿用段首第一个字的样式；段里有控件、图片等元素时拒绝，不会把它们删掉 */
export function replaceParagraph(m: Match, newText: string): string {
  if (!newText) throw new OpError('BAD_ARGUMENT', '新文字不能为空')
  if (newText.includes('\n')) throw new OpError('BAD_ARGUMENT', '新文字不能含换行（一次只改一段）')
  const { run } = m
  const list = run.list
  const inline: El[] = []
  // 往前找段首
  let si = itemAt(run, m.start)!.index
  let so = m.start - run.items.find((it) => it.index === si)!.start
  const cut0 = so > 0 ? list[si]!.value.lastIndexOf('\n', so - 1) : -1
  if (cut0 >= 0) so = cut0 + 1
  else {
    so = 0
    for (let i = si - 1; i >= 0; i--) {
      const el = list[i]!
      if (isText(el)) {
        const cut = el.value.lastIndexOf('\n')
        si = i
        if (cut >= 0) {
          so = cut + 1
          break
        }
        continue
      }
      if (BLOCK_TYPES.has(el.type ?? '')) break
      inline.push(el)
      si = i
    }
  }
  // 往后找段尾
  const lastItem = itemAt(run, m.end - 1)!
  let ei = lastItem.index
  let eo = m.end - lastItem.start
  const cut1 = list[ei]!.value.indexOf('\n', eo)
  if (cut1 >= 0) eo = cut1
  else {
    eo = list[ei]!.value.length
    for (let i = ei + 1; i < list.length; i++) {
      const el = list[i]!
      if (isText(el)) {
        const cut = el.value.indexOf('\n')
        ei = i
        if (cut >= 0) {
          eo = cut
          break
        }
        eo = el.value.length
        continue
      }
      if (BLOCK_TYPES.has(el.type ?? '')) break
      inline.push(el)
      ei = i
      eo = 0
    }
  }
  if (inline.length) {
    const what = inline.map((el) => (el.type === 'control' ? `控件 ${el.control?.conceptId}` : el.type)).join('、')
    throw new OpError('PARAGRAPH_HAS_ELEMENTS', `段落里有 ${what}，整段替换会删掉它们，没有执行`)
  }
  let firstEl = list[si]!
  if (so >= firstEl.value.length && isText(list[si + 1])) firstEl = list[si + 1]!
  const style: El = { ...clone(firstEl), value: newText }
  let oldText = ''
  const out: El[] = []
  for (let i = si; i <= ei; i++) {
    const el = list[i]!
    const from = i === si ? so : 0
    const to = i === ei ? eo : el.value.length
    oldText += el.value.slice(from, to)
    if (i === si && from > 0) out.push({ ...el, value: el.value.slice(0, from) })
    if (i === si) out.push(style)
    if (i === ei && to < el.value.length) out.push({ ...clone(el), value: el.value.slice(to) })
  }
  list.splice(si, ei - si + 1, ...out)
  canonicalize(list)
  return oldText
}
