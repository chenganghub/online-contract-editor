// 条件条款（docs/设计/08 第 4 节，t11）：区域上写 extension.when = { field, in }，字段的值对上才出这段，对不上就隐藏（area.hide）。
// 服务端每次写值、保存都按现在的值重算 hide（applyFill、PUT、批量操作），存下的文档里 hide 就是对的：
// 渲染服务出 PDF（打印模式不画隐藏的区域）、Word（拆区域时跳过隐藏的）都按它；HTML、纯文本导出前去掉隐藏的区域（withoutHiddenAreas）
import { clone, elAt, walkDoc, type Doc, type El } from './model'
import type { Condition, DocData, FieldValue } from './types'

/** 区域上的条件；不是条件条款的是 undefined */
export function conditionOf(el: { type?: string; area?: unknown }): Condition | undefined {
  const when = (el.area as { extension?: { when?: unknown } } | undefined)?.extension?.when as Condition | undefined
  return el.type === 'area' && when && typeof when.field === 'string' && Array.isArray(when.in) ? when : undefined
}

/** 条件满足没有：值是空的不满足；复选（逗号连起来的 code 或数组）有一个在 in 里就算；文字按整串比 */
export function conditionMet(when: Condition, values: Record<string, FieldValue>): boolean {
  const v = values[when.field]
  if (v === null || v === undefined || v === '') return false
  const list = Array.isArray(v) ? v.map(String) : [String(v), ...String(v).split(',')]
  return list.some((c) => when.in.includes(c))
}

/** 按字段值设好每个条件条款的 hide，返回新文档（不改传进来的）；没有条件条款时原样返回 */
export function applyConditions(data: DocData, values: Record<string, FieldValue>): DocData {
  const locs = [...walkDoc(data as unknown as Doc)].filter((l) => conditionOf(elAt(l)))
  if (!locs.length) return data
  const doc = clone(data) as unknown as Doc
  for (const l of walkDoc(doc)) {
    const el = elAt(l)
    const when = conditionOf(el)
    if (when) el.area = { ...el.area, hide: !conditionMet(when, values) }
  }
  return doc as unknown as DocData
}

/** 条件条款依赖的字段（这些字段改了要重算显示不显示） */
export const conditionFields = (data: DocData): Set<string> =>
  new Set([...walkDoc(data as unknown as Doc)].map((l) => conditionOf(elAt(l))?.field).filter((k): k is string => !!k))

/** 去掉隐藏的区域（HTML、纯文本导出用：canvas-editor 的 getHTML、getText 不管区域隐没隐藏）；没有时原样返回 */
export function withoutHiddenAreas(data: DocData): DocData {
  const hidden = (el: El) => el.type === 'area' && !!el.area?.hide
  if (![...walkDoc(data as unknown as Doc)].some((l) => hidden(elAt(l)))) return data
  const doc = clone(data) as unknown as Doc
  const prune = (list: El[]) => {
    const kept = list.filter((el) => !el || typeof el !== 'object' || !hidden(el))
    list.splice(0, list.length, ...kept)
    for (const el of kept) {
      if (!el || typeof el !== 'object') continue
      if (Array.isArray(el.valueList)) prune(el.valueList)
      if (el.type === 'table') for (const tr of el.trList ?? []) for (const td of tr.tdList ?? []) if (Array.isArray(td.value)) prune(td.value)
    }
  }
  for (const zone of ['header', 'main', 'footer'] as const) if (Array.isArray(doc[zone])) prune(doc[zone]!)
  return doc as unknown as DocData
}
