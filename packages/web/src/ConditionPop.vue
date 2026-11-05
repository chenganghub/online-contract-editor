<script setup lang="ts">
// 条件条款（docs/设计/08 第 4 节）：选一个下拉、单选或复选字段和它的几个选项，这段只在字段的值是其中之一时出。
// 编辑模式里条件条款都显示（浅灰底），填写、盖章、只读、PDF、Word、HTML、纯文本按值出
import { computed, onMounted, ref, watch } from 'vue'
import type { Condition, FieldOption } from '@oe/core'

const props = defineProps<{
  /** 能当条件的字段：下拉、单选、复选，带选项 */
  fields: { key: string; label: string; options: FieldOption[] }[]
  /** 光标所在条件条款现在的条件；新设的是 null */
  current: Condition | null
  left: number
  top: number
}>()
const emit = defineEmits<{ apply: [when: Condition]; remove: []; close: [] }>()
const el = ref<HTMLElement>()
const field = ref(props.current?.field ?? props.fields[0]?.key ?? '')
const codes = ref<string[]>([...(props.current?.in ?? [])])
const options = computed(() => props.fields.find((f) => f.key === field.value)?.options ?? [])
// 换了字段，原来勾的选项不算数
watch(field, (k) => {
  if (k !== props.current?.field) codes.value = []
})
onMounted(() => el.value?.querySelector<HTMLElement>('select, button')?.focus())
</script>

<template>
  <div ref="el" class="popover condition-pop field-form" role="dialog" aria-label="条件条款" editor-component="component" :style="{ left: `${left}px`, top: `${top}px`, transformOrigin: 'top right' }" @keydown.esc="emit('close')">
    <p v-if="!fields.length" class="empty-note">没有下拉、单选、复选字段</p>
    <template v-else>
      <select v-model="field" aria-label="条件字段">
        <option v-for="f in fields" :key="f.key" :value="f.key">{{ f.label }}</option>
      </select>
      <ul class="rows condition-options" aria-label="选中这些时出这段">
        <li v-for="o in options" :key="o.code">
          <label class="row"><span>{{ o.value }}</span><input v-model="codes" type="checkbox" :value="o.code" /></label>
        </li>
      </ul>
      <div class="field-form-actions">
        <button v-if="current" type="button" class="button-tinted" @click="emit('remove')">取消条件</button>
        <button type="button" class="button-primary" :disabled="!field || !codes.length" @click="emit('apply', { field, in: codes })">{{ current ? '更新' : '设为条件条款' }}</button>
      </div>
    </template>
  </div>
</template>
