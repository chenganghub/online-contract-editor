// 修订（docs/设计/08 第 3 节）：canvas-editor 的 trace。打开修订后改正文，插入、删除的元素带 trace（[{ type, author, timestamp }]，
// 最后一条是现在的状态）；删除的元素还在文档 JSON 里，编辑器不画（修订模式下画删除线），导出、版本对比前去掉。
// 这里列出修订、接受、拒绝，浏览器和服务端共用。整个字段、整张表格被插入或删除时算一处，不再看里面
import { clone, ZONES, type Doc, type El } from './model'
import type { DocData } from './types'

export type TraceType = 'inserted' | 'deleted'
interface Mark {
  type: TraceType
  author?: string
  timestamp?: number
}

/** 一处修订：同一个人连着插入（或删除）的一段 */
export interface TraceChange {
  /** 类型、作者、首尾时间和同样的第几处；同一份文档算出来的一样，接受、拒绝时按它找 */
  key: string
  type: TraceType
  /** 修订时编辑器里的名字；没有时是空串 */
  author: string
  /** 这一段里最早、最晚的时间（毫秒） */
  from: number
  to: number
  /** 改了的内容：文字照原样，字段写成［字段名］，图片、表格这些写成［图片］［表格］ */
  text: string
  zone: (typeof ZONES)[number]
}

const marksOf = (el: El): Mark[] => (Array.isArray(el.trace) ? (el.trace as Mark[]) : [])
/** 删掉了、还没接受的元素：编辑器不画，取文字、导出时不算 */
export const isDeleted = (el: object): boolean => marksOf(el as El).at(-1)?.type === 'deleted'

/** 元素里面的元素列表：区域、标题、列表、超链接、日期的 valueList，字段的值，表格的单元格 */
function* inner(el: El): Generator<El[]> {
  if (Array.isArray(el.valueList)) yield el.valueList
  if (el.type === 'control' && Array.isArray(el.control?.value)) yield el.control.value
  if (el.type === 'table' && Array.isArray(el.trList))
    for (const tr of el.trList) if (tr && Array.isArray(tr.tdList)) for (const td of tr.tdList) if (td && Array.isArray(td.value)) yield td.value
}
// 文档 JSON 来自外部、没有逐项校验：不是对象的项跳过（和 model.ts 的 walk 一样）
const isEl = (v: unknown): v is El => !!v && typeof v === 'object'

const LABELS: Record<string, string> = { image: '图片', table: '表格', latex: '公式', separator: '分隔线', pageBreak: '分页符', checkbox: '复选框', radio: '单选框' }
const TEXT_TYPES = new Set([undefined, 'text', 'subscript', 'superscript'])
function textOf(el: El): string {
  if (el.type === 'control') return `［${String(el.control?.placeholder ?? el.control?.conceptId ?? '字段')}］`
  if (TEXT_TYPES.has(el.type)) return String(el.value ?? '').replace(/\u200B/g, '')
  if (el.type === 'tab') return '\t'
  if (Array.isArray(el.valueList)) return el.valueList.filter(isEl).map(textOf).join('')
  return `［${LABELS[el.type ?? ''] ?? '内容'}］`
}

/** 按文档顺序（页眉、正文、页脚）找出每一处修订和它的元素 */
function collect(doc: Doc): { change: TraceChange; els: El[] }[] {
  const hits: { change: TraceChange; els: El[] }[] = []
  const visit = (list: El[], zone: TraceChange['zone']) => {
    let open: (typeof hits)[number] | null = null
    for (const el of list) {
      if (!isEl(el)) {
        open = null
        continue
      }
      const mark = marksOf(el).at(-1)
      if (!mark) {
        open = null
        for (const l of inner(el)) visit(l, zone)
        continue
      }
      const author = mark.author ?? ''
      const at = mark.timestamp ?? 0
      if (open && open.change.type === mark.type && open.change.author === author) {
        open.els.push(el)
        open.change.from = Math.min(open.change.from, at)
        open.change.to = Math.max(open.change.to, at)
        open.change.text += textOf(el)
      } else {
        open = { change: { key: '', type: mark.type, author, from: at, to: at, text: textOf(el), zone }, els: [el] }
        hits.push(open)
      }
    }
  }
  for (const zone of ZONES) if (Array.isArray(doc[zone])) visit(doc[zone], zone)
  const seen = new Map<string, number>()
  for (const { change } of hits) {
    const sig = `${change.zone}:${change.type}:${change.author}:${change.from}:${change.to}`
    const n = seen.get(sig) ?? 0
    seen.set(sig, n + 1)
    change.key = `${sig}#${n}`
  }
  return hits
}

/** 文档里还没接受、拒绝的修订，按文档顺序 */
export const traceChanges = (doc: DocData): TraceChange[] => collect(doc as unknown as Doc).map((h) => h.change)

/** 去掉元素最后一条修订记录；里面的元素是同一次操作记下的（同类型、作者、时间）也去掉 */
function popMark(el: El) {
  const marks = marksOf(el)
  const mark = marks.at(-1)!
  const same = (m: Mark) => m.type === mark.type && m.author === mark.author && m.timestamp === mark.timestamp
  const strip = (e: El, all: boolean) => {
    const rest = all ? marksOf(e).slice(0, -1) : marksOf(e).filter((m) => !same(m))
    if (rest.length) e.trace = rest
    else delete e.trace
    for (const l of inner(e)) for (const c of l) if (isEl(c)) strip(c, false)
  }
  strip(el, true)
}

/** 把每个列表里不要的元素去掉（原地改，列表对象不换） */
function prune(doc: Doc, gone: (el: El) => boolean, after?: (el: El) => void) {
  const visit = (list: El[]) => {
    const kept = list.filter((el) => !isEl(el) || !gone(el))
    list.splice(0, list.length, ...kept)
    for (const el of kept) {
      if (!isEl(el)) continue
      after?.(el)
      for (const l of inner(el)) visit(l)
    }
  }
  for (const zone of ZONES) if (Array.isArray(doc[zone])) visit(doc[zone])
}

/**
 * 接受或拒绝修订，返回新文档（不改传进来的）。keys 是 traceChanges 给的 key；不给就是全部：
 * 全部接受 = 删掉的去掉、其余去掉修订记录（导出、版本对比用的「成稿」）；全部拒绝 = 插入的去掉、其余去掉修订记录（回到修订前）
 */
export function resolveTraces(data: DocData, action: 'accept' | 'reject', keys?: readonly string[]): DocData {
  const doc = clone(data) as unknown as Doc
  if (!keys) {
    const gone = (el: El) => (action === 'accept' ? isDeleted(el) : marksOf(el)[0]?.type === 'inserted')
    prune(doc, gone, (el) => delete el.trace)
    return doc as unknown as DocData
  }
  const want = new Set(keys)
  const drop = new Set<El>()
  for (const { change, els } of collect(doc)) {
    if (!want.has(change.key)) continue
    // 接受删除、拒绝插入：元素去掉；接受插入、拒绝删除：去掉这条修订记录（插入后又删掉的，拒绝删除后还是插入）
    if ((action === 'accept') === (change.type === 'deleted')) for (const el of els) drop.add(el)
    else for (const el of els) popMark(el)
  }
  if (drop.size) prune(doc, (el) => drop.has(el))
  return doc as unknown as DocData
}
