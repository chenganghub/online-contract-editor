<script setup lang="ts">
// 签署（docs/设计/08 第 5 节，t12）：盖章模式检查器的上半部分。签署方按顺序列出（签署中、待签、已签、拒签），
// 自己的签名区（「签名」开签名板，签了能重签，确认签署前都只在本地），签署日期签的时候由服务端写；拒签要写原因
import { computed, ref } from 'vue'
import type { FieldDef } from '@oe/core'
import type { SignerItem, SigningState } from './types'

const props = defineProps<{
  state: SigningState
  fields: FieldDef[]
  /** 签好还没确认的签名（字段 key → PNG） */
  drafts: Record<string, string>
  busy: boolean
}>()
const emit = defineEmits<{ sign: [field: FieldDef]; reject: [reason: string] }>()

const turn = computed(() => new Set(props.state.turn))
const me = computed(() => props.state.signers.find((s) => s.key === props.state.me) ?? null)
const waiting = computed(() => me.value?.status === 'waiting' && props.state.status === 'sealing')
const mine = computed(() => props.fields.filter((f) => f.type === 'signature' && f.signer === me.value?.key))
const myDates = computed(() => props.fields.filter((f) => f.type === 'signDate' && f.signer === me.value?.key))
const rejecting = ref(false)
const reason = ref('')

const time = (iso: string) => {
  const d = new Date(iso)
  const today = new Date().toDateString() === d.toDateString()
  return d.toLocaleString('zh-CN', today ? { hour: '2-digit', minute: '2-digit' } : { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
function statusOf(s: SignerItem) {
  if (s.status === 'signed') return s.signedAt ? `已签 ${time(s.signedAt)}` : '已签'
  if (s.status === 'rejected') return '拒签'
  return props.state.status === 'sealing' && turn.value.has(s.key) ? '签署中' : '待签'
}
const deadline = computed(() => (props.state.deadline ? new Date(props.state.deadline).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''))
function submitReject() {
  emit('reject', reason.value.trim())
  rejecting.value = false
  reason.value = ''
}
</script>

<template>
  <section class="section signing">
    <h2 class="section-title">签署<span v-if="deadline" class="row-meta">截止 {{ deadline }}</span></h2>
    <ol class="rows signers">
      <li v-for="s in state.signers" :key="s.key" class="row" :class="{ current: statusOf(s) === '签署中' }" :data-signer="s.key">
        <span class="row-label"><span class="signer-name" :title="`${s.role} · ${s.name}`">{{ s.role }} · {{ s.name }}</span><span v-if="s.key === state.me" class="row-tag">我</span></span>
        <span class="row-value" :class="{ empty: s.status === 'waiting' && statusOf(s) !== '签署中' }" :title="s.rejectReason ?? undefined">{{ statusOf(s) }}</span>
      </li>
    </ol>
  </section>
  <section v-if="waiting && (mine.length || myDates.length)" class="section">
    <h2 class="section-title">我的签名</h2>
    <ul class="rows">
      <li v-for="f in mine" :key="f.key" class="row" :data-sign="f.key">
        <span class="row-label">{{ f.label }}</span>
        <span class="row-trailing">
          <img v-if="drafts[f.key]" :src="drafts[f.key]" class="sign-thumb" alt="" />
          <button type="button" class="button-tinted" :disabled="busy || !turn.has(me!.key)" @click.stop="emit('sign', f)">{{ drafts[f.key] ? '重签' : '签名' }}</button>
        </span>
      </li>
      <li v-for="f in myDates" :key="f.key" class="row">
        <span class="row-label">{{ f.label }}</span>
        <span class="row-value empty">签署时填写</span>
      </li>
    </ul>
  </section>
  <section v-if="waiting" class="section">
    <form v-if="rejecting" class="field-form" @submit.prevent="submitReject">
      <textarea v-model="reason" class="reject-reason" rows="3" maxlength="500" placeholder="拒签原因" aria-label="拒签原因"></textarea>
      <div class="field-form-actions">
        <button type="button" class="button-tinted" @click="rejecting = false">取消</button>
        <button type="submit" class="button-primary oe-reject-confirm" :disabled="busy || !reason.trim()">拒签</button>
      </div>
    </form>
    <button v-else type="button" class="button-tinted oe-reject" :disabled="busy" @click="rejecting = true">拒签</button>
  </section>
</template>
