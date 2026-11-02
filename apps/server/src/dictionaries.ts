import type { DocData, FieldDef, FieldOption } from '@oe/core'
import { HttpError } from './errors'

/** 宿主创建合同时提供字典快照；不修改已发布模板和既有合同。 */
export function withDictionaries(source: DocData, definitions: FieldDef[], dictionaries: Record<string, FieldOption[]>) {
  const doc = structuredClone(source)
  const fields = structuredClone(definitions)
  for (const id of Object.keys(dictionaries)) {
    if (!fields.some((f) => f.dataSource?.kind === 'dict' && f.dataSource.id === id && ['select', 'radio', 'checkbox'].includes(f.type))) {
      throw new HttpError(400, 'UNKNOWN_DICTIONARY', `模板没有使用字典 ${id}`)
    }
  }
  const options = new Map<string, FieldOption[]>()
  for (const f of fields) {
    if (f.dataSource?.kind !== 'dict' || !['select', 'radio', 'checkbox'].includes(f.type)) continue
    const list = dictionaries[f.dataSource.id]
    if (!list) continue
    f.options = list
    options.set(f.key, list)
  }
  function visit(list: DocData['main']) {
    for (const el of list) {
      const values = el.control?.conceptId ? options.get(el.control.conceptId) : undefined
      if (values) el.control!.valueSets = structuredClone(values)
      if (el.valueList) visit(el.valueList)
      for (const tr of el.trList ?? []) for (const td of tr.tdList) visit(td.value)
    }
  }
  visit(doc.main); visit(doc.header ?? []); visit(doc.footer ?? [])
  return { doc, fields }
}
