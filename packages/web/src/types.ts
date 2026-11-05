import type { AreaRun, DocData, DocValues, FieldDef, FieldValue, Mode, Permission } from '@oe/core'

/** 宿主提供的印章（当前用户可用的印章，来自宿主函数） */
export interface SealOption {
  id: string
  name: string
  /** 图片 dataURL */
  src: string
}

/** 数据选择的一条记录 */
export interface PickItem {
  id: string
  title: string
  subtitle?: string
  record: Record<string, unknown>
}

export type PickSearch = (field: FieldDef, query: string, page: number) => Promise<{ items: PickItem[]; total: number; pageSize: number }>

/** 样例业务值由宿主提供；预览只填副本，不保存回模板。 */
export interface PreviewSample {
  id: string
  label: string
  values: DocValues['values']
}

/**
 * 宿主注入的请求函数（方案 4.5）：编辑器里的网络请求都走它，由宿主带上自己的登录态，返回解析好的 JSON。
 * 编辑器自己不调 fetch；不传就不发请求，远程数据源搜不到东西。
 */
export type RequestFn = (req: { url: string; method: 'GET' | 'POST'; query?: Record<string, string | number>; body?: unknown }) => Promise<unknown>

/** 数据源定义：字段的 dataSource.id 指到这里 */
export type DataSourceDef =
  /** 固定的记录，在浏览器里按关键字过滤、分页 */
  | { kind: 'static'; items: PickItem[]; pageSize?: number }
  /** 远程接口，经 request 调用 */
  | {
      kind: 'remote'
      url: string
      method?: 'GET' | 'POST'
      /** 关键字、页码（从 1 起）、每页条数的参数名，默认 q、page、size；GET 放查询串，POST 放请求体 */
      params?: { query?: string; page?: string; size?: string }
      /** 每页条数，默认 5 */
      pageSize?: number
      /** 返回 JSON 里列表和总数的位置（点号路径，如 data.list） */
      list: string
      total: string
      /** 每条记录里 id、标题、副标题的属性名 */
      id: string
      title: string
      subtitle?: string
    }

export interface SavePayload {
  mode: Mode
  doc: DocData
  values: DocValues
  fields: FieldDef[]
  /** 按打印模式数的页数：宿主保存时带给服务端（PUT / PATCH 的 pageCount），导出时核对 PDF 页数 */
  pageCount?: number
  /** 改过的可编辑区（按 anchor，带样式的文字）：填写模式保存时和字段值一起提交（PATCH data 的 areas） */
  areas?: Record<string, AreaRun[]>
  /**
   * 多人编辑（接了 collab 时才有，docs/设计/08 第 3 节）：和服务端上次同步的值比改过的字段 key。
   * 宿主按它只提交这些（PATCH 的 patch 只放这几个），别人同时改的别的字段就不会被旧值盖掉
   */
  changed?: string[]
  /** 和 changed 一起：每个改过的字段（可编辑区是 area:anchor）编辑器看到的是服务端哪一版的值，原样交给服务端（PATCH、PUT 的 base） */
  base?: Record<string, number>
  /** 编辑器的事件流连接 id，原样交给服务端（PATCH、PUT 的 conn）：服务端推改动时不推回给自己 */
  conn?: string
  /** 编辑器手上的文档对应服务端哪一版，交给服务端（PATCH、PUT 的 version） */
  version?: number
}

/** 别人先改了的字段（服务端 409 FIELD_CONFLICT 的 conflicts） */
export interface FieldConflict {
  /** 字段 key；可编辑区是 area:anchor */
  key: string
  /** 服务端现在的值（可编辑区是带样式的文字） */
  value: FieldValue | AreaRun[]
  /** 改的人（显示用的名字） */
  by?: string
  version?: number
}

/** 宿主 save 可以返回的结果，都可选；不返回也行（一个人用时） */
export interface SaveResult {
  /** 服务端保存后的版本号 */
  version?: number
  /** 别人先改了这些字段，这次什么都没保存：编辑器换成对方的值、提示，再保存别的 */
  conflicts?: FieldConflict[]
  /** 正文在编辑器手上的那一版之后被别人整份改过（服务端 409 VERSION_CONFLICT），这次没保存：填写模式先按最新的重新装再存 */
  stale?: boolean
}

/** 能不能打印、下载：宿主按令牌给（服务端 GET 文档时返回），不给（undefined）都能 */
export interface DocActions {
  /** 只控制界面上的打印按钮；浏览器自己的打印（Ctrl+P）拦不住 */
  print?: boolean
  /** 下载按钮和导出菜单还要宿主传了 EditorOptions.download 才显示；服务端 /export 也按令牌拦 */
  download?: boolean
}

export interface LoadedDocument {
  doc: DocData
  values?: DocValues
  /** 服务端的版本号（GET /api/documents/{id} 的 version）：多人编辑时编辑器从这一版起跟踪别人的改动 */
  version?: number
  fields: FieldDef[]
  /** 模板设计可插入的宿主字段库；已使用的字段仍以 fields 快照为准。 */
  libraryFields?: FieldDef[]
  title?: string
  permissions?: Record<string, Permission>
  actions?: DocActions
}

/** 在场的一个人（多人编辑，docs/设计/08 第 3 节）：同一个人开两个窗口算两条 */
export interface CollabViewer {
  /** 事件流连接 id */
  conn: string
  userId: string
  name: string
  mode: Mode
  /** 光标所在的字段 key；不在字段里（或在你看不到的字段里）是 null */
  field: string | null
}
/** 正文编辑锁：谁拿着、到什么时候 */
export interface CollabLock {
  userId: string
  name: string
  conn?: string
  expiresAt: string
}
/** 改动的人 */
export interface CollabBy {
  userId: string
  name: string
}
/** 连上（或重连）时服务端补发的：since 那一版之后别人改过的字段、可编辑区，正文有没有整份改过 */
export interface CollabChanges {
  values: Record<string, FieldValue>
  areas?: Record<string, AreaRun[]>
  /** 每个字段（可编辑区是 area:anchor）最后改在哪一版 */
  versions: Record<string, number>
  body: boolean
}
/** 服务端经事件流推来的事件 */
export type CollabEvent =
  | { type: 'hello'; conn: string; userId: string; name: string; version: number; status: string; lock: CollabLock | null; changes?: CollabChanges }
  | { type: 'presence'; viewers: CollabViewer[] }
  /** 别人保存了字段值、可编辑区（只有你能看到的字段） */
  | { type: 'fields'; version: number; values: Record<string, FieldValue>; areas?: Record<string, AreaRun[]>; by: CollabBy; conn?: string }
  /** 别人整份保存了正文（编辑模式） */
  | { type: 'doc'; version: number; by: CollabBy; conn?: string }
  | { type: 'lock'; lock: CollabLock | null }
  /** 别人请求编辑（只发给拿着编辑锁的那条连接） */
  | { type: 'lock-request'; from: CollabBy & { conn: string } }
  | { type: 'status'; status: string; version: number; by: CollabBy }
  | { type: 'comments'; by: CollabBy; conn?: string }
  /** 有签署方签了、拒签了（签名、签署日期写进了文档） */
  | { type: 'signing'; version: number; status: string; signer: string; action: 'sign' | 'reject'; by: CollabBy }

/**
 * 宿主函数：接上文档的事件流（多人编辑）。不给就没有多人编辑的功能。
 * 浏览器里用 @oe/web 的 sseCollab 就行（fetch 读服务端 GET /api/documents/{id}/events，令牌放请求头）
 */
export interface CollabConnector {
  /**
   * 连上事件流，断了自己重连；返回断开的函数。since：每次（重）连时取编辑器已经有的版本号，
   * 交给服务端（地址上的 since 参数，不是机密），服务端在 hello 里补发这之后的改动
   */
  connect(handlers: { event: (e: CollabEvent) => void; state?: (s: 'connecting' | 'open' | 'closed') => void; since?: () => number | undefined }): () => void
  /** 告诉别人自己在哪个字段（null：不在字段里） */
  presence?(field: string | null): Promise<void>
  /**
   * 正文编辑锁（编辑模式）：拿锁或续约、放锁（to：直接交给这条连接）、请求拿着锁的人交出来。
   * 不给就不用锁（一个人编辑；服务端在没人拿锁时也照旧收整份保存）
   */
  lock?(action: 'acquire' | 'release' | 'request', to?: string): Promise<{ ok: boolean; lock: CollabLock | null }>
  /** 取服务端最新的文档（别人保存了正文后重新装）；不给就不能自动刷新 */
  load?(): Promise<LoadedDocument & { version: number; status?: string }>
  /** 批注（不进文档、不进导出）；不给就没有批注 */
  comments?: CommentApi
  /** 版本历史（版本对比用）；不给就没有版本按钮 */
  revisions?: RevisionApi
}

/** 版本历史里的一版（服务端 GET /api/documents/{id}/revisions）。同一个人连着编辑只留最后一份 */
export interface RevisionItem {
  /** 文档的版本号（存这一版时的） */
  version: number
  /** create 建文档；edit 编辑；start、submit、reject、void：开始盖章、提交盖章、驳回、作废；sign：一个签署方签了（t12） */
  reason: 'create' | 'edit' | 'start' | 'submit' | 'reject' | 'void' | 'sign'
  operatorName: string | null
  at: string
}
/** 版本历史接口：服务端 GET /api/documents/{id}/revisions、…/revisions/{version} */
export interface RevisionApi {
  list(): Promise<RevisionItem[]>
  get(version: number): Promise<{ doc: DocData }>
}

/** 一条批注或回复（回复的 parentId 是最上面那条；引用只在最上面那条上） */
export interface CommentItem {
  id: string
  parentId: string | null
  /** 引用的原文和它是第几处（从 0 起）；不针对哪段文字的批注没有 */
  quote: string | null
  occurrence: number | null
  body: string
  authorId: string
  authorName: string
  resolved: boolean
  createdAt: string
  updatedAt: string
}
/** 批注接口：服务端 GET、POST /api/documents/{id}/comments，PATCH、DELETE …/comments/{cid} */
export interface CommentApi {
  list(): Promise<CommentItem[]>
  add(c: { body: string; quote?: string; occurrence?: number; parentId?: string }): Promise<CommentItem>
  update(id: string, patch: { resolved?: boolean; body?: string }): Promise<void>
  remove(id: string): Promise<void>
}

export interface EditorOptions {
  /** 打开时的模式 */
  mode: Mode
  /** 分段控件里显示哪些模式；只有一个时不显示分段控件 */
  modes?: Mode[]
  load: () => Promise<LoadedDocument>
  /** 保存；多人编辑时返回 SaveResult（版本号、冲突），一个人用时不用返回 */
  save: (payload: SavePayload) => Promise<void | SaveResult>
  /** 模板设计：编辑器先保存当前内容，再发布已保存的草稿。 */
  publish?: () => Promise<void>
  previewSamples?: PreviewSample[]
  /** 宿主注入的请求函数：远程数据源都走它 */
  request?: RequestFn
  /** 数据源定义，按字段的 dataSource.id 找；kind 为 host 的字段、找不到定义的字段走 search */
  dataSources?: Record<string, DataSourceDef>
  seals?: SealOption[]
  /** 宿主函数数据源 */
  search?: PickSearch
  /** 只读模式的「下载」和导出菜单；不传（或文档的 actions.download 为 false）就不显示 */
  download?: (format: 'pdf' | 'docx') => void | Promise<void>
  /** 盖章模式里每次放章、移章、删章（宿主转给服务端 POST /documents/{id}/seals）；不传就只改本地文档 */
  onSeal?: (op: SealOp) => Promise<void>
  /** 编辑模式「导入 Word」：宿主把文件交给服务端转换（POST /templates 传 docx，或渲染服务 /convert）；不传就没有这一项 */
  importDocx?: (file: File) => Promise<ImportResult>
  /** 有没保存的修改时，关闭或刷新页面前浏览器提醒；不传算开。宿主自己管离开提醒时传 false，用 EditorHandle.isDirty() 判断 */
  confirmLeave?: boolean
  /** 多人编辑：文档的事件流（在场、别人保存的字段和正文、编辑锁）；不传就是一个人用 */
  collab?: CollabConnector
  /** 签署：签署方和进度、签名板、确认签署、拒签、签署记录、验签；不传就是原来的盖章 */
  signing?: SigningApi
}

/** 导入 Word 的结果：服务端（渲染服务 /convert）转好的文档和导入报告 */
export interface ImportResult {
  doc: DocData
  report: {
    /** ok：保留了；fixed：补回了；lost：没保留 */
    items: { kind: string; level: 'ok' | 'fixed' | 'lost'; message: string; count?: number; sample?: string }[]
    textExact: boolean
  }
  pageCount?: number
}

/** 编辑器发给宿主的事件（EditorHandle.on；iframe 嵌入时转发给父页面） */
export interface EditorEvents {
  /** 编辑器装好了 */
  ready: undefined
  /** 用户改了内容（停 300 毫秒发一次） */
  change: undefined
  /** 字段值变了：用户填的、选的，宿主 setData 的都算 */
  'field-change': { key: string; value: FieldValue; previous: FieldValue }
  /** 保存（或提交、发布）成功；auto：多人编辑时的自动保存 */
  saved: { mode: Mode; published: boolean; auto?: boolean }
  'mode-change': Mode
  /** 有没有没保存的修改变了 */
  'dirty-change': boolean
  /** 光标进入、离开字段 */
  'field-focus': { key: string; label: string } | null
}

/** 打开文件、下载的格式（docs/设计/07 第 2 节） */
export type { ExportFormat, ImportFormat } from './files'

/** 一个签署方（服务端 GET /api/documents/{id}/signers 的 signers，docs/设计/08 第 5 节） */
export interface SignerItem {
  /** 角色 key，对应签名区、签署日期字段的 signer（a 甲方、b 乙方……） */
  key: string
  /** 角色名：甲方、乙方…… */
  role: string
  name: string
  kind: 'person' | 'org'
  /** 签署顺序，小的先签，一样的同时签 */
  order: number
  /** 签之前要不要意愿认证 */
  intentRequired: boolean
  status: 'waiting' | 'signed' | 'rejected'
  signedAt: string | null
  /** 意愿认证方式：sms、face、password、cert、other */
  intentMethod: string | null
  rejectReason: string | null
}
/** 签署进度（GET …/signers）：turn 是现在轮到的签署方，me 是这个令牌绑定的签署方 */
export interface SigningState {
  status: string
  deadline: string | null
  signers: SignerItem[]
  turn: string[]
  me: string | null
}
/** 证据链的一条（签署报告里） */
export interface EvidenceItem {
  seq: number
  /** signers、start、view、intent、sign、reject、revoke、void、complete */
  action: string
  signer: string | null
  operatorName: string
  ip: string | null
  userAgent: string | null
  docHash: string
  detail: Record<string, unknown>
  at: string
  hash: string
}
/** 签署报告（GET …/signing-report） */
export interface SigningReport {
  document: { id: string; title: string; status: string; version: number }
  signers: SignerItem[]
  evidence: EvidenceItem[]
  /** 证据链重算的结果：broken 是从第几条起对不上 */
  chain: { valid: boolean; broken: number | null; count: number; head: string | null }
  /** 最终文件（带数字签名的 PDF）；还没签完是 null */
  file: { version: number; sha256: string; size: number; pageCount: number; at: string; cert: { subject: string; serial: string; test: boolean } } | null
}
/** 验签结果（服务端 POST /api/verify） */
export interface VerifyResult {
  sha256: string
  signatures: { valid: boolean; coversWholeFile: boolean; signedAt: string | null; reason: string | null; testCert: boolean; cert: { subject: string; issuer: string; serial: string } | null; error?: string }[]
  /** 文件是这个系统出的最终文件时：哪份合同、哪一版、谁签的 */
  known: { documentId: string; title: string | null; version: number; signedAt: string; testCert: boolean; signers: { role: string; name: string; status: string; signedAt: string | null }[] } | null
}
/** 签完、拒签后服务端给的文档 */
export interface SigningResult {
  version: number
  status: string
  doc: DocData
  values: DocValues
}
/**
 * 签署（docs/设计/08 第 5 节）：宿主把服务端的签署接口接上（令牌放请求头）。盖章模式给了 sign，检查器里出签署进度、签名板、
 * 确认签署和拒签；给了 report，工具栏有「签署记录」（签署方、证据链、最终文件、验签）
 */
export interface SigningApi {
  /** 签署方和进度（GET …/signers） */
  state(): Promise<SigningState>
  /**
   * 意愿认证：宿主自己做（短信验证码、人脸、签署密码……），做完由宿主后端用 API Key 登记凭据（POST …/intents），
   * 返回凭据 id；用户取消返回 null。签署方不要求意愿认证时不调
   */
  confirmIntent?(signer: SignerItem): Promise<string | null>
  /** 确认签署（POST …/sign）：每个自己的签名区一张 PNG */
  sign?(req: { signatures: Record<string, string>; intent?: string }): Promise<SigningResult>
  /** 拒签（POST …/sign，action reject） */
  reject?(reason: string): Promise<SigningResult>
  report?(): Promise<SigningReport>
  /** 下载签好的 PDF（GET …/signed-file）、签署报告 PDF（GET …/signing-report?format=pdf） */
  download?(what: 'signed' | 'report'): Promise<void>
  /** 核对一份 PDF（宿主后端转给 POST /api/verify） */
  verify?(file: File): Promise<VerifyResult>
}
/** 盖章操作，字段和服务端 POST /documents/{id}/seals 的入参一致（版本号由宿主加） */
export type SealOp =
  | { action: 'place'; seal: { id: string; sealId: string; name: string; dataURL: string; pageNo: number; x: number; y: number; width: number; height: number } }
  | { action: 'move'; id: string; pageNo: number; x: number; y: number }
  | { action: 'remove'; id: string }
