// 演示宿主接真实服务端（s13）：地址带 ?doc=<文档 id> 时用，模式和权限的模拟参数和本地版一样（main.ts）。
// 先带宿主登录态向宿主后端要文档令牌（host-backend.ts），之后只用文档令牌，放在请求头 X-Document-Token；
// 文档令牌和宿主登录态都不进任何地址（方案 4.7，验收 16）。接口和页面同源（真实部署由宿主反向代理 /api）
import {
  sseCollab,
  type CollabConnector,
  type DocActions,
  type EditorOptions,
  type FieldDef,
  type LoadedDocument,
  type Mode,
  type Permission,
  type SaveResult,
  type SignerItem,
  type SigningApi,
  type SigningReport,
  type SigningResult,
  type SigningState,
  type VerifyResult,
} from '@oe/web'
import { HOST_TOKEN } from './customers'
import { askIntent } from './intent-dialog'

type ServerDoc = LoadedDocument & { mode: Mode; version: number; status: string }
export type HostFunctions = Pick<EditorOptions, 'mode' | 'modes' | 'load' | 'save' | 'publish' | 'onSeal' | 'download' | 'collab' | 'signing'>
/** 演示用的当前用户（真实宿主用自己的登录态，这里用地址上的 ?user= 模拟几个人） */
export interface DemoUser {
  id: string
  name: string
}

/** 失败时抛出服务端给的原因（错误响应是 { code, message }） */
async function fail(res: Response, what: string): Promise<never> {
  const body = (await res.json().catch(() => ({}))) as { message?: string }
  throw new Error(`${what}失败：${body.message ?? res.status}`)
}
async function parse<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) return fail(res, what)
  return (await res.json()) as T
}

/** 要令牌、按令牌取文档（模式、权限、能不能打印下载以服务端为准，隐藏字段的值服务端已经剔除），返回接到服务端的宿主函数。signer：签署方（盖章模式按签署方签） */
export async function connectServer(docId: string, mode: Mode, permissions: Record<string, Permission>, actions: DocActions, user?: DemoUser, signer?: string): Promise<HostFunctions> {
  const { token } = await parse<{ token: string }>(
    await fetch('/host/token', {
      method: 'POST',
      headers: { Authorization: HOST_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentId: docId, mode, permissions, actions, user, signer }),
    }),
    '拿文档令牌',
  )
  const base = `/api/documents/${encodeURIComponent(docId)}`
  const initial = await parse<ServerDoc>(await fetch(base, { headers: { 'X-Document-Token': token } }), '打开文档')
  let version = initial.version
  // 一个接一个发：服务端每次改动版本号加 1，后一个要带前一个返回的版本号（放章还在途时点「完成」，提交也排在后面）。
  // at：多人编辑时编辑器给的版本号（它手上的文档是哪一版），优先用它。别人先改了同一字段时服务端回 409 FIELD_CONFLICT，交还给编辑器处理
  let last: Promise<unknown> = Promise.resolve()
  const send = (method: string, path: string, body: Record<string, unknown>, at?: number): Promise<SaveResult> => {
    const run = last
      .catch(() => {})
      .then(async () => {
        const res = await fetch(base + path, { method, headers: { 'X-Document-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, version: at ?? version }) })
        if (res.status === 409 && body.base) {
          const err = (await res.clone().json().catch(() => ({}))) as { code?: string; conflicts?: SaveResult['conflicts']; version?: number }
          if (err.code === 'FIELD_CONFLICT') return { conflicts: err.conflicts, version: err.version }
          if (err.code === 'VERSION_CONFLICT') return { stale: true }
        }
        const r = await parse<{ version?: number }>(res, '保存')
        if (typeof r.version === 'number') version = Math.max(version, r.version)
        return { version: r.version }
      })
    last = run
    return run
  }
  // 填写模式只提交可编辑（含必填）字段的值，服务端按令牌的权限写进文档，和 core 的 applyFill 同一个判定（方案 4.7）；
  // 令牌、模板都没给权限时，签名区、签署日期只读（签署时由服务端写，同 core 的 permissionOf），其他可编辑
  const permOf = (f: FieldDef): Permission => initial.permissions?.[f.key] ?? f.permission ?? (f.type === 'signature' || f.type === 'signDate' ? 'readonly' : 'editable')
  const editable = new Set(initial.fields.filter((f) => f.type !== 'computed' && ['editable', 'required'].includes(permOf(f))).map((f) => f.key))
  return {
    mode: initial.mode,
    modes: [initial.mode],
    load: async () => initial,
    // 多人编辑时编辑器给 changed、base、conn、version：只交改过的字段，服务端按字段合并、判冲突（docs/接入指南.md）
    save: async ({ mode, doc, values, pageCount, areas, changed, base: seen, conn, version: at }) => {
      const collab = seen ? { base: seen, conn } : {}
      if (mode === 'edit') return send('PUT', '', { doc, values, pageCount, ...collab }, at)
      if (mode === 'fill') {
        const keys = changed ?? Object.keys(values.values)
        const patch = Object.fromEntries(keys.filter((k) => editable.has(k)).map((k) => [k, values.values[k] ?? null]))
        // 改过的可编辑区一起提交，服务端只接受模板里标成可编辑区的
        return send('PATCH', '/data', { patch, areas, pageCount, ...collab }, at)
      }
      if (mode === 'seal') return send('POST', '/seal-status', { action: 'submit' })
    },
    onSeal: async (op) => {
      await send('POST', '/seals', op)
    },
    // 多人编辑：事件流和在场都只带文档令牌（请求头），见 docs/接入指南.md。
    // 别人改了文档（签署时别的签署方签了、盖了章）：按事件和重新取到的版本号跟上，之后放章、签署带最新的版本号
    collab: followVersions(sseCollab({ events: `${base}/events`, presence: `${base}/presence`, lock: `${base}/lock`, document: base, comments: `${base}/comments`, revisions: `${base}/revisions`, headers: { 'X-Document-Token': token } }), (v) => (version = Math.max(version, v))),
    download: async (format) => {
      const res = await fetch(`${base}/export?format=${format}`, { headers: { 'X-Document-Token': token } })
      if (!res.ok) return fail(res, '下载')
      saveBlob(await res.blob(), `${initial.title ?? '文档'}.${format}`)
    },
    signing: await signingOf(docId, base, token, initial, (run) => {
      // 签、拒签和放章排在同一个队里（服务端每次改动版本号加 1，后一个要带前一个返回的版本号）
      const next = last.catch(() => {}).then(() => run(version))
      last = next
      return next.then((r) => {
        version = Math.max(version, r.version)
        return r
      })
    }),
  }
}

/** 事件流推来的、重新取到的文档版本号交给 seen */
function followVersions(c: CollabConnector, seen: (version: number) => void): CollabConnector {
  return {
    ...c,
    connect: (h) =>
      c.connect({
        ...h,
        event: (e) => {
          if ('version' in e) seen(e.version)
          h.event(e)
        },
      }),
    ...(c.load
      ? {
          load: async () => {
            const d = await c.load!()
            seen(d.version)
            return d
          },
        }
      : {}),
  }
}

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/**
 * 签署（t12）：文档设了签署方才有。签署方、签署记录、下载走服务端的签署接口（令牌放请求头）；盖章模式的令牌绑定了签署方时能签、拒签，
 * 意愿认证是演示的短信验证码（intent-dialog.ts）；验签经宿主后端转给服务端（要 API Key）
 */
async function signingOf(docId: string, base: string, token: string, initial: ServerDoc, enqueue: (run: (version: number) => Promise<SigningResult>) => Promise<SigningResult>): Promise<SigningApi | undefined> {
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> =>
    parse<T>(await fetch(base + path, { method, headers: { 'X-Document-Token': token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) }), '签署')
  const state = await call<SigningState>('GET', '/signers')
  if (!state.signers.length) return undefined
  const signer = initial.mode === 'seal' && state.me ? state.me : null
  return {
    state: () => call<SigningState>('GET', '/signers'),
    ...(signer
      ? {
          confirmIntent: (s: SignerItem) => askIntent(docId, s),
          sign: (req: { signatures: Record<string, string>; intent?: string }) => enqueue((version) => call<SigningResult>('POST', '/sign', { action: 'sign', version, ...req })),
          reject: (reason: string) => enqueue((version) => call<SigningResult>('POST', '/sign', { action: 'reject', version, reason })),
        }
      : {}),
    report: () => call<SigningReport>('GET', '/signing-report'),
    download: async (what: 'signed' | 'report') => {
      const res = await fetch(base + (what === 'signed' ? '/signed-file' : '/signing-report?format=pdf'), { headers: { 'X-Document-Token': token } })
      if (!res.ok) return fail(res, '下载')
      saveBlob(await res.blob(), what === 'signed' ? `${initial.title ?? '文档'}（已签署）.pdf` : `${initial.title ?? '文档'}签署报告.pdf`)
    },
    verify: async (file: File) => {
      const bytes = new Uint8Array(await file.arrayBuffer())
      let bin = ''
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      return parse<VerifyResult>(await fetch('/host/verify', { method: 'POST', headers: { Authorization: HOST_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ pdf: btoa(bin) }) }), '验签')
    },
  }
}

/** 模板令牌仅用于草稿；宿主密钥和业务数据不交给编辑器。 */
export async function connectTemplate(templateId: string): Promise<HostFunctions> {
  const opened = await parse<{ templateId: string; token: string }>(await fetch('/host/template', {
    method: 'POST', headers: { Authorization: HOST_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ templateId }),
  }), '打开模板')
  const url = new URL(location.href)
  url.searchParams.set('template', opened.templateId)
  history.replaceState(null, '', url)
  const base = `/api/templates/${encodeURIComponent(opened.templateId)}/draft`
  const headers = { 'X-Template-Token': opened.token, 'Content-Type': 'application/json' }
  const initial = await parse<LoadedDocument & { version: number }>(await fetch(base, { headers }), '加载草稿')
  let version = initial.version
  let last: Promise<unknown> = Promise.resolve()
  const send = (method: string, suffix: string, body: object) => {
    const run = last.catch(() => {}).then(async () => {
      const result = await parse<{ version: number }>(await fetch(base + suffix, { method, headers, body: JSON.stringify({ ...body, version }) }), '保存模板')
      version = result.version
    })
    last = run
    return run
  }
  return {
    mode: 'edit', modes: ['edit'], load: async () => initial,
    save: async ({ doc, fields }) => send('PUT', '', { doc, fields }),
    publish: () => send('POST', '/publish', {}),
  }
}
