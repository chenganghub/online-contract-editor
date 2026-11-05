// 父页面（宿主）用的客户端：不依赖 Vue，任何网页都能用（JSP、ASP.NET、PHP 页面，或打包进 React / Angular）。
// 用法见 docs/接入指南.md：放一个 iframe 指向嵌入页（地址带 origin=父页面来源），connectEmbed 交文档、实现宿主函数，拿到句柄调方法、订阅事件。
// 安全：只认这个 iframe 发来的、来源是嵌入页的消息；令牌、登录态不进 iframe 地址，宿主函数在父页面执行
import type { BatchResult, FieldValue, Mode, Op } from '@oe/core'
import type { EditorEvents, EditorOptions, ExportFormat, LoadedDocument, SavePayload } from '../types'
import { HOST_FUNCTIONS, PROTOCOL, SIGNING_FUNCTIONS, isMessage, transferable, type EditorMethodName, type EmbedInit, type FrameMessage, type HostFunctionName, type HostMessageBody, type SigningFunctionName } from './protocol'

/** 父页面实现的宿主函数，和 createEditor 的同名选项一样（签署是 signing 对象）；没实现的不传 */
export type EmbedHostFunctions = Partial<Pick<EditorOptions, (typeof HOST_FUNCTIONS)[number] | 'signing'>>

export interface ConnectOptions extends Omit<EmbedInit, 'hostFunctions' | 'document'> {
  /** 嵌入页的来源，如 https://editor.example.com；别的来源发来的消息丢掉 */
  origin: string
  document: LoadedDocument
  host?: EmbedHostFunctions
  /** 等嵌入页装好的时间，默认 30 秒 */
  timeoutMs?: number
}

type Listener = (payload: unknown) => void

/** 和 SDK 的 EditorHandle 方法一样，跨 iframe 所以都返回 Promise */
export interface EmbedHandle {
  getData(): Promise<SavePayload>
  setData(values: Record<string, FieldValue>): Promise<void>
  setMode(mode: Mode): Promise<void>
  validate(): Promise<{ ok: boolean; missing: string[]; invalid: string[] }>
  save(): Promise<void>
  isDirty(): Promise<boolean>
  apply(ops: Op[]): Promise<BatchResult>
  find(text: string, occurrence?: number): Promise<boolean>
  insertText(text: string): Promise<void>
  insertField(key: string): Promise<void>
  getText(): Promise<string>
  export(format: ExportFormat): Promise<Blob>
  download(format: ExportFormat): Promise<void>
  import(file: File): Promise<void>
  print(): Promise<void>
  focus(): Promise<void>
  on<K extends keyof EditorEvents>(name: K, fn: (payload: EditorEvents[K]) => void): () => void
  off<K extends keyof EditorEvents>(name: K, fn: (payload: EditorEvents[K]) => void): void
  /** 停止监听（iframe 由父页面自己移除） */
  disconnect(): void
}

export function connectEmbed(iframe: HTMLIFrameElement, options: ConnectOptions): Promise<EmbedHandle> {
  const { origin, document: doc, host = {}, timeoutMs = 30_000, ...rest } = options
  const listeners = new Map<string, Set<Listener>>()
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  let seq = 0
  let initSent = false
  const post = (msg: HostMessageBody) => iframe.contentWindow?.postMessage({ protocol: PROTOCOL, ...msg }, origin)
  const hostFunctions: HostFunctionName[] = [
    ...HOST_FUNCTIONS.filter((name) => typeof host[name] === 'function'),
    ...SIGNING_FUNCTIONS.filter((name) => typeof host.signing?.[name] === 'function').map((name) => `signing.${name}` as const),
  ]

  return new Promise<EmbedHandle>((resolve, reject) => {
    const timer = setTimeout(() => {
      window.removeEventListener('message', onMessage)
      reject(new Error(`嵌入页 ${timeoutMs / 1000} 秒内没有装好，检查 iframe 地址和 origin 参数`))
    }, timeoutMs)

    const call = (method: EditorMethodName, ...args: unknown[]) =>
      new Promise<unknown>((res, rej) => {
        const id = ++seq
        pending.set(id, { resolve: res, reject: rej })
        post({ type: 'call', id, method, args: args.map(transferable) })
      })

    async function request(msg: Extract<FrameMessage, { type: 'request' }>) {
      const reply = (ok: boolean, result?: unknown, error?: string) => post({ type: 'reply', id: msg.id, ok, result, error })
      try {
        // 只调白名单里的：普通宿主函数，或签署接口的方法（signing.state 这样）
        const name = msg.method.startsWith('signing.') ? (msg.method.slice(8) as SigningFunctionName) : null
        const fn = (
          name
            ? (SIGNING_FUNCTIONS as readonly string[]).includes(name) && host.signing?.[name]?.bind(host.signing)
            : (HOST_FUNCTIONS as readonly string[]).includes(msg.method) && host[msg.method as (typeof HOST_FUNCTIONS)[number]]
        ) as ((...a: unknown[]) => unknown) | undefined | false
        if (!fn) throw new Error(`父页面没有实现 ${msg.method}`)
        reply(true, transferable(await fn(...(msg.args ?? []))))
      } catch (e) {
        reply(false, undefined, e instanceof Error ? e.message : String(e))
      }
    }

    function onMessage(e: MessageEvent) {
      if (e.source !== iframe.contentWindow || e.origin !== origin || !isMessage(e.data)) return
      const msg = e.data as FrameMessage
      if (msg.type === 'ready' && !initSent) {
        initSent = true
        post({ type: 'init', init: transferable({ ...rest, document: doc, hostFunctions }) as EmbedInit })
      } else if (msg.type === 'mounted') {
        clearTimeout(timer)
        resolve(handle)
      } else if (msg.type === 'event') listeners.get(msg.name)?.forEach((fn) => fn(msg.payload))
      else if (msg.type === 'request') void request(msg)
      else if (msg.type === 'reply') {
        const p = pending.get(msg.id)
        if (!p) return
        pending.delete(msg.id)
        if (msg.ok) p.resolve(msg.result)
        else p.reject(new Error(msg.error ?? '编辑器处理失败'))
      }
    }
    window.addEventListener('message', onMessage)

    const off: EmbedHandle['off'] = (name, fn) => void listeners.get(name)?.delete(fn as Listener)
    const handle: EmbedHandle = {
      getData: () => call('getData') as Promise<SavePayload>,
      setData: (values) => call('setData', values) as Promise<void>,
      setMode: (mode) => call('setMode', mode) as Promise<void>,
      validate: () => call('validate') as ReturnType<EmbedHandle['validate']>,
      save: () => call('save') as Promise<void>,
      isDirty: () => call('isDirty') as Promise<boolean>,
      apply: (ops) => call('apply', ops) as Promise<BatchResult>,
      find: (text, occurrence) => call('find', text, occurrence) as Promise<boolean>,
      insertText: (text) => call('insertText', text) as Promise<void>,
      insertField: (key) => call('insertField', key) as Promise<void>,
      getText: () => call('getText') as Promise<string>,
      export: (format) => call('export', format) as Promise<Blob>,
      download: (format) => call('download', format) as Promise<void>,
      import: (file) => call('import', file) as Promise<void>,
      print: () => call('print') as Promise<void>,
      focus: () => call('focus') as Promise<void>,
      on(name, fn) {
        if (!listeners.has(name)) listeners.set(name, new Set())
        listeners.get(name)!.add(fn as Listener)
        return () => off(name, fn)
      },
      off,
      disconnect: () => {
        clearTimeout(timer)
        window.removeEventListener('message', onMessage)
        for (const p of pending.values()) p.reject(new Error('已断开'))
        pending.clear()
      },
    }
  })
}
