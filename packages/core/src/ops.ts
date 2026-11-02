// 操作：在文档 JSON 的副本上逐条执行，任一失败整批不生效。浏览器和 Node 用同一份代码。
import { OpError } from './errors'
import { controlValue, setFieldValues } from './fields'
import { clone, controlLocs, elAt, walkDoc, type Doc, type El, type Loc } from './model'
import {
  applyContext,
  CONTEXT_ATTRS,
  CONTROL_STYLE_ATTRS,
  contextAt,
  findText,
  pick,
  replaceParagraph,
  spliceRun,
  type Match,
} from './text'
import type { BatchResult, DocData, Op, OpContext, SealPlacement, Target } from './types'

type Located = { kind: 'text'; match: Match } | { kind: 'element'; locs: Loc[] } | { kind: 'cell'; list: El[] }

const pickOccurrence = (locs: Loc[], occurrence: number | undefined, what: string): Loc[] => {
  if (occurrence === undefined) return locs
  const i = occurrence < 0 ? locs.length + occurrence : occurrence
  const hit = locs[i]
  if (!hit) throw new OpError('OCCURRENCE_OUT_OF_RANGE', `${what}只有 ${locs.length} 处，没有第 ${occurrence} 处`)
  return [hit]
}

/** 定位。field 不带 occurrence 时指全部出现的位置 */
export function locate(doc: Doc, target: Target): Located {
  if ('text' in target) return { kind: 'text', match: findText(doc.main, target.text, target.occurrence ?? 0) }
  if ('id' in target) {
    const locs = [...walkDoc(doc)].filter((l) => {
      const el = elAt(l)
      return el.controlId === target.id || el.id === target.id
    })
    // 一个控件在压缩格式里是一个元素；没有 controlId 时按 id 找
    if (!locs.length) throw new OpError('TARGET_NOT_FOUND', `找不到 id 为 ${target.id} 的元素`)
    return { kind: 'element', locs: [locs[0]!] }
  }
  if ('field' in target) {
    const locs = controlLocs(doc).filter((l) => elAt(l).control!.conceptId === target.field)
    if (!locs.length) throw new OpError('FIELD_NOT_FOUND', `文档里没有字段 ${target.field}`)
    return { kind: 'element', locs: pickOccurrence(locs, target.occurrence, `字段 ${target.field} `) }
  }
  if ('anchor' in target) {
    const locs = [...walkDoc(doc)].filter((l) => {
      const el = elAt(l)
      return el.type === 'area' && (el.areaId === target.anchor || el.area?.extension?.anchor === target.anchor)
    })
    if (!locs.length) throw new OpError('TARGET_NOT_FOUND', `找不到锚点 ${target.anchor}`)
    return { kind: 'element', locs: [locs[0]!] }
  }
  const { id, row, col } = target.table
  const table = [...walkDoc(doc)].map(elAt).find((el) => el.type === 'table' && el.id === id)
  if (!table) throw new OpError('TARGET_NOT_FOUND', `找不到表格 ${id}`)
  const td = table.trList?.[row]?.tdList?.[col]
  if (!td) throw new OpError('TARGET_NOT_FOUND', `表格 ${id} 没有第 ${row} 行第 ${col} 列`)
  td.value ??= []
  return { kind: 'cell', list: td.value }
}

/** 插入的控件和编辑器一样把值统一成元素数组：空值是 []，下拉只给了 code 时补上显示文字 */
function normalizeControl(el: El): El {
  const c = el.control
  if (el.type !== 'control' || !c) return el
  if (typeof c.value === 'string') c.value = controlValue(el, c.value)
  else if (!Array.isArray(c.value) || !c.value.length) {
    const hit = c.type === 'select' && c.code ? c.valueSets?.find((s) => s.code === c.code) : undefined
    c.value = hit ? controlValue(el, hit.value) : []
  } else
    c.value = c.value.map((v) => ({ ...v, type: v.type ?? 'text', ...pick(c, CONTROL_STYLE_ATTRS), ...pick(el, CONTEXT_ATTRS) }))
  return el
}

/** 插入的元素按编辑器的做法带上段落属性 */
const withContext = (elements: El[], ctx: El | undefined): El[] =>
  elements.map((e) => normalizeControl(applyContext(clone(e), ctx)))

// 同一个数组里多处位置要改时从后往前改，前面的下标才不会错位
const byIndexDesc = (locs: Loc[]) => [...locs].sort((a, b) => (a.list === b.list ? b.index - a.index : 0))

function insert(doc: Doc, target: Target, elements: El[], position: 'before' | 'after'): void {
  const at = locate(doc, target)
  if (at.kind === 'text') {
    const pos = position === 'before' ? at.match.start : at.match.end
    spliceRun(at.match.run, pos, pos, withContext(elements, contextAt(at.match.run, pos)))
    return
  }
  if (at.kind === 'cell') {
    at.list.splice(position === 'before' ? 0 : at.list.length, 0, ...clone(elements))
    return
  }
  for (const l of byIndexDesc(at.locs)) l.list.splice(position === 'before' ? l.index : l.index + 1, 0, ...withContext(elements, elAt(l)))
}

function replace(doc: Doc, target: Target, elements: El[]): void {
  const at = locate(doc, target)
  if (at.kind === 'text') {
    spliceRun(at.match.run, at.match.start, at.match.end, withContext(elements, contextAt(at.match.run, at.match.start)))
    return
  }
  if (at.kind === 'cell') {
    at.list.splice(0, at.list.length, ...clone(elements))
    return
  }
  for (const l of byIndexDesc(at.locs)) l.list.splice(l.index, 1, ...withContext(elements, elAt(l)))
}

function update(doc: Doc, target: Target, properties: Record<string, unknown>): void {
  if ('value' in properties || 'code' in properties) throw new OpError('BAD_ARGUMENT', '改值请用 setData，不要放在 properties 里')
  const at = locate(doc, target)
  if (at.kind === 'text') {
    // 改一段文字的样式：选中的几段拆出来带上新属性
    spliceRun(at.match.run, at.match.start, at.match.end, [], (piece) => ({ ...piece, ...clone(properties) }))
    return
  }
  if (at.kind === 'cell') throw new OpError('BAD_ARGUMENT', '单元格不能直接改属性，请定位到单元格里的元素')
  for (const l of at.locs) {
    const el = elAt(l)
    // 控件改的是 control 上的属性（同 executeSetControlPropertiesList），其他元素改元素本身（同 executeUpdateElementById）
    if (el.type === 'control' && el.control) el.control = { ...el.control, ...clone(properties), value: el.control.value }
    else l.list[l.index] = { ...el, ...clone(properties), type: el.type, value: el.value }
  }
}

function remove(doc: Doc, target: Target): void {
  const at = locate(doc, target)
  if (at.kind === 'text') return spliceRun(at.match.run, at.match.start, at.match.end, [])
  if (at.kind === 'cell') {
    at.list.splice(0, at.list.length)
    return
  }
  for (const l of byIndexDesc(at.locs)) l.list.splice(l.index, 1)
}

function setText(doc: Doc, target: Target, text: string, ctx: OpContext): void {
  const at = locate(doc, target)
  if (at.kind === 'text') {
    replaceParagraph(at.match, text)
    return
  }
  const style = (list: El[]): El => {
    const first = list.find((e) => typeof e.value === 'string' && (e.type === undefined || e.type === 'text'))
    const s: El = first ? { ...clone(first), value: text } : { value: text }
    return s
  }
  if (at.kind === 'cell') {
    at.list.splice(0, at.list.length, style(at.list))
    return
  }
  for (const l of at.locs) {
    const el = elAt(l)
    if (el.type === 'control') {
      const key = el.control!.conceptId!
      setFieldValues({ main: [el] }, { [key]: text }, ctx.fields)
    } else if (Array.isArray(el.valueList)) el.valueList = [style(el.valueList)]
    else throw new OpError('BAD_ARGUMENT', `${el.type ?? '文字'} 元素不能 setText，请用 text 定位改整段`)
  }
}

const SEAL_IMAGE = /^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml);base64,/
const sealLocs = (doc: Doc, id: string) => [...walkDoc(doc)].filter((l) => elAt(l).type === 'image' && elAt(l).id === id)

function placeSeal(doc: Doc, s: SealPlacement): string {
  if (!s.id) throw new OpError('BAD_ARGUMENT', '印章要有 id（客户端生成，用来去重）')
  if (!Number.isInteger(s.pageNo) || s.pageNo < 0) throw new OpError('BAD_ARGUMENT', 'pageNo 要是从 0 开始的整数')
  if (![s.x, s.y].every(Number.isFinite)) throw new OpError('BAD_ARGUMENT', 'x、y 要是数字（页内坐标，px）')
  if (![s.width, s.height].every((v) => Number.isFinite(v) && v > 0)) throw new OpError('BAD_ARGUMENT', 'width、height 要是正数')
  if (!SEAL_IMAGE.test(s.dataURL)) throw new OpError('BAD_ARGUMENT', 'dataURL 要是图片的 base64 dataURL')
  // 同一个 id 已经放过就不再放（双击、重试只生效一次）
  if (sealLocs(doc, s.id).length) return s.id
  doc.main.push({
    id: s.id,
    type: 'image',
    value: s.dataURL,
    width: s.width,
    height: s.height,
    imgDisplay: 'float-top',
    imgFloatPosition: { x: s.x, y: s.y, pageNo: s.pageNo },
    ...(s.sealId ? { extension: { seal: { sealId: s.sealId, name: s.name ?? '' } } } : {}),
  })
  return s.id
}

function moveSeal(doc: Doc, id: string, pageNo: number, x: number, y: number): void {
  const [l] = sealLocs(doc, id)
  if (!l) throw new OpError('TARGET_NOT_FOUND', `找不到印章 ${id}`)
  if (!Number.isInteger(pageNo) || pageNo < 0 || ![x, y].every(Number.isFinite)) throw new OpError('BAD_ARGUMENT', '页码和坐标不合法')
  elAt(l).imgFloatPosition = { x, y, pageNo }
}

function removeSeal(doc: Doc, id: string): void {
  const locs = sealLocs(doc, id)
  if (!locs.length) throw new OpError('TARGET_NOT_FOUND', `找不到印章 ${id}`)
  for (const l of byIndexDesc(locs)) l.list.splice(l.index, 1)
}

const newIds = (elements: El[]) => elements.map((e) => e.id ?? e.controlId).filter((v): v is string => !!v)

function run(doc: Doc, op: Op, ctx: OpContext, created: string[]): void {
  switch (op.op) {
    case 'insert':
      insert(doc, op.target, op.elements as unknown as El[], op.position ?? 'after')
      created.push(...newIds(op.elements as unknown as El[]))
      return
    case 'replace':
      replace(doc, op.target, op.with as unknown as El[])
      created.push(...newIds(op.with as unknown as El[]))
      return
    case 'update':
      return update(doc, op.target, op.properties)
    case 'remove':
      return remove(doc, op.target)
    case 'setText':
      return setText(doc, op.target, op.text, ctx)
    case 'setData':
      setFieldValues(doc, op.values, ctx.fields)
      return
    case 'placeSeal':
      created.push(placeSeal(doc, op.seal))
      return
    case 'moveSeal':
      return moveSeal(doc, op.id, op.pageNo, op.x, op.y)
    case 'removeSeal':
      return removeSeal(doc, op.id)
    default:
      throw new OpError('BAD_ARGUMENT', `不认识的操作 ${(op as { op: string }).op}`)
  }
}

/** 一批操作原子执行：在副本上逐条执行，任一失败返回它的序号（从 0 计），传入的 data 不变 */
export function applyBatch(data: DocData, ops: Op[], ctx: OpContext): BatchResult {
  const doc = clone(data) as unknown as Doc
  const created: string[] = []
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!
    try {
      run(doc, op, ctx, created)
    } catch (e) {
      if (!(e instanceof OpError)) throw e
      return { ok: false, index: i, code: e.code, error: `第 ${i + 1} 条（${op.op}）：${e.message}` }
    }
  }
  return { ok: true, data: doc as unknown as DocData, created }
}
