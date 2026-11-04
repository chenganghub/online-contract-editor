// iframe 里的嵌入页：等父页面发来 init 再建编辑器；父页面调方法、编辑器发事件、编辑器要用宿主函数都走 postMessage。
// 安全：只认地址上 origin 参数列出的来源（可写多个，逗号分隔）；第一次 init 之后只认那一个来源；回消息指定目标来源，不用 *
import { createEditor, type EditorHandle } from '../sdk'
import type { EditorEvents, EditorOptions } from '../types'
import { EDITOR_METHODS, PROTOCOL, isMessage, transferable, type FrameMessageBody, type HostFunctionName, type HostMessage } from './protocol'

const EVENTS: (keyof EditorEvents)[] = ['ready', 'change', 'field-change', 'saved', 'mode-change', 'dirty-change', 'field-focus']

export interface EmbedFrameOptions {
  /** 允许的父页面来源，如 https://oa.example.com；不在里面的消息一律丢掉 */
  allowedOrigins: string[]
}

/** 在嵌入页里调用：el 是编辑器挂的元素。返回停止监听的函数 */
export function mountEmbedded(el: HTMLElement, options: EmbedFrameOptions): () => void {
  const allowed = new Set(options.allowedOrigins.map((o) => o.trim()).filter(Boolean))
  if (window.parent === window) throw new Error('嵌入页要放在 iframe 里打开')
  if (!allowed.size) throw new Error('嵌入页地址缺少 origin 参数（允许的父页面来源）')
  let parentOrigin: string | null = null
  let handle: EditorHandle | null = null
  let seq = 0
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

  const post = (msg: FrameMessageBody) => {
    const data = { protocol: PROTOCOL, ...msg }
    // init 之前不知道是哪个来源：发给每个允许的来源，只有对得上的那个父页面收得到
    for (const origin of parentOrigin ? [parentOrigin] : allowed) window.parent.postMessage(data, origin)
  }
  const hostCall = (method: HostFunctionName) => (...args: unknown[]) =>
    new Promise<unknown>((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve, reject })
      post({ type: 'request', id, method, args: args.map(transferable) })
    })

  async function init(msg: Extract<HostMessage, { type: 'init' }>) {
    const { init } = msg
    const has = (name: HostFunctionName) => init.hostFunctions.includes(name)
    const fn = <T>(name: HostFunctionName) => (has(name) ? (hostCall(name) as unknown as T) : undefined)
    const opts: EditorOptions = {
      mode: init.mode,
      modes: init.modes,
      load: async () => init.document,
      // 父页面没给保存函数时，保存只在编辑器里（宿主可以用 getData 自己取）
      save: fn<EditorOptions['save']>('save') ?? (async () => {}),
      publish: fn('publish'),
      search: fn('search'),
      request: fn('request'),
      download: fn('download'),
      importDocx: fn('importDocx'),
      onSeal: fn('onSeal'),
      seals: init.seals,
      previewSamples: init.previewSamples,
      dataSources: init.dataSources,
      confirmLeave: init.confirmLeave,
    }
    handle = await createEditor(el, opts)
    for (const name of EVENTS) handle.on(name, (payload) => post({ type: 'event', name, payload: transferable(payload) }))
    post({ type: 'mounted' })
  }

  async function call(msg: Extract<HostMessage, { type: 'call' }>) {
    const reply = (ok: boolean, result?: unknown, error?: string) => post({ type: 'reply', id: msg.id, ok, result, error })
    try {
      if (!handle) throw new Error('编辑器还没装好')
      if (!(EDITOR_METHODS as readonly string[]).includes(msg.method)) throw new Error(`不能调用 ${msg.method}`)
      const fn = handle[msg.method] as (...a: unknown[]) => unknown
      reply(true, transferable(await fn(...(msg.args ?? []))))
    } catch (e) {
      reply(false, undefined, e instanceof Error ? e.message : String(e))
    }
  }

  const onMessage = (e: MessageEvent) => {
    if (e.source !== window.parent || !allowed.has(e.origin) || (parentOrigin && e.origin !== parentOrigin) || !isMessage(e.data)) return
    const msg = e.data as HostMessage
    if (msg.type === 'init') {
      if (parentOrigin) return
      parentOrigin = e.origin
      clearInterval(announce)
      init(msg).catch((err) => {
        el.textContent = err instanceof Error ? err.message : String(err)
        post({ type: 'event', name: 'error', payload: el.textContent })
      })
    } else if (msg.type === 'call') void call(msg)
    else if (msg.type === 'reply') {
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      if (msg.ok) p.resolve(msg.result)
      else p.reject(new Error(msg.error ?? '父页面处理失败'))
    }
  }
  window.addEventListener('message', onMessage)
  // 父页面可能比 iframe 晚开始监听：每半秒说一次 ready，收到 init 为止（最多 30 秒）
  let tries = 0
  const announce = window.setInterval(() => {
    if (++tries > 60) return clearInterval(announce)
    post({ type: 'ready' })
  }, 500)
  post({ type: 'ready' })
  return () => {
    clearInterval(announce)
    window.removeEventListener('message', onMessage)
    handle?.destroy()
  }
}
