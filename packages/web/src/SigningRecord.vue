<script setup lang="ts">
// 签署记录（docs/设计/08 第 5 节，t12）：面板放在检查器的位置。签署方和意愿认证方式、最终文件（哈希、签名证书，
// 测试证书标出来）、证据链（重算哈希链的结果）、下载签好的 PDF 和签署报告、核对一份 PDF（验签）
import { computed, onMounted, ref, watch } from 'vue'
import OeIcon from './OeIcon.vue'
import type { SigningApi, SigningReport, VerifyResult } from './types'

const props = defineProps<{ api: SigningApi; stamp: number }>()
const emit = defineEmits<{ close: [] }>()

const ACTIONS: Record<string, string> = { signers: '设签署方', start: '开始签署', view: '查看', intent: '意愿认证', sign: '签署', reject: '拒签', revoke: '撤回', void: '作废', complete: '生成最终文件' }
const METHODS: Record<string, string> = { sms: '短信验证码', face: '人脸识别', password: '签署密码', cert: '数字证书', other: '其他方式' }
const STATUS: Record<string, string> = { filling: '填写中', sealing: '签署中', sealed: '已签署', void: '已作废' }
const report = ref<SigningReport | null>(null)
const error = ref('')
const verifying = ref(false)
const checked = ref<{ name: string; result: VerifyResult } | null>(null)
const fileInput = ref<HTMLInputElement>()

async function refresh() {
  if (!props.api.report) return
  try {
    report.value = await props.api.report()
    error.value = ''
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}
onMounted(refresh)
watch(() => props.stamp, refresh)

/** 今天的只写时分秒，别的天带上月日（完整时间在悬停提示和签署报告里） */
const time = (iso: string) => {
  const d = new Date(iso)
  return d.toLocaleString('zh-CN', new Date().toDateString() === d.toDateString() ? { hour: '2-digit', minute: '2-digit', second: '2-digit' } : { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
const short = (h: string) => `${h.slice(0, 8)}…${h.slice(-6)}`
const roleOf = (key: string | null) => (key ? (report.value?.signers.find((s) => s.key === key)?.role ?? key) : '')

async function pick(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || !props.api.verify) return
  verifying.value = true
  try {
    checked.value = { name: file.name, result: await props.api.verify(file) }
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    verifying.value = false
  }
}
/** 验签结论：一句话 */
const verdict = computed(() => {
  const r = checked.value?.result
  if (!r) return null
  const sig = r.signatures[0]
  if (!sig) return { ok: false, text: '这份 PDF 没有数字签名' }
  if (!sig.valid) return { ok: false, text: sig.error ?? '签名无效' }
  if (!sig.coversWholeFile) return { ok: false, text: '签名有效，但签完以后文件又被追加修改过' }
  const known = r.known ? `，是「${r.known.title ?? r.known.documentId}」第 ${r.known.version} 版的最终文件` : '，不是这个系统出的文件'
  return { ok: true, text: `签名有效，文件没有被改过${known}` }
})
</script>

<template>
  <div class="inspector-body signing-record" role="region" aria-label="签署记录">
    <h2 class="section-title">签署记录<button type="button" class="icon-button small" aria-label="关闭签署记录" @click="emit('close')"><OeIcon name="xmark" /></button></h2>
    <p v-if="error" class="field-form-error" role="alert">{{ error }}</p>
    <template v-if="report">
      <section class="section">
        <ul class="rows">
          <li class="row"><span class="row-label">状态</span><span class="row-value">{{ STATUS[report.document.status] ?? report.document.status }}</span></li>
          <li v-for="s in report.signers" :key="s.key" class="row" :data-signer="s.key">
            <span class="row-label"><span class="signer-name" :title="`${s.role} · ${s.name}`">{{ s.role }} · {{ s.name }}</span></span>
            <span class="row-value" :class="{ empty: s.status === 'waiting' }">{{ s.status === 'signed' && s.signedAt ? time(s.signedAt) : s.status === 'rejected' ? '拒签' : '待签' }}</span>
          </li>
        </ul>
        <p v-for="s in report.signers.filter((x) => x.intentMethod)" :key="`i-${s.key}`" class="row-meta">{{ s.role }}意愿认证：{{ METHODS[s.intentMethod!] ?? s.intentMethod }}</p>
      </section>
      <section v-if="report.file" class="section">
        <h2 class="section-title">最终文件</h2>
        <p class="row-meta mono" :title="report.file.sha256">SHA-256 {{ short(report.file.sha256) }}</p>
        <p class="row-meta" :class="{ bad: report.file.cert.test }" :title="`${report.file.cert.subject}，序列号 ${report.file.cert.serial}`">{{ report.file.cert.test ? '测试证书签名，无法律效力' : `签名证书：${report.file.cert.subject}` }}</p>
        <div v-if="api.download" class="record-actions">
          <button type="button" class="button-tinted oe-download-signed" @click="api.download('signed')">下载 PDF</button>
          <button type="button" class="button-tinted oe-download-report" @click="api.download('report')">签署报告</button>
        </div>
      </section>
      <section class="section">
        <h2 class="section-title">证据链<span class="row-meta" :class="{ bad: !report.chain.valid }">{{ report.chain.valid ? `${report.chain.count} 条，完整` : `第 ${report.chain.broken} 条起对不上` }}</span></h2>
        <ol class="rows evidence">
          <li v-for="e in report.evidence" :key="e.seq" class="row" :title="`文档哈希 ${e.docHash}\n本条哈希 ${e.hash}${e.ip ? `\nIP ${e.ip}` : ''}${e.userAgent ? `\n${e.userAgent}` : ''}`">
            <span class="row-label">{{ ACTIONS[e.action] ?? e.action }}<span v-if="e.signer" class="row-meta">{{ roleOf(e.signer) }}</span></span>
            <span class="row-value">{{ time(e.at) }}</span>
          </li>
        </ol>
      </section>
    </template>
    <section v-if="api.verify" class="section">
      <h2 class="section-title">核对文件</h2>
      <input ref="fileInput" type="file" accept="application/pdf,.pdf" hidden @change="pick" />
      <button type="button" class="button-tinted oe-verify" :disabled="verifying" @click="fileInput!.click()">{{ verifying ? '核对中…' : '选择 PDF' }}</button>
      <p v-if="verdict" class="verdict" :class="{ bad: !verdict.ok }" role="status"><OeIcon :name="verdict.ok ? 'checkmark' : 'exclamation'" />{{ verdict.text }}</p>
      <p v-if="checked?.result.signatures[0]?.testCert" class="row-meta">签名用的是测试证书，无法律效力</p>
    </section>
  </div>
</template>
