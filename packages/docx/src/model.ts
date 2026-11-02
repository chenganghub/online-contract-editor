// 编辑器文档 JSON 的宽松视图（和 @oe/core 一样按字符串比类型，不依赖 canvas-editor 的运行时代码）
import type { PageSetup } from '@oe/core'

export interface El {
  value: string
  type?: string
  control?: { value?: El[] | null; prefix?: string; postfix?: string; [k: string]: unknown }
  valueList?: El[]
  trList?: { tdList: { value: El[]; [k: string]: unknown }[]; pagingRepeat?: boolean; [k: string]: unknown }[]
  borderType?: string
  /** 区域（可编辑区等） */
  area?: { hide?: boolean; [k: string]: unknown }
  [k: string]: unknown
}
export interface Doc {
  header?: El[]
  main: El[]
  footer?: El[]
  page?: PageSetup
}

/** 按文档顺序（先序）遍历元素，进标题 / 列表 / 区域的 valueList、表格单元格、控件的值 */
export function* walk(list: El[] | undefined): Generator<El> {
  for (const el of list ?? []) {
    yield el
    if (el.valueList) yield* walk(el.valueList)
    if (el.type === 'control' && Array.isArray(el.control?.value)) yield* walk(el.control.value)
    if (el.type === 'table') for (const tr of el.trList ?? []) for (const td of tr.tdList ?? []) yield* walk(td.value)
  }
}

export const tablesOf = (list: El[] | undefined) => [...walk(list)].filter((e) => e.type === 'table')

export const TEXT_TYPES = new Set([undefined, 'text', 'subscript', 'superscript'])

/** 编辑器里能读到的文字（不含图片、公式），表格按行列顺序 */
export function textOf(list: El[] | undefined): string {
  let s = ''
  for (const el of walk(list)) if (TEXT_TYPES.has(el.type) && typeof el.value === 'string') s += el.value
  return s
}

export const squeeze = (s: string) => s.replace(/[\s\u200B]/g, '')
