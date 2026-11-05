import type { IElement } from '@hufe921/canvas-editor'

// 并行实现者之间的接口约定（s1 定）。已有的名字和结构不改；需要改的写进检查点「接口变更请求」。

/** canvas-editor 的文档 JSON，即 editor.command.getValue().data，外加文档自己的纸张设置 */
export interface DocData {
  header?: IElement[]
  main: IElement[]
  footer?: IElement[]
  /** 纸张和页码（s3 加的；docx 导入时按第一节设置）。不填用 A4 竖放、默认页边距和页码 */
  page?: PageSetup
  /** 修订开着（t10 加的）：谁在编辑模式里改正文都记下插入、删除，直到有人关掉。修订本身在元素的 trace 上（见 trace.ts） */
  trackChanges?: boolean
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
  /** 签名区（t11 加的）：签署时手写的签名图片，绑定签署方（signer）；没签时是占位图 */
  | 'signature'
  /** 签署日期（t11 加的）：签署时由服务端按服务器时间写，绑定签署方 */
  | 'signDate'
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
  /**
   * 计算字段：金额大写（from 那个字段转大写），或者公式（t11 加的，见 formula.ts）：字段之间四则运算、
   * 循环表某一列的合计 sum(循环字段.列)；digits 是保留几位小数，不填 2（末尾的 0 去掉）
   */
  computed?: { fn: 'amountCN'; from: string } | { fn: 'formula'; expr: string; digits?: number }
  /**
   * 表格循环：每行记录里的属性名（循环行里控件的 conceptId），labels 是表头文字（s6 加的，不填用属性名）；
   * formulas 是行内计算的列（t11 加的）：列名 → 同一行别的列的公式，如 { amount: 'qty * price' }
   */
  loop?: { columns: string[]; labels?: string[]; formulas?: Record<string, string> }
  /** 签名区、签署日期绑定的签署方（角色 key，见 fields.ts 的 SIGNER_ROLES）；签署时按它找签署人 */
  signer?: string
  /** 校验规则（t11 加的，见 rules.ts）：值是空的不查（必填另算）；填写保存、提交时编辑器和服务端都按它查 */
  rules?: FieldRules
}

/** 字段的校验规则 */
export interface FieldRules {
  /** 字数（按字符数，emoji 算一个） */
  minLength?: number
  maxLength?: number
  /** 常用格式：中国大陆手机号、18 位身份证号（含校验位）、统一社会信用代码（含校验位）、邮箱 */
  pattern?: 'mobile' | 'idCard' | 'creditCode' | 'email'
  /** 数值范围（值要是数字） */
  min?: number
  max?: number
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

/**
 * 条件条款（t11 加的）：区域的 area.extension.when。字段的值是 in 里的某一个时才出这段（复选的值有一个在里面就算），
 * 否则隐藏（area.hide），编辑器、PDF、Word、HTML、纯文本都不出。见 conditions.ts
 */
export interface Condition {
  field: string
  in: string[]
}

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
      // BAD_ARGUMENT 是 s2 加的：值的类型不对（例如文本字段传了对象）；INVALID_VALUE 是 t11 加的：不合字段的校验规则
      code: 'PERMISSION_DENIED' | 'FIELD_NOT_FOUND' | 'VALUE_NOT_IN_OPTIONS' | 'BAD_ARGUMENT' | 'INVALID_VALUE'
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
