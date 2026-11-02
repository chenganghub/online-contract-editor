// 数据源（方案 4.5）：固定记录、远程接口、宿主函数。远程请求一律走宿主注入的 request，编辑器自己不调 fetch。
import type { DataSourceDef, PickItem, PickSearch, RequestFn } from './types'

const DEFAULT_PAGE_SIZE = 5

/** 按点号路径取值：at({ data: { list: [] } }, 'data.list') */
function at(obj: unknown, path: string): unknown {
  let cur = obj
  for (const k of path.split('.').filter(Boolean)) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[k]
  }
  return cur
}

function searchStatic(def: Extract<DataSourceDef, { kind: 'static' }>, query: string, page: number) {
  const pageSize = def.pageSize ?? DEFAULT_PAGE_SIZE
  const q = query.toLowerCase()
  const list = q ? def.items.filter((it) => `${it.title} ${it.subtitle ?? ''}`.toLowerCase().includes(q)) : def.items
  return { items: list.slice(page * pageSize, (page + 1) * pageSize), total: list.length, pageSize }
}

async function searchRemote(def: Extract<DataSourceDef, { kind: 'remote' }>, request: RequestFn, query: string, page: number) {
  const pageSize = def.pageSize ?? DEFAULT_PAGE_SIZE
  const p = { query: 'q', page: 'page', size: 'size', ...def.params }
  const args = { [p.query]: query, [p.page]: page + 1, [p.size]: pageSize }
  const method = def.method ?? 'GET'
  const res = await request(method === 'GET' ? { url: def.url, method, query: args } : { url: def.url, method, body: args })
  const raw = at(res, def.list)
  const list = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : []
  const items: PickItem[] = list.map((r) => ({
    id: String(r[def.id] ?? ''),
    title: String(r[def.title] ?? ''),
    ...(def.subtitle && r[def.subtitle] !== undefined ? { subtitle: String(r[def.subtitle]) } : {}),
    record: r,
  }))
  const total = Number(at(res, def.total))
  return { items, total: Number.isFinite(total) ? total : items.length, pageSize }
}

/** 按字段的数据源找搜索函数：有定义的走定义（远程的经 request），宿主函数数据源和没定义的走宿主的 search */
export function createSearch(opts: { request?: RequestFn; dataSources?: Record<string, DataSourceDef>; search?: PickSearch }): PickSearch {
  return async (field, query, page) => {
    const ref = field.dataSource
    const def = ref && ref.kind !== 'host' ? opts.dataSources?.[ref.id] : undefined
    if (def?.kind === 'static') return searchStatic(def, query, page)
    if (def?.kind === 'remote') {
      if (!opts.request) throw new Error(`数据源 ${ref!.id} 是远程接口，宿主没有注入 request`)
      return searchRemote(def, opts.request, query, page)
    }
    if (opts.search) return opts.search(field, query, page)
    return { items: [], total: 0, pageSize: DEFAULT_PAGE_SIZE }
  }
}
