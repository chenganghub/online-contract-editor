// 字段写值：同一个字段（conceptId）在文档里出现几处就写几处，计算字段跟着算；表格循环按数组生成行。
import { toChineseAmount } from './amount'
import { OpError } from './errors'
import { clone, controlLocs, elAt, walk, walkDoc, type Ctrl, type Doc, type El, type Tr } from './model'
import { CONTEXT_ATTRS, CONTROL_STYLE_ATTRS, pick } from './text'
import type { FieldDef, FieldValue } from './types'

/** 控件的值元素：和编辑器展开控件时一样，带 type: 'text'、控件自己的文字样式、控件所在段落的属性 */
export function controlValue(el: El, text: string | null | undefined): El[] {
  if (text === null || text === undefined || text === '') return []
  return [{ value: String(text), type: 'text', ...clone(pick(el.control, CONTROL_STYLE_ATTRS)), ...clone(pick(el, CONTEXT_ATTRS)) }]
}

const optionOf = (c: Ctrl, raw: string, key: string) => {
  const sets = c.valueSets ?? []
  const hit = sets.find((s) => s.code === raw) ?? sets.find((s) => s.value === raw)
  if (!hit) {
    const all = sets.map((s) => `${s.value}/${s.code}`).join('、')
    throw new OpError('VALUE_NOT_IN_OPTIONS', `字段 ${key} 没有选项「${raw}」，可选：${all}`)
  }
  return hit
}

/** 返回一个改写函数；先全部校验再统一执行，所以单个字段出错时文档不会改一半 */
function planControl(el: El, key: string, raw: FieldValue): () => void {
  const c = el.control!
  if (raw === null || raw === '') {
    return () => {
      c.value = []
      if ('code' in c || c.type === 'select' || c.type === 'radio' || c.type === 'checkbox') c.code = null
    }
  }
  switch (c.type) {
    case 'select': {
      const hit = optionOf(c, String(raw), key)
      return () => {
        c.code = hit.code
        c.value = controlValue(el, hit.value)
      }
    }
    // 单选、复选控件按 code 画勾，值元素为空（编辑器的做法，未和浏览器逐项比对）
    case 'radio': {
      const hit = optionOf(c, String(raw), key)
      return () => {
        c.code = hit.code
        c.value = []
      }
    }
    case 'checkbox': {
      const list = Array.isArray(raw) ? raw.map(String) : String(raw).split(',')
      const codes = list.map((v) => optionOf(c, v, key).code)
      return () => {
        c.code = codes.join(',')
        c.value = []
      }
    }
    default: {
      if (typeof raw === 'object') throw new OpError('BAD_ARGUMENT', `字段 ${key} 的值要是文字或数字`)
      return () => {
        c.value = controlValue(el, String(raw))
      }
    }
  }
}

/** 表格循环：循环行用 tr.extension.loop = 字段 key 标记，按数组生成行；数组为空时保留一行空模板 */
function planLoop(doc: Doc, key: string, rows: Record<string, unknown>[]): (() => void)[] {
  const plans: (() => void)[] = []
  let found = false
  for (const loc of walkDoc(doc)) {
    const table = elAt(loc)
    if (table.type !== 'table' || !table.trList) continue
    const at = table.trList.findIndex((tr) => tr.extension?.loop === key)
    if (at < 0) continue
    found = true
    const trList = table.trList
    const template = clone(trList[at]!)
    const count = trList.filter((tr) => tr.extension?.loop === key).length
    const make = (row: Record<string, unknown> | null, i: number): Tr => {
      const tr = clone(template)
      tr.extension = { ...tr.extension, loop: key, index: i }
      // 复制出来的行不能沿用模板行里的实例 id（同一个 controlId 出现在多行，编辑器会把它们当成同一个控件），去掉后编辑器装文档时重新生成
      for (const td of tr.tdList)
        for (const loc of walk(td.value)) {
          const el = elAt(loc) as El & { controlId?: string; id?: string }
          delete el.controlId
          delete el.id
        }
      for (const td of tr.tdList)
        for (const cl of controlLocs({ main: td.value })) {
          const el = elAt(cl)
          const col = el.control!.conceptId!
          const v = row?.[col]
          el.control!.value = controlValue(el, v === undefined || v === null ? null : String(v))
        }
      return tr
    }
    plans.push(() => {
      const fresh = rows.length ? rows.map((r, i) => make(r, i)) : [make(null, 0)]
      trList.splice(at, count, ...fresh)
    })
  }
  if (!found) throw new OpError('FIELD_NOT_FOUND', `文档里没有绑定 ${key} 的循环表格`)
  return plans
}

/** 图片字段：图片元素用 extension.field = 字段 key 标记，值是图片的 dataURL */
function planImage(doc: Doc, key: string, raw: FieldValue): (() => void)[] {
  const targets = [...walkDoc(doc)].map(elAt).filter((el) => el.type === 'image' && el.extension?.field === key)
  if (!targets.length) throw new OpError('FIELD_NOT_FOUND', `文档里没有绑定 ${key} 的图片`)
  if (typeof raw !== 'string' || !raw.startsWith('data:image/')) throw new OpError('BAD_ARGUMENT', `字段 ${key} 的值要是图片 dataURL`)
  return targets.map((el) => () => {
    el.value = raw
  })
}

/** 把一组字段值写进文档。fields 里有定义的按类型写；计算字段按来源字段重新算 */
export function setFieldValues(doc: Doc, values: Record<string, FieldValue>, fields: FieldDef[]): Record<string, FieldValue> {
  const defs = new Map(fields.map((f) => [f.key, f]))
  const all: Record<string, FieldValue> = { ...values }
  for (const f of fields) {
    const from = f.computed?.from
    if (f.computed?.fn === 'amountCN' && from && from in values) {
      const v = values[from]
      all[f.key] = v === null || v === '' ? null : toChineseAmount(String(v))
    }
  }
  const controls = controlLocs(doc)
  const plans: (() => void)[] = []
  for (const [key, raw] of Object.entries(all)) {
    try {
      const def = defs.get(key)
      if (def?.type === 'loop') {
        if (raw !== null && !Array.isArray(raw)) throw new OpError('BAD_ARGUMENT', `字段 ${key} 的值要是数组`)
        plans.push(...planLoop(doc, key, (raw ?? []) as Record<string, unknown>[]))
        continue
      }
      if (def?.type === 'image') {
        plans.push(...planImage(doc, key, raw))
        continue
      }
      const targets = controls.filter((l) => elAt(l).control!.conceptId === key)
      if (!targets.length) {
        // 计算字段在文档里可以不出现
        if (def?.computed && !(key in values)) continue
        throw new OpError('FIELD_NOT_FOUND', `文档里没有字段 ${key}`)
      }
      for (const l of targets) plans.push(planControl(elAt(l), key, raw))
    } catch (e) {
      if (e instanceof OpError) e.field ??= key
      throw e
    }
  }
  for (const run of plans) run()
  return all
}
