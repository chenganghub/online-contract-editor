<script setup lang="ts">
// 手写签名板（docs/设计/08 第 5 节，t12）：鼠标、触屏、手写笔都能写（Pointer Events，触屏写的时候页面不滚）；
// 手写笔按压力变粗细。笔画用中点二次曲线连起来，不发抖。「使用」时裁掉四周空白，按签名区的宽高比居中放进
// 一张两倍大的透明 PNG（显示在签名区上不变形），交给宿主转给服务端
import { computed, onMounted, ref } from 'vue'
import OeIcon from './OeIcon.vue'

const props = defineProps<{
  label: string
  /** 签名区的大小（px）：导出的图片按它的宽高比 */
  width: number
  height: number
}>()
const emit = defineEmits<{ done: [dataURL: string]; cancel: [] }>()

type Point = { x: number; y: number; p: number }
/** 写字区的大小（CSS px） */
const W = 560
const H = 220
const INK = '#1d1d1f'
const canvas = ref<HTMLCanvasElement>()
const strokes = ref<Point[][]>([])
const empty = computed(() => !strokes.value.length)
let current: Point[] | null = null
let ratio = 1

/** 线宽：鼠标、手指一样粗，手写笔按压力 */
const widthOf = (p: Point) => 1.2 + p.p * 3.6
const mid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, p: (a.p + b.p) / 2 })
/** 画笔画：k 是坐标缩放，lw 是线宽缩放，(dx, dy) 是左上角 */
function paint(g: CanvasRenderingContext2D, list: Point[][], k: number, lw: number, dx = 0, dy = 0) {
  const X = (p: Point) => (p.x - dx) * k
  const Y = (p: Point) => (p.y - dy) * k
  g.lineCap = 'round'
  g.lineJoin = 'round'
  g.strokeStyle = INK
  g.fillStyle = INK
  for (const s of list) {
    if (s.length === 1) {
      g.beginPath()
      g.arc(X(s[0]!), Y(s[0]!), (widthOf(s[0]!) * lw) / 2, 0, Math.PI * 2)
      g.fill()
      continue
    }
    // 每一段从上一段的中点画到这一段的中点，控制点是两段相接的那个点；最后一段画到终点
    for (let i = 1; i < s.length; i++) {
      const a = s[i - 1]!
      const b = s[i]!
      const from = i === 1 ? a : mid(s[i - 2]!, a)
      const to = i === s.length - 1 ? b : mid(a, b)
      g.beginPath()
      g.lineWidth = widthOf(b) * lw
      g.moveTo(X(from), Y(from))
      g.quadraticCurveTo(X(a), Y(a), X(to), Y(to))
      g.stroke()
    }
  }
}
function redraw() {
  const c = canvas.value!
  const g = c.getContext('2d')!
  g.clearRect(0, 0, c.width, c.height)
  paint(g, strokes.value, ratio, ratio)
}

const pointOf = (e: PointerEvent): Point => {
  const r = canvas.value!.getBoundingClientRect()
  return { x: e.clientX - r.left, y: e.clientY - r.top, p: e.pointerType === 'pen' ? Math.max(0.15, e.pressure || 0.5) : 0.5 }
}
function down(e: PointerEvent) {
  if (e.pointerType === 'mouse' && e.button !== 0) return
  e.preventDefault()
  canvas.value!.setPointerCapture(e.pointerId)
  current = [pointOf(e)]
  strokes.value = [...strokes.value, current]
  redraw()
}
function move(e: PointerEvent) {
  if (!current) return
  // 快速划过时浏览器把几个点合成一个事件，取全（getCoalescedEvents）
  for (const ev of e.getCoalescedEvents?.() ?? [e]) current.push(pointOf(ev))
  redraw()
}
const up = () => (current = null)
function undo() {
  strokes.value = strokes.value.slice(0, -1)
  redraw()
}
function clear() {
  strokes.value = []
  redraw()
}

/** 裁掉空白、按签名区的宽高比居中，导出两倍大的透明 PNG */
function use() {
  const pts = strokes.value.flat()
  const pad = 6
  const minX = Math.min(...pts.map((p) => p.x)) - pad
  const minY = Math.min(...pts.map((p) => p.y)) - pad
  const bw = Math.max(...pts.map((p) => p.x)) + pad - minX
  const bh = Math.max(...pts.map((p) => p.y)) + pad - minY
  const outW = Math.round(props.width * 2)
  const outH = Math.round(props.height * 2)
  // 写得很小的不放大太多（最多原大的两倍），线宽按导出图的大小，不跟着缩放
  const k = Math.min(outW / bw, outH / bh, 2)
  const c = document.createElement('canvas')
  c.width = outW
  c.height = outH
  paint(c.getContext('2d')!, strokes.value, k, Math.max(1.5, k), minX - (outW / k - bw) / 2, minY - (outH / k - bh) / 2)
  emit('done', c.toDataURL('image/png'))
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('cancel')
  else if (e.key === 'z' && (e.metaKey || e.ctrlKey) && !empty.value) {
    e.preventDefault()
    undo()
  }
}
onMounted(() => {
  ratio = window.devicePixelRatio || 1
  canvas.value!.width = W * ratio
  canvas.value!.height = H * ratio
  canvas.value!.focus()
})
</script>

<template>
  <div class="sheet-backdrop" editor-component="component" @mousedown.self="emit('cancel')">
    <div class="sheet sign-sheet" role="dialog" :aria-label="label" @keydown="onKey">
      <div class="sheet-head">
        <span class="sheet-title">{{ label }}</span>
        <button type="button" class="icon-button small" aria-label="关闭签名板" @click="emit('cancel')"><OeIcon name="xmark" /></button>
      </div>
      <div class="sign-pad" :style="{ width: `${W}px`, height: `${H}px` }">
        <span v-if="empty" class="sign-pad-hint" aria-hidden="true">在这里签名</span>
        <span class="sign-pad-line" aria-hidden="true"></span>
        <canvas ref="canvas" tabindex="0" aria-label="签名" :style="{ width: `${W}px`, height: `${H}px` }" @pointerdown="down" @pointermove="move" @pointerup="up" @pointercancel="up" @lostpointercapture="up"></canvas>
      </div>
      <div class="sheet-actions">
        <button type="button" class="button-tinted" :disabled="empty" @click="undo">撤销一笔</button>
        <button type="button" class="button-tinted" :disabled="empty" @click="clear">清除</button>
        <span class="spacer"></span>
        <button type="button" class="button-tinted" @click="emit('cancel')">取消</button>
        <button type="button" class="button-primary oe-sign-use" :disabled="empty" @click="use">使用</button>
      </div>
    </div>
  </div>
</template>
