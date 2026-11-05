// iframe 嵌入的消息协议（docs/设计/07 第 4 节、docs/接入指南.md）。父页面（宿主）和嵌入页之间只走 postMessage。
// 这个文件不依赖 Vue，父页面的客户端（client.ts）也用它。
import type { DataSourceDef, LoadedDocument, PreviewSample, SealOption } from '../types'
import type { Mode } from '@oe/core'

export const PROTOCOL = 'oe-embed/1'

/** 宿主函数：在父页面实现，嵌入页要用时发 request 过去调（带父页面自己的登录态） */
export const HOST_FUNCTIONS = ['save', 'publish', 'search', 'request', 'download', 'importDocx', 'onSeal'] as const
/** 签署接口（types.ts 的 SigningApi，t12）的方法：父页面实现 host.signing，嵌入页按 signing.state 这样的名字调 */
export const SIGNING_FUNCTIONS = ['state', 'confirmIntent', 'sign', 'reject', 'report', 'download', 'verify'] as const
export type SigningFunctionName = (typeof SIGNING_FUNCTIONS)[number]
export type HostFunctionName = (typeof HOST_FUNCTIONS)[number] | `signing.${SigningFunctionName}`

/** 父页面能调的编辑器方法（EditorHandle 上的，白名单外的不执行） */
export const EDITOR_METHODS = [
  'getData', 'setData', 'setMode', 'validate', 'save', 'isDirty', 'apply', 'find', 'insertText', 'insertField', 'getText',
  'export', 'download', 'import', 'print', 'focus',
] as const
export type EditorMethodName = (typeof EDITOR_METHODS)[number]

/** 父页面交给嵌入页的初始化内容：都是能复制的数据，函数换成「父页面实现了哪几个宿主函数」 */
export interface EmbedInit {
  mode: Mode
  modes?: Mode[]
  document: LoadedDocument
  seals?: SealOption[]
  previewSamples?: PreviewSample[]
  dataSources?: Record<string, DataSourceDef>
  confirmLeave?: boolean
  hostFunctions: HostFunctionName[]
}

export type HostMessage =
  | { protocol: typeof PROTOCOL; type: 'init'; init: EmbedInit }
  | { protocol: typeof PROTOCOL; type: 'call'; id: number; method: EditorMethodName; args: unknown[] }
  | { protocol: typeof PROTOCOL; type: 'reply'; id: number; ok: boolean; result?: unknown; error?: string }

export type FrameMessage =
  | { protocol: typeof PROTOCOL; type: 'ready' }
  | { protocol: typeof PROTOCOL; type: 'mounted' }
  | { protocol: typeof PROTOCOL; type: 'event'; name: string; payload?: unknown }
  | { protocol: typeof PROTOCOL; type: 'request'; id: number; method: HostFunctionName; args: unknown[] }
  | { protocol: typeof PROTOCOL; type: 'reply'; id: number; ok: boolean; result?: unknown; error?: string }

/** 发消息时不用自己写 protocol（逐个成员去掉，联合类型照样分得清） */
type Body<T> = T extends unknown ? Omit<T, 'protocol'> : never
export type HostMessageBody = Body<HostMessage>
export type FrameMessageBody = Body<FrameMessage>

export const isMessage = (data: unknown): data is { protocol: string; type: string } =>
  !!data && typeof data === 'object' && (data as { protocol?: unknown }).protocol === PROTOCOL && typeof (data as { type?: unknown }).type === 'string'

/** 能用 postMessage 传的值：文件、Blob 原样传，其他（可能是 Vue 的响应式对象）先转成普通数据 */
export const transferable = (v: unknown): unknown => (v instanceof Blob || v === undefined ? v : JSON.parse(JSON.stringify(v)))
