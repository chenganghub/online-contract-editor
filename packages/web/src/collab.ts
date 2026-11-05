// 多人编辑的事件流客户端（docs/设计/08 第 3 节）：给宿主用的现成 CollabConnector。
// 用 fetch 读 text/event-stream（EventSource 不能带请求头，令牌不能进地址），断了按服务端给的 retry 重连，连不上逐步拉长到 30 秒。
// 编辑器本身不调 fetch：宿主决定用不用它、带什么请求头
import type { CollabConnector, CollabEvent, CollabLock, CommentApi, CommentItem, LoadedDocument, RevisionApi, RevisionItem } from './types'

export interface SseCollabOptions {
  /** 事件流地址，服务端是 GET /api/documents/{id}/events */
  events: string
  /** 报在场的地址，服务端是 POST /api/documents/{id}/presence；不给就不报 */
  presence?: string
  /** 编辑锁的地址，服务端是 POST /api/documents/{id}/lock；不给就不用锁 */
  lock?: string
  /** 取最新文档的地址，服务端是 GET /api/documents/{id}；不给就不能在别人保存正文后自动刷新 */
  document?: string
  /** 批注的地址，服务端是 /api/documents/{id}/comments；不给就没有批注 */
  comments?: string
  /** 版本历史的地址，服务端是 /api/documents/{id}/revisions；不给就没有版本对比 */
  revisions?: string
  /** 每次请求带的请求头（文档令牌 X-Document-Token 等）；给函数时每次重连现取（令牌会换） */
  headers?: Record<string, string> | (() => Record<string, string>)
}

/** 解析一段 SSE（两个换行分隔的一块）：事件名和 data */
function parseBlock(block: string): { name: string; data: string; retry?: number } | null {
  let name = 'message'
  const data: string[] = []
  let retry: number | undefined
  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue
    const at = line.indexOf(':')
    const field = at < 0 ? line : line.slice(0, at)
    const value = at < 0 ? '' : line.slice(at + 1).replace(/^ /, '')
    if (field === 'event') name = value
    else if (field === 'data') data.push(value)
    else if (field === 'retry' && Number(value) > 0) retry = Number(value)
  }
  return data.length || retry ? { name, data: data.join('\n'), retry } : null
}

export function sseCollab(o: SseCollabOptions): CollabConnector {
  let conn = ''
  const headers = () => (typeof o.headers === 'function' ? o.headers() : (o.headers ?? {}))
  return {
    connect({ event, state, since }) {
      let stopped = false
      let ctrl: AbortController | undefined
      let retry = 3000
      let failures = 0
      const run = async () => {
        while (!stopped) {
          ctrl = new AbortController()
          state?.('connecting')
          try {
            // since 是编辑器已经有的版本号（不是机密）：服务端在 hello 里补发这之后别人的改动
            const v = since?.()
            const url = new URL(o.events, location.href)
            if (v !== undefined) url.searchParams.set('since', String(v))
            const res = await fetch(url, { headers: { Accept: 'text/event-stream', ...headers() }, signal: ctrl.signal, cache: 'no-store' })
            if (!res.ok || !res.body) throw new Error(`事件流 ${res.status}`)
            failures = 0
            state?.('open')
            const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
            let buf = ''
            for (;;) {
              const { value, done } = await reader.read()
              if (done) break
              buf += value.replace(/\r/g, '')
              let at: number
              while ((at = buf.indexOf('\n\n')) >= 0) {
                const block = parseBlock(buf.slice(0, at))
                buf = buf.slice(at + 2)
                if (!block) continue
                if (block.retry) retry = block.retry
                if (!block.data) continue
                const payload = JSON.parse(block.data) as Record<string, unknown>
                if (block.name === 'hello') conn = String(payload.conn ?? '')
                event({ ...payload, type: block.name } as CollabEvent)
              }
            }
          } catch {
            if (stopped) return
            failures++
          }
          conn = ''
          state?.('closed')
          if (stopped) return
          await new Promise((r) => setTimeout(r, Math.min(30_000, retry * Math.max(1, failures))))
        }
      }
      void run()
      return () => {
        stopped = true
        ctrl?.abort()
      }
    },
    async presence(field) {
      if (!o.presence || !conn) return
      await fetch(o.presence, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers() }, body: JSON.stringify({ conn, field }) }).catch(() => {})
    },
    ...(o.lock
      ? {
          async lock(action: 'acquire' | 'release' | 'request', to?: string) {
            if (!conn) return { ok: false, lock: null }
            // 放锁可能发生在关页面时：keepalive 让请求在页面关掉后还能发完
            const res = await fetch(o.lock!, { method: 'POST', keepalive: action === 'release', headers: { 'Content-Type': 'application/json', ...headers() }, body: JSON.stringify({ conn, action, ...(to ? { to } : {}) }) })
            if (!res.ok) throw new Error(`编辑锁 ${res.status}`)
            return (await res.json()) as { ok: boolean; lock: CollabLock | null }
          },
        }
      : {}),
    ...(o.document
      ? {
          async load() {
            const res = await fetch(o.document!, { headers: headers(), cache: 'no-store' })
            if (!res.ok) throw new Error(`取文档 ${res.status}`)
            return (await res.json()) as LoadedDocument & { version: number; status?: string }
          },
        }
      : {}),
    ...(o.comments ? { comments: commentApi(o.comments, headers, () => conn) } : {}),
    ...(o.revisions ? { revisions: revisionApi(o.revisions, headers) } : {}),
  }
}

/** 版本历史接口：只读 */
function revisionApi(base: string, headers: () => Record<string, string>): RevisionApi {
  const get = async (path: string) => {
    const res = await fetch(new URL(base + path, location.href), { headers: headers(), cache: 'no-store' })
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { message?: string }).message ?? `版本 ${res.status}`)
    return res.json()
  }
  return {
    list: async () => ((await get('')) as { revisions: RevisionItem[] }).revisions,
    get: async (version) => (await get(`/${version}`)) as Awaited<ReturnType<RevisionApi['get']>>,
  }
}

/** 批注接口：带上自己的事件流连接，服务端推 comments 时不推回给自己 */
function commentApi(base: string, headers: () => Record<string, string>, conn: () => string): CommentApi {
  const call = async (method: string, path: string, body?: Record<string, unknown>) => {
    const c = conn()
    const url = new URL(base + path, location.href)
    if (method === 'DELETE' && c) url.searchParams.set('conn', c)
    const res = await fetch(url, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers() },
      body: body ? JSON.stringify({ ...body, ...(c ? { conn: c } : {}) }) : undefined,
      cache: 'no-store',
    })
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { message?: string }).message ?? `批注 ${res.status}`)
    return res.json()
  }
  return {
    list: async () => ((await call('GET', '')) as { comments: CommentItem[] }).comments,
    add: async (c) => (await call('POST', '', c)) as CommentItem,
    update: async (id, patch) => void (await call('PATCH', `/${encodeURIComponent(id)}`, patch)),
    remove: async (id) => void (await call('DELETE', `/${encodeURIComponent(id)}`)),
  }
}
