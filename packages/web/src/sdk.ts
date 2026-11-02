import { createApp, h, ref } from 'vue'
import type { FieldValue, Mode } from '@oe/core'
import ContractEditor from './ContractEditor.vue'
import { createSearch } from './datasource'
import type { EditorOptions, SavePayload } from './types'
import './style.css'

type Instance = InstanceType<typeof ContractEditor>

export interface EditorHandle {
  setMode(mode: Mode): Promise<void>
  getData(): SavePayload
  /** 写字段值；表格循环传记录数组，图片传 dataURL。值不合法时抛错，这一批都不生效 */
  setData(values: Record<string, FieldValue>): void
  /** missing：必填没填的字段；invalid：数字、金额不是数字的字段 */
  validate(): { ok: boolean; missing: string[]; invalid: string[] }
  save(): Promise<void>
  destroy(): void
  /** 底层 canvas-editor 实例，给高级用法 */
  readonly editor: Instance['editor']
}

/** 宿主接入入口：加载文档后把编辑器挂到 el 上 */
export async function createEditor(el: HTMLElement, options: EditorOptions): Promise<EditorHandle> {
  const loaded = await options.load()
  const inst = ref<Instance>()
  const app = createApp({
    render: () =>
      h(ContractEditor, {
        ref: inst,
        mode: options.mode,
        modes: options.modes,
        title: loaded.title,
        doc: loaded.doc,
        values: loaded.values,
        fields: loaded.fields,
        libraryFields: loaded.libraryFields,
        permissions: loaded.permissions,
        actions: loaded.actions,
        seals: options.seals,
        search: createSearch(options),
        save: options.save,
        publish: options.publish,
        previewSamples: options.previewSamples,
        download: options.download,
        onSeal: options.onSeal,
        importDocx: options.importDocx,
      }),
  })
  app.mount(el)
  const c = () => inst.value!
  return {
    setMode: (m) => c().setMode(m),
    getData: () => c().getData(),
    setData: (v) => c().setValues(v),
    validate: () => c().validate(),
    save: () => c().save(),
    destroy: () => app.unmount(),
    get editor() {
      return c().editor
    },
  }
}
