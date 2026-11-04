export { createEditor, type EditorHandle, type EditorEventName, type EditorListener } from './sdk'
export { default as ContractEditor } from './ContractEditor.vue'
// iframe 嵌入：嵌入页里用 mountEmbedded；父页面用 connectEmbed（单独入口 @oe/web/embed 不带 Vue，见 package.json exports）
export { mountEmbedded, type EmbedFrameOptions } from './embed/frame'
export { connectEmbed, type ConnectOptions, type EmbedHandle, type EmbedHostFunctions } from './embed/client'
export type * from './types'
// 宿主接入时要用到的 core 类型，从这里转出，宿主不必再直接依赖 @oe/core
export type { AreaRun, DocData, DocValues, FieldDef, FieldValue, Mode, Permission } from '@oe/core'
