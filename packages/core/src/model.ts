// 文档 JSON 的内部视图。对外用 canvas-editor 的 IElement（types.ts），这里用结构化的宽松类型：
// IElement 的 type 是运行时枚举，core 不依赖 canvas-editor 的运行时代码，只按字符串比较。
// 文档 JSON 是 getValue().data 的「压缩格式」：相邻且样式相同的文字合并成一个元素；段落之间是 '\n'；
// 标题、列表、区域用 valueList；表格是 trList / tdList / value；控件的值是 control.value 元素数组（空控件是 []）。

export interface El {
  value: string
  type?: string
  id?: string
  controlId?: string
  areaId?: string
  control?: Ctrl
  area?: { hide?: boolean; extension?: { anchor?: string } & Record<string, unknown> } & Record<string, unknown>
  valueList?: El[]
  trList?: Tr[]
  imgDisplay?: string
  imgFloatPosition?: { x: number; y: number; pageNo: number }
  extension?: Record<string, unknown>
  [k: string]: unknown
}

export interface Ctrl {
  type?: string
  conceptId?: string
  value?: El[] | null
  code?: string | null
  valueSets?: { value: string; code: string }[]
  [k: string]: unknown
}

export interface Tr {
  tdList: Td[]
  extension?: Record<string, unknown>
  pagingRepeat?: boolean
  [k: string]: unknown
}

export interface Td {
  value: El[]
  [k: string]: unknown
}

export interface Doc {
  header?: El[]
  main: El[]
  footer?: El[]
}

export const ZONES = ['header', 'main', 'footer'] as const

export const clone = <T>(v: T): T => structuredClone(v)

/** 元素所在的位置：哪个数组的第几个 */
export interface Loc {
  list: El[]
  index: number
}

/** 按文档顺序遍历所有元素（含标题 / 列表 / 区域的 valueList、表格单元格），不进控件的值 */
export function* walk(list: El[]): Generator<Loc> {
  for (let index = 0; index < list.length; index++) {
    const el = list[index]
    // 文档 JSON 来自外部、没有逐项校验：不是对象的项跳过，不报错
    if (!el || typeof el !== 'object') continue
    yield { list, index }
    if (Array.isArray(el.valueList)) yield* walk(el.valueList)
    if (el.type === 'table' && Array.isArray(el.trList))
      for (const tr of el.trList)
        if (tr && Array.isArray(tr.tdList)) for (const td of tr.tdList) if (td && Array.isArray(td.value)) yield* walk(td.value)
  }
}

export function* walkDoc(doc: Doc): Generator<Loc> {
  for (const zone of ZONES) {
    const list = doc[zone]
    if (Array.isArray(list)) yield* walk(list)
  }
}

export const controlLocs = (doc: Doc): Loc[] => [...walkDoc(doc)].filter(({ list, index }) => list[index]!.type === 'control' && list[index]!.control)

export const elAt = (loc: Loc): El => loc.list[loc.index]!
