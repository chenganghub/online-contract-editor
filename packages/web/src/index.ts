export { createEditor, type EditorHandle } from './sdk'
export { default as ContractEditor } from './ContractEditor.vue'
export type * from './types'
// 宿主接入时要用到的 core 类型，从这里转出，宿主不必再直接依赖 @oe/core
export type { AreaRun, DocData, DocValues, FieldDef, FieldValue, Mode, Permission } from '@oe/core'
