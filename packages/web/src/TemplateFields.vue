<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { FieldDef } from '@oe/core'
const props = defineProps<{ fields: FieldDef[]; autofocus?: boolean }>()
const emit = defineEmits<{ insert: [field: FieldDef]; query: [value: string, matched: boolean]; cancel: [] }>()
const query = ref('')
const input = ref<HTMLInputElement>()
const index = ref(0)
const shown = computed(() => props.fields.filter((f) => f.label.includes(query.value.trim()) || f.key.toLowerCase().includes(query.value.trim().toLowerCase())))
function changed(e: Event) {
  if ((e as InputEvent).isComposing) return
  index.value = 0
  emit('query', query.value, shown.value.length > 0)
}
function keydown(e: KeyboardEvent) {
  if (e.isComposing) return
  if (['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(e.key)) { e.preventDefault(); e.stopPropagation() }
  if (e.key === 'ArrowDown') index.value = Math.min(shown.value.length - 1, index.value + 1)
  if (e.key === 'ArrowUp') index.value = Math.max(0, index.value - 1)
  if (e.key === 'Enter' && shown.value[index.value]) emit('insert', shown.value[index.value]!)
  if (e.key === 'Escape') emit('cancel')
}
onMounted(() => { if (props.autofocus) input.value!.focus({ preventScroll: true }) })
function drag(e: DragEvent, field: FieldDef) {
  e.dataTransfer!.setData('application/x-oe-field', field.key)
  e.dataTransfer!.effectAllowed = 'copy'
}
</script>

<template>
  <aside class="template-fields" editor-component="component" aria-label="字段库">
    <h2 class="section-title">插入业务字段</h2>
    <input ref="input" v-model="query" type="search" aria-label="搜索字段" placeholder="搜索字段" @input="changed" @compositionend="changed" @keydown="keydown" />
    <ul class="rows">
      <li v-for="(f, i) in shown" :key="f.key">
        <button type="button" class="row" :class="{ active: autofocus && i === index }" draggable="true" :data-library-field="f.key" @dragstart="drag($event, f)" @click="$emit('insert', f)">
          <span>{{ f.label }}</span>
        </button>
      </li>
    </ul>
    <p v-if="!shown.length" class="empty-note">{{ query ? '没有匹配的字段' : '宿主尚未登记字段' }}</p>
    <slot />
  </aside>
</template>
