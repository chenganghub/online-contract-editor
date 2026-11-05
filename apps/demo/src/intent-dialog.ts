// 演示宿主的意愿认证（t12）：模拟短信验证码。真实宿主接自己的短信、人脸、签署密码服务；
// 验证码交给宿主后端核对（host-backend.ts 的 registerIntent），通过后它用 API Key 向编辑器服务端登记凭据，这里拿到凭据 id
import type { SignerItem } from '@oe/web'
import { HOST_TOKEN } from './customers'
import './intent-dialog.css'

/** 弹出验证码框；确认后返回凭据 id，取消返回 null */
export function askIntent(documentId: string, signer: SignerItem): Promise<string | null> {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog')
    dialog.className = 'intent-dialog'
    const form = document.createElement('form')
    const title = document.createElement('h2')
    title.textContent = '确认签署'
    const text = document.createElement('p')
    text.textContent = `以${signer.role}（${signer.name}）的身份签署。验证码已发送到 138****8000（演示：输入 ${'123456'}）`
    const input = document.createElement('input')
    Object.assign(input, { inputMode: 'numeric', autocomplete: 'one-time-code', maxLength: 6, placeholder: '6 位验证码', required: true })
    input.setAttribute('aria-label', '短信验证码')
    const error = document.createElement('p')
    error.className = 'intent-error'
    error.setAttribute('role', 'alert')
    const actions = document.createElement('div')
    actions.className = 'intent-actions'
    const cancel = document.createElement('button')
    Object.assign(cancel, { type: 'button', textContent: '取消', className: 'intent-cancel' })
    const ok = document.createElement('button')
    Object.assign(ok, { type: 'submit', textContent: '确认签署', className: 'intent-ok' })
    actions.append(cancel, ok)
    form.append(title, text, input, error, actions)
    dialog.append(form)
    document.body.append(dialog)
    const finish = (v: string | null) => {
      dialog.close()
      dialog.remove()
      resolve(v)
    }
    cancel.addEventListener('click', () => finish(null))
    dialog.addEventListener('cancel', (e) => {
      e.preventDefault()
      finish(null)
    })
    form.addEventListener('submit', async (e) => {
      e.preventDefault()
      ok.disabled = true
      error.textContent = ''
      try {
        const res = await fetch('/host/intent', { method: 'POST', headers: { Authorization: HOST_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ documentId, signer: signer.key, code: input.value.trim() }) })
        const body = (await res.json().catch(() => ({}))) as { intentId?: string; message?: string }
        if (res.ok && body.intentId) return finish(body.intentId)
        error.textContent = body.message ?? `验证失败：${res.status}`
      } catch (err) {
        error.textContent = err instanceof Error ? err.message : String(err)
      } finally {
        ok.disabled = false
      }
    })
    dialog.showModal()
    input.focus()
  })
}
