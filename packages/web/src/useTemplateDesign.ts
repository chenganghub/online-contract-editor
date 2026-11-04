import { reactive, ref, watch, type Ref, type ShallowRef } from 'vue'
import type Editor from '@hufe921/canvas-editor'
import type { FieldDef, Mode } from '@oe/core'

/** 模板交互只保存公共选区；定位交给画布自身处理，包含表格、缩放和分页。 */
export function useTemplateDesign(options: {
  editor: ShallowRef<Editor | undefined>
  mode: Ref<Mode>
  library: () => FieldDef[] | undefined
  canConvert: () => boolean
  insert: (field: FieldDef) => void
  anchor: () => { left: number; bottom: number } | null
}) {
  const selection = ref(false)
  const chooser = reactive({ open: false, left: 0, top: 0 })
  let range: ReturnType<Editor['command']['getRange']> | undefined
  let slash = false
  let query = ''
  const floating = reactive({ open: false, left: 0, top: 0 })
  const enabled = () => options.mode.value === 'edit' && !!options.library()
  function refresh() {
    selection.value = enabled() && options.canConvert()
    if (!selection.value && !slash) { chooser.open = false; floating.open = false }
  }
  function open(x?: number, y?: number) {
    if (!selection.value) return
    range = structuredClone(options.editor.value!.command.getRange())
    show(x, y)
  }
  function show(x?: number, y?: number) {
    const anchor = options.anchor()
    Object.assign(chooser, { open: true, left: Math.max(8, Math.min(x ?? anchor?.left ?? 240, window.innerWidth - 336)), top: Math.max(60, Math.min(y ?? anchor?.bottom ?? 110, window.innerHeight - 340)) })
    floating.open = false
  }
  function cancel() {
    chooser.open = false
    floating.open = false
    if (slash && range) {
      const command = options.editor.value!.command
      // 搜索文字还给正文，Esc、空格和日期中的斜杠都不能吃字。
      command.executeSetRange(range.endIndex, range.endIndex, range.tableId, range.endTdIndex, range.endTdIndex, range.endTrIndex, range.endTrIndex)
      command.executeInsertElementList([{ value: `/${query}` }])
      command.executeFocus()
    }
    slash = false
    query = ''
  }
  function search(value: string, matched: boolean) {
    if (!slash) return
    query = value
    if (!matched || /\s/.test(value)) cancel()
  }
  function keydown(e: KeyboardEvent) {
    if (!enabled() || e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return
    const command = options.editor.value!.command
    // 数字后的斜杠属于日期、分数等正文，不切换输入焦点。
    if (/\d$/.test(command.getRangeContext()?.endElement.value ?? '')) return
    if (command.getRangeContext()?.isTable && command.getRange().isCrossRowCol) return
    e.preventDefault()
    e.stopPropagation()
    range = structuredClone(command.getRange())
    slash = true
    query = ''
    show()
  }
  function choose(field: FieldDef) {
    if (!enabled() || !range) return
    options.editor.value!.command.executeReplaceRange(range)
    options.insert(field)
    slash = false
    query = ''
    chooser.open = false
    selection.value = false
  }
  function mouseup(e: MouseEvent) {
    refresh()
    // 只在左键选完文字时浮出；右键有自己的菜单（里面也有「设为字段」），两个不叠在一起
    if (selection.value && e.button === 0) Object.assign(floating, { open: true, left: Math.min(e.clientX, window.innerWidth - 300), top: Math.min(e.clientY + 12, window.innerHeight - 48) })
  }
  function drop(e: DragEvent) {
    const key = e.dataTransfer!.getData('application/x-oe-field')
    if (!enabled() || !key) return
    e.preventDefault()
    e.stopPropagation()
    const field = options.library()!.find((f) => f.key === key)
    const canvas = (e.target as Element).closest('canvas')
    if (!field || !canvas) return
    for (const type of ['mousedown', 'mouseup']) {
      canvas.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: e.clientX, clientY: e.clientY, button: 0 }))
    }
    chooser.open = false
    options.insert(field)
  }
  function register(editor: Editor) {
    editor.register.contextMenuList([{
      name: '设为字段',
      when: () => enabled() && options.canConvert(),
      childMenus: (options.library() ?? []).map((field) => ({
        name: field.label,
        callback: () => { refresh(); open(); choose(field) },
      })),
    }])
  }
  watch(options.mode, () => { cancel(); selection.value = false })
  return { selection, chooser, floating, refresh, open, choose, mouseup, drop, register, keydown, search, cancel }
}
