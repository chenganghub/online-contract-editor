import { createApp, h, ref } from 'vue'
import type { BatchResult, FieldValue, Mode, Op } from '@oe/core'
import ContractEditor from './ContractEditor.vue'
import { createSearch } from './datasource'
import type { EditorEvents, EditorOptions, ExportFormat, SavePayload } from './types'
import './style.css'

type Instance = InstanceType<typeof ContractEditor>
export type EditorEventName = keyof EditorEvents
export type EditorListener<K extends EditorEventName> = (payload: EditorEvents[K]) => void

/** 宿主拿到的编辑器句柄。iframe 嵌入（embed/client.ts）给的是同样的方法，只是都返回 Promise */
export interface EditorHandle {
  setMode(mode: Mode): Promise<void>
  getData(): SavePayload
  /** 写字段值；表格循环传记录数组，图片传 dataURL。值不合法时抛错，这一批都不生效 */
  setData(values: Record<string, FieldValue>): void
  /** missing：必填没填的字段；invalid：数字、金额不是数字，或者不合校验规则的字段（填写模式只查填写的人能改的） */
  validate(): { ok: boolean; missing: string[]; invalid: string[] }
  save(): Promise<void>
  /** 有没有没保存的修改（编辑、导入过，还没保存成功）；宿主切路由前可以用它提醒 */
  isDirty(): boolean
  /** 批量操作（insert、replace、update、remove、setText、setData，和服务端 /operations 同一套）：全部成功才生效；编辑模式才能用 */
  apply(ops: Op[]): BatchResult
  /** 找第 occurrence 处（从 0 起）文字并选中；没找到返回 false */
  find(text: string, occurrence?: number): boolean
  /** 在光标处插文字 */
  insertText(text: string): void
  /** 在光标处插字段（模板里的或宿主字段库里的 key） */
  insertField(key: string): void
  /** 页眉、正文、页脚的文字，含字段值 */
  getText(): string
  /** 生成文件内容（都在浏览器里生成，PDF 是图片版） */
  export(format: ExportFormat): Promise<Blob>
  /** 下载文件：PDF、Word 宿主传了 download 时走宿主，其他在浏览器里生成；按令牌的下载权限 */
  download(format: ExportFormat): Promise<void>
  /** 打开文件（编辑模式）：docx、html、md、txt、json，换掉整篇文档 */
  import(file: File): Promise<void>
  /** 打印（按令牌的打印权限） */
  print(): void
  focus(): void
  /** 订阅事件，返回取消订阅的函数 */
  on<K extends EditorEventName>(name: K, fn: EditorListener<K>): () => void
  off<K extends EditorEventName>(name: K, fn: EditorListener<K>): void
  destroy(): void
  /** 底层 canvas-editor 实例，给高级用法 */
  readonly editor: Instance['editor']
}

/** 宿主接入入口：加载文档后把编辑器挂到 el 上，编辑器装好（ready）后返回句柄 */
export async function createEditor(el: HTMLElement, options: EditorOptions): Promise<EditorHandle> {
  const loaded = await options.load()
  const inst = ref<Instance>()
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  const fire = (name: EditorEventName) => (payload?: unknown) => listeners.get(name)?.forEach((fn) => fn(payload))
  let ready!: () => void
  const mounted = new Promise<void>((resolve) => (ready = resolve))
  const app = createApp({
    render: () =>
      h(ContractEditor, {
        ref: inst,
        mode: options.mode,
        modes: options.modes,
        title: loaded.title,
        doc: loaded.doc,
        values: loaded.values,
        version: loaded.version,
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
        confirmLeave: options.confirmLeave,
        collab: options.collab,
        signing: options.signing,
        onReady: () => {
          ready()
          fire('ready')()
        },
        onChange: fire('change'),
        onFieldChange: fire('field-change'),
        onSaved: fire('saved'),
        onModeChange: fire('mode-change'),
        onDirtyChange: fire('dirty-change'),
        onFieldFocus: fire('field-focus'),
      }),
  })
  app.mount(el)
  await mounted
  const c = () => inst.value!
  const off: EditorHandle['off'] = (name, fn) => void listeners.get(name)?.delete(fn as (payload: unknown) => void)
  return {
    setMode: (m) => c().setMode(m),
    getData: () => c().getData(),
    setData: (v) => c().setValues(v),
    validate: () => c().validate(),
    save: () => c().save(),
    isDirty: () => c().isDirty(),
    apply: (ops) => c().apply(ops),
    find: (text, occurrence) => c().find(text, occurrence),
    insertText: (text) => c().insertText(text),
    insertField: (key) => c().insertField(key),
    getText: () => c().getText(),
    export: (format) => c().exportFile(format),
    download: (format) => c().download(format),
    import: (file) => c().importFile(file),
    print: () => c().print(),
    focus: () => c().focus(),
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name)!.add(fn as (payload: unknown) => void)
      return () => off(name, fn)
    },
    off,
    destroy: () => app.unmount(),
    get editor() {
      return c().editor
    },
  }
}
