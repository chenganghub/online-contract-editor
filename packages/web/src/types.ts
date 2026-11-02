import type { AreaRun, DocData, DocValues, FieldDef, Mode, Permission } from '@oe/core'

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
  fields: FieldDef[]
  /** 模板设计可插入的宿主字段库；已使用的字段仍以 fields 快照为准。 */
  libraryFields?: FieldDef[]
  title?: string
  permissions?: Record<string, Permission>
  actions?: DocActions
}

export interface EditorOptions {
  /** 打开时的模式 */
  mode: Mode
  /** 分段控件里显示哪些模式；只有一个时不显示分段控件 */
  modes?: Mode[]
  load: () => Promise<LoadedDocument>
  save: (payload: SavePayload) => Promise<void>
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

/** 盖章操作，字段和服务端 POST /documents/{id}/seals 的入参一致（版本号由宿主加） */
export type SealOp =
  | { action: 'place'; seal: { id: string; sealId: string; name: string; dataURL: string; pageNo: number; x: number; y: number; width: number; height: number } }
  | { action: 'move'; id: string; pageNo: number; x: number; y: number }
  | { action: 'remove'; id: string }
