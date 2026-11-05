<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import Editor, { EditorMode, type IEditorData, type IEditorOption } from '@hufe921/canvas-editor'
import { applyConditions, layoutOptions, setFieldValues, type DocData, type FieldDef } from '@oe/core'
import type { PreviewSample } from './types'
const props = defineProps<{ doc: DocData; fields: FieldDef[]; samples: PreviewSample[] }>()
defineEmits<{ close: [] }>()
const container = ref<HTMLDivElement>()
const selected = ref(0)
const error = ref('')
let editor: Editor | undefined
function render() {
  editor?.destroy()
  editor = undefined
  const doc = structuredClone(props.doc)
  const keys = new Set<string>()
  function visit(list: DocData['main']) {
    for (const el of list) {
      if (el.control?.conceptId) keys.add(el.control.conceptId)
      const extension = el.extension as { field?: string } | undefined
      if (extension?.field) keys.add(extension.field)
      if (el.valueList) visit(el.valueList)
      for (const tr of el.trList ?? []) {
        const loop = (tr as { extension?: { loop?: string } }).extension?.loop
        if (loop) keys.add(loop)
        for (const td of tr.tdList) visit(td.value)
      }
    }
  }
  visit(doc.main)
  visit(doc.header ?? [])
  visit(doc.footer ?? [])
  try {
    const values = Object.fromEntries(Object.entries(props.samples[selected.value]!.values).filter(([key]) => keys.has(key)))
    const written = setFieldValues(doc as unknown as Parameters<typeof setFieldValues>[0], values, props.fields)
    // 条件条款按样例的值出
    const shown = applyConditions(doc, written)
    editor = new Editor(container.value!, shown as unknown as IEditorData, { ...layoutOptions(doc.page), mode: EditorMode.PRINT } as IEditorOption)
    error.value = ''
  } catch (e) { error.value = e instanceof Error ? e.message : '预览失败' }
}
onMounted(async () => { await nextTick(); render() })
onBeforeUnmount(() => editor?.destroy())
</script>

<template>
  <div class="template-preview" role="dialog" aria-modal="true" aria-label="样例数据预览" @keydown.esc="$emit('close')">
    <header class="preview-toolbar">
      <span>样例数据预览</span>
      <select v-model="selected" aria-label="样例单据" @change="render"><option v-for="(sample, i) in samples" :key="sample.id" :value="i">{{ sample.label }}</option></select>
      <button type="button" class="button-tinted" autofocus @click="$emit('close')">返回设计</button>
    </header>
    <p v-if="error" role="alert">{{ error }}</p>
    <div ref="container" class="preview-pages" />
  </div>
</template>
