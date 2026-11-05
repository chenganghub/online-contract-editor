export { createEditor, type EditorHandle, type EditorEventName, type EditorListener } from './sdk'
export { default as ContractEditor } from './ContractEditor.vue'
// iframe 嵌入：嵌入页里用 mountEmbedded；父页面用 connectEmbed（单独入口 @oe/web/embed 不带 Vue，见 package.json exports）
export { mountEmbedded, type EmbedFrameOptions } from './embed/frame'
export { connectEmbed, type ConnectOptions, type EmbedHandle, type EmbedHostFunctions } from './embed/client'
// 多人编辑：宿主接服务端事件流的现成实现
export { sseCollab, type SseCollabOptions } from './collab'
// 字段 → 文档里的元素（宿主自己拼文档时用，和编辑器插入的一样）
export { fieldElement } from './elements'
export type * from './types'
// 宿主接入时要用到的 core 类型，从这里转出，宿主不必再直接依赖 @oe/core
export type { AreaRun, DocData, DocValues, FieldDef, FieldValue, Mode, Permission } from '@oe/core'
