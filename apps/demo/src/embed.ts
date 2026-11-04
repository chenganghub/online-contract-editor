// 嵌入页（放在 iframe 里）：地址带 origin=父页面来源（可写多个，逗号分隔），文档、宿主函数都由父页面经 postMessage 给。
// 真实部署时这一页和编辑器一起发布，父页面按 docs/接入指南.md 接
import { mountEmbedded } from '@oe/web'

const el = document.querySelector<HTMLElement>('#app')!
const origins = (new URLSearchParams(location.search).get('origin') ?? '').split(',')
try {
  mountEmbedded(el, { allowedOrigins: origins })
} catch (e) {
  el.textContent = e instanceof Error ? e.message : String(e)
}
