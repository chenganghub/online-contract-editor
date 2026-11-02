import { describe, expect, it } from 'vitest'
import type { FieldDef } from '@oe/core'
import { createSearch } from './datasource'
import type { RequestFn } from './types'

const field = (id: string, kind: 'static' | 'remote' | 'host' = 'remote'): FieldDef => ({ key: 'partyA', label: '甲方', type: 'picker', dataSource: { id, kind } })

describe('createSearch', () => {
  it('远程：经 request 调接口，参数是关键字、页码（从 1 起）、条数；按配置的路径取列表和总数', async () => {
    const calls: Parameters<RequestFn>[0][] = []
    const request: RequestFn = async (req) => {
      calls.push(req)
      return { data: { rows: [{ cid: 7, name: '甲公司', addr: '上海' }], count: 11 } }
    }
    const search = createSearch({ request, dataSources: { c: { kind: 'remote', url: '/api/c', list: 'data.rows', total: 'data.count', id: 'cid', title: 'name', subtitle: 'addr', pageSize: 5, params: { query: 'kw' } } } })
    const r = await search(field('c'), '甲', 1)
    expect(calls).toEqual([{ url: '/api/c', method: 'GET', query: { kw: '甲', page: 2, size: 5 } }])
    expect(r).toEqual({ items: [{ id: '7', title: '甲公司', subtitle: '上海', record: { cid: 7, name: '甲公司', addr: '上海' } }], total: 11, pageSize: 5 })
  })

  it('远程 POST：参数放请求体；返回结构不对时是空列表', async () => {
    const calls: Parameters<RequestFn>[0][] = []
    const search = createSearch({
      request: async (req) => (calls.push(req), { oops: true }),
      dataSources: { c: { kind: 'remote', url: '/api/c', method: 'POST', list: 'data.list', total: 'data.total', id: 'id', title: 'name' } },
    })
    expect(await search(field('c'), '', 0)).toEqual({ items: [], total: 0, pageSize: 5 })
    expect(calls[0]).toEqual({ url: '/api/c', method: 'POST', body: { q: '', page: 1, size: 5 } })
  })

  it('远程但宿主没注入 request：报错，不自己去请求', async () => {
    const search = createSearch({ dataSources: { c: { kind: 'remote', url: '/api/c', list: 'l', total: 't', id: 'id', title: 'name' } } })
    await expect(search(field('c'), '', 0)).rejects.toThrow('没有注入 request')
  })

  it('固定记录：按标题和副标题过滤、分页', async () => {
    const items = Array.from({ length: 7 }, (_, i) => ({ id: `s${i}`, title: `供应商${i}`, subtitle: i % 2 ? '江苏' : '浙江', record: {} }))
    const search = createSearch({ dataSources: { s: { kind: 'static', items, pageSize: 3 } } })
    expect((await search(field('s', 'static'), '', 2)).items.map((x) => x.id)).toEqual(['s6'])
    const r = await search(field('s', 'static'), '江苏', 0)
    expect(r.total).toBe(3)
    expect(r.items.map((x) => x.id)).toEqual(['s1', 's3', 's5'])
  })

  it('宿主函数数据源和没有定义的数据源走宿主的 search；都没有时是空列表', async () => {
    const search = createSearch({ search: async () => ({ items: [{ id: 'h', title: '宿主', record: {} }], total: 1, pageSize: 5 }) })
    expect((await search(field('x', 'host'), '', 0)).items[0]!.id).toBe('h')
    expect((await search(field('nope'), '', 0)).items[0]!.id).toBe('h')
    expect(await createSearch({})(field('nope'), '', 0)).toEqual({ items: [], total: 0, pageSize: 5 })
  })
})
