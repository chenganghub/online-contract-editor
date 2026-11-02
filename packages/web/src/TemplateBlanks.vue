<script setup lang="ts">
import { computed } from 'vue'
import type Editor from '@hufe921/canvas-editor'
import type { IElement } from '@hufe921/canvas-editor'
const props = defineProps<{ editor: Editor; revision: number }>()
const emit = defineEmits<{ select: [] }>()
const blanks = computed(() => {
  void props.revision
  const found: string[] = []
  function visit(list: IElement[]) {
    let text = ''
    const flush = () => {
      found.push(...(text.match(/_{3,}|[（(][ \u3000\t]+[）)]|[ \u3000]{2,}年[ \u3000]+月[ \u3000]+日/g) ?? []))
      text = ''
    }
    for (const el of list) {
      if ((!el.type || el.type === 'text') && !el.controlId && !el.areaId) text += el.value
      else {
        flush()
        if (el.type !== 'control' && el.valueList) visit(el.valueList)
        for (const tr of el.trList ?? []) for (const td of tr.tdList) visit(td.value)
      }
    }
    flush()
  }
  const data = props.editor.command.getValue().data
  visit(data.main)
  const counts = new Map<string, number>()
  return found.map((text) => {
    const occurrence = counts.get(text) ?? 0
    counts.set(text, occurrence + 1)
    return { text, occurrence }
  })
})
function select(blank: { text: string; occurrence: number }) {
  const range = props.editor.command.getKeywordRangeList(blank.text)[blank.occurrence]
  if (!range) return
  props.editor.command.executeReplaceRange(range)
  emit('select')
}
</script>

<template>
  <section class="template-blanks" aria-label="待设字段的空白">
    <h2 class="section-title">待设字段的空白</h2>
    <ul class="rows">
      <li v-for="(blank, i) in blanks" :key="i"><button type="button" class="row" @mousedown.prevent @click="select(blank)"><span>{{ i + 1 }}. {{ blank.text }}</span></button></li>
    </ul>
    <p v-if="!blanks.length" class="empty-note">没有待设置的空白</p>
  </section>
</template>
