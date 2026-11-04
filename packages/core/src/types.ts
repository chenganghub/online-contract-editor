import type { IElement } from '@hufe921/canvas-editor'

// 并行实现者之间的接口约定（s1 定）。已有的名字和结构不改；需要改的写进检查点「接口变更请求」。

/** canvas-editor 的文档 JSON，即 editor.command.getValue().data，外加文档自己的纸张设置 */
export interface DocData {
  header?: IElement[]
  main: IElement[]
  footer?: IElement[]
  /** 纸张和页码（s3 加的；docx 导入时按第一节设置）。不填用 A4 竖放、默认页边距和页码 */
  page?: PageSetup
}

/** 纸张设置，单位是编辑器像素（96 dpi）。横放时编辑器自己交换宽高、把页边距转 90°，所以这里都按竖放写 */
export interface PageSetup {
  width: number
  height: number
  paperDirection?: 'vertical' | 'horizontal'
  /** 竖放时的上、右、下、左 */
  margins?: [number, number, number, number]
  pageNumber?: { format?: string; rowFlex?: 'left' | 'center' | 'right'; disabled?: boolean }
  /** 水印（07 加的）：草稿、机密、副本这类，编辑器、PDF、Word 都画；不填就没有 */
  watermark?: { data: string; color?: string; opacity?: number; size?: number }
}

export type FieldType =
  | 'text'
  | 'number'
  | 'amount'
  | 'date'
  | 'select'
  | 'radio'
  | 'checkbox'
  | 'picker'
  | 'computed'
  | 'image'
  | 'loop'
export type Permission = 'editable' | 'readonly' | 'required' | 'hidden'
export type Mode = 'edit' | 'fill' | 'seal' | 'view'
export type DocStatus = 'filling' | 'sealing' | 'sealed' | 'void'

export interface FieldOption {
  value: string
  code: string
}
export interface DataSourceRef {
  id: string
  kind: 'static' | 'dict' | 'remote' | 'host'
}

/** 字段定义：模板版本的一部分。控件的 conceptId = key */
export interface FieldDef {
  key: string
  label: string
  type: FieldType
  /** 模板默认权限，缺省 editable */
  permission?: Permission
  /** select / radio / checkbox 的固定选项 */
  options?: FieldOption[]
  /** picker 和选项类字段的数据源 */
  dataSource?: DataSourceRef
  /** picker 选中后：字段 key → 记录的属性名 */
  fill?: Record<string, string>
  /** 日期、金额的显示格式 */
  format?: string
  /** 计算字段 */
  computed?: { from: string; fn: 'amountCN' }
  /** 表格循环：每行记录里的属性名（循环行里控件的 conceptId），labels 是表头文字（s6 加的，不填用属性名） */
  loop?: { columns: string[]; labels?: string[] }
}

export type FieldValue = string | number | boolean | string[] | null | Record<string, unknown>[]

export interface Snapshot {
  sourceId: string
  text: string
  fields: Record<string, unknown>
  at: string
}

/** 数据 JSON：字段值的唯一来源 */
export interface DocValues {
  values: Record<string, FieldValue>
  snapshots?: Record<string, Snapshot>
}

/** 定位 */
export type Target =
  | { id: string }
  | { field: string; occurrence?: number }
  | { anchor: string }
  | { text: string; occurrence?: number }
  | { table: { id: string; row: number; col: number } }

/** 可编辑区里一段文字能带的样式（取值范围见 fill.ts 的 areaStyle）。字号、段前段后是 px，行距 rowMargin 是倍数 */
export interface AreaStyle {
  font?: string
  size?: number
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strikeout?: boolean
  color?: string
  highlight?: string
  rowFlex?: 'left' | 'center' | 'right' | 'alignment' | 'justify'
  rowMargin?: number
  spacingBefore?: number
  spacingAfter?: number
}

/** 可编辑区里的一段文字（填写模式保存时提交，见 applyAreas） */
export interface AreaRun extends AreaStyle {
  value: string
  type?: 'text' | 'subscript' | 'superscript'
}

export interface SealPlacement {
  id: string
  dataURL: string
  pageNo: number
  x: number
  y: number
  width: number
  height: number
  /** 宿主的印章 id 和名称（s9 加的）：写进元素的 extension.seal，和前端放的章一样 */
  sealId?: string
  name?: string
}

/** 操作；一批原子执行 */
export type Op =
  | { op: 'insert'; target: Target; position?: 'before' | 'after'; elements: IElement[] }
  | { op: 'replace'; target: Target; with: IElement[] }
  | { op: 'update'; target: Target; properties: Record<string, unknown> }
  | { op: 'remove'; target: Target }
  | { op: 'setText'; target: Target; text: string }
  | { op: 'setData'; values: Record<string, FieldValue> }
  | { op: 'placeSeal'; seal: SealPlacement }
  | { op: 'moveSeal'; id: string; pageNo: number; x: number; y: number }
  | { op: 'removeSeal'; id: string }

export interface OpContext {
  fields: FieldDef[]
}

export type OpErrorCode =
  | 'TARGET_NOT_FOUND'
  | 'OCCURRENCE_OUT_OF_RANGE'
  | 'FIELD_NOT_FOUND'
  | 'VALUE_NOT_IN_OPTIONS'
  | 'PARAGRAPH_HAS_ELEMENTS'
  | 'BAD_ARGUMENT'
  | 'PERMISSION_DENIED'

export type BatchResult =
  | { ok: true; data: DocData; created: string[] }
  | { ok: false; index: number; code: OpErrorCode; error: string }

export type FillResult =
  | { ok: true; data: DocData; values: DocValues }
  | {
      ok: false
      // BAD_ARGUMENT 是 s2 加的：值的类型不对（例如文本字段传了对象）
      code: 'PERMISSION_DENIED' | 'FIELD_NOT_FOUND' | 'VALUE_NOT_IN_OPTIONS' | 'BAD_ARGUMENT'
      field: string
      error: string
    }

export interface SealRecord {
  id: string
  documentId: string
  sealId: string
  sealName: string
  imageHash: string
  pageNo: number
  x: number
  y: number
  width: number
  height: number
  operator: string
  at: string
  status: 'valid' | 'void'
}
