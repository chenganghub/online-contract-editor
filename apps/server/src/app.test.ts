// 接口测试：用 mysql-memory-server 起临时 MySQL 8（第一次会下载 MySQL，之后用缓存），app.inject 直接调路由
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDB } from 'mysql-memory-server'
import type { FastifyInstance } from 'fastify'
import { buildApp, type AppDeps } from './app'
import { HttpError } from './errors'
import type { RenderRequest, RendererClient } from './renderer'
import { openDb } from './db/client'
import { eq } from 'drizzle-orm'
import { apiClient, operationLog } from './db/schema'
import { localFileStore } from './storage'
import { hashKey } from './tokens'

const KEY = 'test-host-key'
const doc = {
  main: [
    { value: '甲方：' },
    { type: 'control', value: '', control: { type: 'text', value: [], conceptId: 'partyA', prefix: '', postfix: '' } },
    { value: '\n付款方式：' },
    { type: 'control', value: '', control: { type: 'select', value: [], code: null, conceptId: 'payMethod', valueSets: [{ value: '分期付款', code: 'stage' }], prefix: '', postfix: '' } },
    { value: '\n金额：' },
    { type: 'control', value: '', control: { type: 'text', value: [], conceptId: 'amount', prefix: '', postfix: '' } },
  ],
}
const fields = [
  { key: 'partyA', label: '甲方', type: 'text' },
  { key: 'payMethod', label: '付款方式', type: 'select', options: [{ value: '分期付款', code: 'stage' }] },
  { key: 'amount', label: '金额', type: 'amount' },
]

// 假的渲染服务：记下收到的请求；真的渲染服务在 apps/renderer 和 e2e/render 里测
const rendered: RenderRequest[] = []
const fakeRenderer: RendererClient = {
  async render(req) {
    rendered.push(req)
    if (req.expectedPages === 99) throw new HttpError(409, 'PAGE_COUNT_MISMATCH', '渲染出 2 页，和编辑器保存时的 99 页不一致', { expected: 99, actual: 2 })
    return { pageCount: 2, pdf: Buffer.from('%PDF-1.7 fake'), docx: Buffer.from('PK fake') }
  },
  async convert(docx) {
    return { doc: { main: [{ value: `导入：${docx.toString()}` }] } as never, report: { items: [{ kind: 'text', level: 'ok' }], textExact: true }, pageCount: 1 }
  },
}
let app: FastifyInstance
let database: Awaited<ReturnType<typeof openDb>>['db']
let stop: () => Promise<void>
const hooks: NonNullable<AppDeps['hooks']> = {}
const host = { authorization: `Bearer ${KEY}` }

beforeAll(async () => {
  const mysql = await createDB({ version: '8.4.x' })
  const { db, close } = await openDb(`mysql://${mysql.username}@127.0.0.1:${mysql.port}/${mysql.dbName}`)
  database = db
  await db.insert(apiClient).values({ id: crypto.randomUUID(), name: '测试宿主', keyHash: hashKey(KEY) })
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'oe-storage-'))
  const config = { DATABASE_URL: 'mysql://x', PORT: 0, HOST: '127.0.0.1', STORAGE_DIR: storage, TOKEN_SECRET: 'x'.repeat(32), TOKEN_TTL_SECONDS: 1800, RENDERER_URL: 'http://127.0.0.1:1', RENDER_TIMEOUT_MS: 1000 }
  app = await buildApp({ config, db, store: localFileStore(storage), hooks, renderer: fakeRenderer })
  stop = async () => {
    await app.close()
    await close()
    await mysql.stop()
    fs.rmSync(storage, { recursive: true, force: true })
  }
}, 180_000)
afterAll(() => stop?.(), 60_000)

const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, headers: Record<string, string> = {}, payload?: unknown) =>
  app.inject({ method, url, headers, payload: payload as object | undefined })

async function newDocument(values: Record<string, unknown> = {}, body: unknown = doc) {
  const t = await call('POST', '/api/templates', host, { name: '采购合同', doc: body, fields })
  expect(t.statusCode).toBe(200)
  const d = await call('POST', '/api/documents', host, { templateId: t.json().id, versionNo: 1, values })
  expect(d.statusCode, d.body).toBe(200)
  return d.json().id as string
}
async function newToken(documentId: string, mode: string, permissions: Record<string, string> = {}, ttlSeconds?: number) {
  const r = await call('POST', '/api/tokens', host, { documentId, mode, userId: 'u1', permissions, ttlSeconds })
  expect(r.statusCode, r.body).toBe(200)
  return r.json() as { id: string; token: string }
}

describe('宿主字典快照', () => {
  it('新合同读取新增选项，已有合同和发布模板不变，填写仍严格校验 code', async () => {
    const definitions = fields.map((f) => f.key === 'payMethod' ? { ...f, dataSource: { id: 'payment-method', kind: 'dict' } } : f)
    const t = await call('POST', '/api/templates', host, { name: '字典合同', doc, fields: definitions })
    expect(t.statusCode, t.body).toBe(200)
    const base = { templateId: t.json().id, versionNo: 1 }
    const original = (await call('GET', `/api/templates/${base.templateId}/versions/1`, host)).json()
    const old = await call('POST', '/api/documents', host, base)
    expect(old.statusCode).toBe(200)
    const options = [{ code: 'stage', value: '分期付款' }, { code: 'credit', value: '赊销付款' }]
    const fresh = await call('POST', '/api/documents', host, { ...base, dictionaries: { 'payment-method': options } })
    expect(fresh.statusCode, fresh.body).toBe(200)
    const freshDoc = (await call('GET', `/api/documents/${fresh.json().id}`, host)).json()
    expect(freshDoc.fields.find((f: { key: string }) => f.key === 'payMethod').options).toEqual(options)
    expect(freshDoc.doc.main.find((e: { control?: { conceptId: string } }) => e.control?.conceptId === 'payMethod').control.valueSets).toEqual(options)
    const token = await newToken(fresh.json().id, 'fill')
    const filled = await call('PATCH', `/api/documents/${fresh.json().id}/data`, { 'x-document-token': token.token }, { version: 1, patch: { payMethod: 'credit' } })
    expect(filled.statusCode, filled.body).toBe(200)
    expect((await call('GET', `/api/documents/${fresh.json().id}`, host)).json().values.values.payMethod).toBe('credit')
    const invalid = await call('PATCH', `/api/documents/${fresh.json().id}/data`, { 'x-document-token': token.token }, { version: 2, patch: { payMethod: 'unknown' } })
    expect(invalid.statusCode).toBe(400)
    const oldDoc = (await call('GET', `/api/documents/${old.json().id}`, host)).json()
    expect(oldDoc.fields).toEqual(definitions)
    expect((await call('GET', `/api/templates/${base.templateId}/versions/1`, host)).json()).toEqual(original)
    for (const dictionaries of [{ unknown: options }, { 'payment-method': [...options, options[0]] }, { 'payment-method': [] }]) {
      expect((await call('POST', '/api/documents', host, { ...base, dictionaries })).statusCode).toBe(400)
    }
    expect((await call('POST', '/api/documents', {}, { ...base, dictionaries: { 'payment-method': options } })).statusCode).toBe(401)
  })
})

describe('模板设计草稿', () => {
  async function createDraft() {
    const r = await call('POST', '/api/templates/drafts', host, { name: '财务设计模板', createdBy: 'finance', doc, fields })
    expect(r.statusCode, r.body).toBe(200)
    return r.json().id as string
  }

  it('保存使用乐观版本锁；发布冻结快照，不让草稿修改影响合同', async () => {
    const id = await createDraft()
    const base = `/api/templates/${id}`
    expect((await call('POST', '/api/documents', host, { templateId: id, versionNo: 1 })).statusCode).toBe(404)
    const updated = { doc: { main: [{ value: '新版条款' }] }, fields: [{ key: 'note', label: '备注', type: 'text' }], version: 1 }
    const race = await Promise.all([call('PUT', `${base}/draft`, host, updated), call('PUT', `${base}/draft`, host, updated)])
    expect(race.map((r) => r.statusCode).sort()).toEqual([200, 409])
    expect((await call('POST', `${base}/draft/publish`, host, { version: 1 })).statusCode).toBe(409)
    const published = await call('POST', `${base}/draft/publish`, host, { version: 2 })
    expect(published.json()).toMatchObject({ version: 3, versionNo: 1 })
    const contract = await call('POST', '/api/documents', host, { templateId: id, versionNo: 1 })
    expect(contract.statusCode, contract.body).toBe(200)
    expect((await call('PUT', `${base}/draft`, host, { doc, fields, version: 3 })).statusCode).toBe(200)
    const snapshot = (await call('GET', `${base}/versions/1`, host)).json()
    expect(snapshot.doc).toEqual(updated.doc)
    expect(snapshot.fields).toEqual(updated.fields)
    const stored = (await call('GET', `/api/documents/${contract.json().id}`, host)).json()
    expect(stored.fields).toEqual(updated.fields)
    expect((await call('POST', `${base}/draft/publish`, host, { version: 4 })).json()).toMatchObject({ versionNo: 2, version: 5 })
  })

  it('模板令牌限于指定草稿；不能读合同、字段库或签发令牌，吊销立即生效', async () => {
    const id = await createDraft()
    const base = `/api/templates/${id}`
    const issued = await call('POST', `${base}/edit-tokens`, host, { userId: 'finance' })
    expect(issued.statusCode, issued.body).toBe(200)
    const th = { 'x-template-token': issued.json().token as string }
    const draft = await call('GET', `${base}/draft`, th)
    expect(draft.statusCode, draft.body).toBe(200)
    expect(draft.json()).toMatchObject({ title: '财务设计模板', fields, libraryFields: expect.any(Array) })
    expect((await call('PUT', `${base}/draft`, th, { doc, fields, version: 1 })).statusCode).toBe(200)
    expect((await call('POST', `${base}/draft/publish`, th, { version: 2 })).statusCode).toBe(200)
    const otherId = await createDraft()
    expect((await call('GET', `/api/templates/${otherId}/draft`, th)).statusCode).toBe(403)
    expect((await call('GET', `${base}/draft?token=${issued.json().token}`)).statusCode).toBe(401)
    expect((await call('GET', '/api/field-library', th)).statusCode).toBe(401)
    expect((await call('POST', `${base}/edit-tokens`, th, { userId: 'other' })).statusCode).toBe(401)
    const contractId = await newDocument()
    expect((await call('GET', `/api/documents/${contractId}`, { 'x-document-token': issued.json().token })).json().code).toBe('TOKEN_SCOPE')
    const documentToken = await newToken(contractId, 'edit')
    expect((await call('GET', `${base}/draft`, { 'x-template-token': documentToken.token })).statusCode).toBe(403)
    expect((await call('DELETE', `${base}/edit-tokens/${issued.json().id}`, host)).statusCode).toBe(200)
    expect((await call('GET', `${base}/draft`, th)).statusCode).toBe(401)
    expect((await call('PUT', `${base}/draft`, th, { doc, fields, version: 3 })).statusCode).toBe(401)
  })

  it('草稿跨宿主拒绝，旧发布/读取/渲染接口也不能绕过；非法字段整次拒绝', async () => {
    const id = await createDraft()
    const key = crypto.randomUUID()
    await database.insert(apiClient).values({ id: crypto.randomUUID(), name: '其他宿主', keyHash: hashKey(key) })
    const other = { authorization: `Bearer ${key}` }
    const base = `/api/templates/${id}`
    for (const r of [
      await call('GET', `${base}/draft`, other),
      await call('PUT', `${base}/draft`, other, { doc, fields, version: 1 }),
      await call('POST', `${base}/draft/publish`, other, { version: 1 }),
      await call('POST', `${base}/edit-tokens`, other, { userId: 'intruder' }),
      await call('POST', `${base}/versions`, other, { doc, fields }),
      await call('GET', `${base}/versions/1`, other),
      await call('POST', '/api/documents', other, { templateId: id, versionNo: 1 }),
      await call('POST', '/api/render', other, { templateId: id, versionNo: 1 }),
    ]) expect(r.statusCode, r.body).toBe(403)
    for (const bad of [[fields[0], fields[0]], [{ key: 'x', label: '计算', type: 'computed', computed: { from: 'missing', fn: 'amountCN' } }]]) {
      expect((await call('PUT', `${base}/draft`, host, { doc, fields: bad, version: 1 })).statusCode).toBe(400)
    }
    expect((await call('GET', `${base}/draft`, host)).json().version).toBe(1)
  })
})

describe('鉴权', () => {
  it('健康检查', async () => {
    expect((await call('GET', '/api/health')).json()).toEqual({ ok: true })
  })

  it('API Key 缺失或错误 401', async () => {
    expect((await call('POST', '/api/templates', {}, { name: 'x', doc, fields })).statusCode).toBe(401)
    expect((await call('POST', '/api/templates', { authorization: 'Bearer wrong' }, { name: 'x', doc, fields })).statusCode).toBe(401)
  })

  it('令牌只认请求头：放在 URL 里不生效', async () => {
    const id = await newDocument()
    const { token } = await newToken(id, 'view')
    expect((await call('GET', `/api/documents/${id}?token=${token}`)).statusCode).toBe(401)
    expect((await call('GET', `/api/documents/${id}`, { 'x-document-token': token })).statusCode).toBe(200)
  })

  it('令牌换文档 id 403、过期 401、吊销 401', async () => {
    const a = await newDocument()
    const b = await newDocument()
    const { token, id: tid } = await newToken(a, 'view')
    expect((await call('GET', `/api/documents/${b}`, { 'x-document-token': token })).json().code).toBe('TOKEN_DOCUMENT_MISMATCH')
    const short = await newToken(a, 'view', {}, 1)
    await new Promise((r) => setTimeout(r, 1200))
    expect((await call('GET', `/api/documents/${a}`, { 'x-document-token': short.token })).json().code).toBe('TOKEN_EXPIRED')
    expect((await call('DELETE', `/api/tokens/${tid}`, host)).statusCode).toBe(200)
    expect((await call('GET', `/api/documents/${a}`, { 'x-document-token': token })).json().code).toBe('TOKEN_REVOKED')
    const forged = token.slice(0, -2) + (token.endsWith('A') ? 'BB' : 'AA')
    expect((await call('GET', `/api/documents/${a}`, { 'x-document-token': forged })).json().code).toBe('TOKEN_INVALID')
  })
})

describe('模板和文档', () => {
  it('发布后的版本不能改：没有修改接口，再发一版版本号加 1', async () => {
    const t = (await call('POST', '/api/templates', host, { name: '采购合同', doc, fields })).json()
    expect((await call('PUT', `/api/templates/${t.id}/versions/1`, host, { doc, fields })).statusCode).toBe(404)
    const v2 = await call('POST', `/api/templates/${t.id}/versions`, host, { doc, fields })
    expect(v2.json().versionNo).toBe(2)
    const got = await call('GET', `/api/templates/${t.id}/versions/1`, host)
    expect(got.json().versionNo).toBe(1)
  })

  it('建文档时写初始数据；隐藏字段的值不下发（验收 5 服务端部分）', async () => {
    const id = await newDocument({ partyA: '某某科技', payMethod: 'stage' })
    const { token } = await newToken(id, 'fill', { partyA: 'hidden' })
    const r = (await call('GET', `/api/documents/${id}`, { 'x-document-token': token })).json()
    expect(r.values.values.partyA).toBeUndefined()
    expect(JSON.stringify(r.doc)).not.toContain('某某科技')
    expect(r.values.values.payMethod).toBe('stage')
    const full = (await call('GET', `/api/documents/${id}`, host)).json()
    expect(JSON.stringify(full.doc)).toContain('某某科技')
  })

  it('PUT 版本号不对 409；填写模式不能 PUT 整份文档 403', async () => {
    const id = await newDocument()
    const edit = await newToken(id, 'edit')
    const ok = await call('PUT', `/api/documents/${id}`, { 'x-document-token': edit.token }, { doc, version: 1 })
    expect(ok.statusCode, ok.body).toBe(200)
    const stale = await call('PUT', `/api/documents/${id}`, { 'x-document-token': edit.token }, { doc, version: 1 })
    expect(stale.statusCode).toBe(409)
    const fill = await newToken(id, 'fill')
    expect((await call('PUT', `/api/documents/${id}`, { 'x-document-token': fill.token }, { doc, version: 2 })).statusCode).toBe(403)
    // 编辑令牌有隐藏字段：拿到的文档里隐藏值被清空了，整份存回去会丢值，拒绝
    const hidden = await newToken(id, 'edit', { amount: 'hidden' })
    const r = await call('PUT', `/api/documents/${id}`, { 'x-document-token': hidden.token }, { doc, version: 2 })
    expect(r.statusCode).toBe(403)
    expect(r.json().code).toBe('HIDDEN_FIELDS')
  })

  it('填写保存：只读字段被改整次 403；可编辑字段写进文档和数据，版本加 1', async () => {
    const id = await newDocument()
    const { token } = await newToken(id, 'fill', { payMethod: 'readonly' })
    const denied = await call('PATCH', `/api/documents/${id}/data`, { 'x-document-token': token }, { patch: { partyA: 'x', payMethod: 'stage' }, version: 1 })
    expect(denied.statusCode).toBe(403)
    expect(denied.json().code).toBe('PERMISSION_DENIED')
    const ok = await call('PATCH', `/api/documents/${id}/data`, { 'x-document-token': token }, { patch: { partyA: '某某科技' }, version: 1 })
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json()).toMatchObject({ version: 2, values: { values: { partyA: '某某科技' } } })
  })

  it('填写保存可编辑区：只改标成可编辑区的；别的区域 403、不存在的 404，整次不生效（验收 4）', async () => {
    const area = (anchor: string, text: string, editable?: boolean) => ({ type: 'area', value: '', area: { extension: { anchor, ...(editable ? { editable } : {}) } }, valueList: [{ value: text }] })
    const id = await newDocument({}, { main: [...doc.main, { value: '\n' }, area('extra', '补充条款：无', true), { value: '\n' }, area('fixed', '固定条款')] })
    const t = { 'x-document-token': (await newToken(id, 'fill')).token }
    const ok = await call('PATCH', `/api/documents/${id}/data`, t, { patch: { partyA: '某某科技' }, areas: { extra: '补充条款：甲方负责卸货。' }, version: 1 })
    expect(ok.statusCode, ok.body).toBe(200)
    const anchorOf = (d: { main: { area?: { extension?: { anchor?: string } }; valueList?: unknown }[] }, a: string) => d.main.find((e) => e.area?.extension?.anchor === a)?.valueList
    let got = (await call('GET', `/api/documents/${id}`, host)).json()
    expect(anchorOf(got.doc, 'extra')).toEqual([{ value: '补充条款：甲方负责卸货。' }])
    expect(got.values.values.partyA).toBe('某某科技')
    const denied = await call('PATCH', `/api/documents/${id}/data`, t, { patch: { partyA: '别的公司' }, areas: { fixed: '改掉固定条款' }, version: 2 })
    expect(denied.statusCode).toBe(403)
    expect(denied.json()).toMatchObject({ code: 'PERMISSION_DENIED', area: 'fixed' })
    expect((await call('PATCH', `/api/documents/${id}/data`, t, { patch: {}, areas: { nope: 'x' }, version: 2 })).statusCode).toBe(404)
    got = (await call('GET', `/api/documents/${id}`, host)).json()
    expect(got.version).toBe(2)
    expect(got.values.values.partyA).toBe('某某科技')
    expect(anchorOf(got.doc, 'fixed')).toEqual([{ value: '固定条款' }])
    // 编辑器提交的是一组带样式的文字：样式留下，不认的属性丢掉；不是文字的整次拒绝
    const runs = await call('PATCH', `/api/documents/${id}/data`, t, { patch: {}, areas: { extra: [{ value: '补充条款：', bold: true, controlId: 'x' }, { value: '甲方负责卸货。' }] }, version: 2 })
    expect(runs.statusCode, runs.body).toBe(200)
    got = (await call('GET', `/api/documents/${id}`, host)).json()
    expect(anchorOf(got.doc, 'extra')).toEqual([{ value: '补充条款：', bold: true }, { value: '甲方负责卸货。' }])
    expect((await call('PATCH', `/api/documents/${id}/data`, t, { patch: {}, areas: { extra: [{ value: '', type: 'image' }] }, version: 3 })).statusCode).toBe(400)
  })

  it('保存在途时权限被改：整次拒绝 403，不按旧权限写入（方案第 12 节第 2 轮第 2 条）', async () => {
    const id = await newDocument()
    const t = await newToken(id, 'fill')
    // 鉴权通过之后、进事务之前，宿主把 partyA 改成只读
    hooks.afterAuth = async () => {
      hooks.afterAuth = undefined
      const r = await call('PUT', `/api/tokens/${t.id}`, host, { permissions: { partyA: 'readonly' } })
      expect(r.statusCode).toBe(200)
    }
    const r = await call('PATCH', `/api/documents/${id}/data`, { 'x-document-token': t.token }, { patch: { partyA: 'x' }, version: 1 })
    expect(r.statusCode).toBe(403)
    expect(r.json().code).toBe('PERMISSION_CHANGED')
    const after = (await call('GET', `/api/documents/${id}`, host)).json()
    expect(after.version).toBe(1)
    expect(after.values.values.partyA).toBeUndefined()
  })
})

describe('盖章（验收 11 的服务端部分）', () => {
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='
  const seal = (id: string) => ({ id, sealId: 'contract', name: '合同专用章', dataURL: PNG, pageNo: 0, x: 420.4, y: 600, width: 151, height: 151 })
  const status = (id: string, headers: Record<string, string>, action: string, version: number) => call('POST', `/api/documents/${id}/seal-status`, headers, { action, version })
  const seals = (id: string, headers: Record<string, string>, payload: unknown) => call('POST', `/api/documents/${id}/seals`, headers, payload)
  const sealImages = (d: { main: { type?: string; id?: string; extension?: { seal?: unknown } }[] }) => d.main.filter((e) => e.type === 'image' && e.extension?.seal)

  it('开始盖章后正文和字段都改不了；放章按 id 去重；记录有操作人、时间、印章、页码、坐标；提交后不能再放', async () => {
    const id = await newDocument()
    const sealer = await newToken(id, 'seal')
    const sh = { 'x-document-token': sealer.token }
    // 还在填写中：不能放章；令牌不能开始盖章
    expect((await seals(id, sh, { action: 'place', version: 1, seal: seal('seal-a') })).json().code).toBe('INVALID_STATUS')
    expect((await status(id, sh, 'start', 1)).statusCode).toBe(403)
    const started = await status(id, host, 'start', 1)
    expect(started.statusCode, started.body).toBe(200)
    expect(started.json()).toMatchObject({ status: 'sealing', version: 2 })
    // 正文锁定：编辑、填写都被拒
    const edit = await newToken(id, 'edit')
    expect((await call('PUT', `/api/documents/${id}`, { 'x-document-token': edit.token }, { doc, version: 2 })).json().code).toBe('INVALID_STATUS')
    expect((await call('PATCH', `/api/documents/${id}/data`, host, { patch: { partyA: 'x' }, version: 2 })).json().code).toBe('INVALID_STATUS')
    // 放章；同一个 id 再放一次（双击）只生效一次，版本号不变
    const placed = await seals(id, sh, { action: 'place', version: 2, seal: seal('seal-a') })
    expect(placed.statusCode, placed.body).toBe(200)
    expect(placed.json()).toMatchObject({ version: 3, seals: [{ id: 'seal-a', sealId: 'contract', sealName: '合同专用章', pageNo: 0, x: 420, y: 600, operator: 'u1' }] })
    const again = await seals(id, sh, { action: 'place', version: 2, seal: seal('seal-a') })
    expect(again.json()).toMatchObject({ version: 3, duplicate: true })
    // 版本号不对 409；填写模式的令牌不能放章
    expect((await seals(id, sh, { action: 'place', version: 2, seal: seal('seal-b') })).statusCode).toBe(409)
    const filler = await newToken(id, 'fill')
    expect((await seals(id, { 'x-document-token': filler.token }, { action: 'place', version: 3, seal: seal('seal-b') })).statusCode).toBe(403)
    // 移章：记录和文档里的坐标都变
    const moved = await seals(id, sh, { action: 'move', version: 3, id: 'seal-a', pageNo: 1, x: 100, y: 200 })
    expect(moved.statusCode, moved.body).toBe(200)
    const got = (await call('GET', `/api/documents/${id}`, host)).json()
    expect(got.seals).toMatchObject([{ id: 'seal-a', pageNo: 1, x: 100, y: 200, operator: 'u1' }])
    expect(new Date(got.seals[0].at).getTime()).toBeGreaterThan(Date.now() - 60_000)
    expect(sealImages(got.doc)).toMatchObject([{ id: 'seal-a', imgFloatPosition: { pageNo: 1, x: 100, y: 200 }, extension: { seal: { sealId: 'contract', name: '合同专用章' } } }])
    // 提交盖章：已盖章后不能再放章
    expect((await status(id, sh, 'submit', 4)).json()).toMatchObject({ status: 'sealed', version: 5 })
    expect((await seals(id, sh, { action: 'place', version: 5, seal: seal('seal-c') })).json().code).toBe('INVALID_STATUS')
    // 别的文档用过的印章 id 不能用（印章 id 是全局主键）
    const other = await newDocument()
    await status(other, host, 'start', 1)
    expect((await seals(other, host, { action: 'place', version: 2, seal: seal('seal-a') })).json().code).toBe('SEAL_ID_TAKEN')
  })

  it('驳回：已盖的章作废并从文档里移除，回到填写中；驳回前发出的放章请求失败', async () => {
    const id = await newDocument()
    const sh = { 'x-document-token': (await newToken(id, 'seal')).token }
    await status(id, host, 'start', 1)
    await seals(id, sh, { action: 'place', version: 2, seal: seal('seal-x') })
    await seals(id, sh, { action: 'place', version: 3, seal: seal('seal-y') })
    const rejected = await status(id, host, 'reject', 4)
    expect(rejected.statusCode, rejected.body).toBe(200)
    expect(rejected.json()).toMatchObject({ status: 'filling', version: 5, voided: 2 })
    const got = (await call('GET', `/api/documents/${id}`, host)).json()
    expect(got.seals).toEqual([])
    expect(sealImages(got.doc)).toEqual([])
    // 驳回前就发出的请求（带着旧版本号）、已作废的章再放，都失败
    expect((await seals(id, sh, { action: 'place', version: 4, seal: seal('seal-z') })).statusCode).toBe(422)
    await status(id, host, 'start', 5)
    expect((await seals(id, sh, { action: 'place', version: 6, seal: seal('seal-x') })).json().code).toBe('SEAL_VOID')
    // 回到填写中以后正文能改（这里改字段）
    await status(id, host, 'reject', 6)
    expect((await call('PATCH', `/api/documents/${id}/data`, host, { patch: { partyA: '某某' }, version: 7 })).statusCode).toBe(200)
  })

  it('作废：任意状态都能作废，作废后什么都不能做；状态不对 422', async () => {
    const id = await newDocument()
    expect((await status(id, host, 'submit', 1)).json().code).toBe('INVALID_STATUS')
    expect((await status(id, host, 'void', 1)).json()).toMatchObject({ status: 'void', version: 2 })
    expect((await status(id, host, 'start', 2)).json().code).toBe('INVALID_STATUS')
    expect((await call('PATCH', `/api/documents/${id}/data`, host, { patch: { partyA: 'x' }, version: 2 })).json().code).toBe('INVALID_STATUS')
  })
})

describe('批量操作和操作日志（验收 13、14）', () => {
  const contract = { main: [...doc.main, { value: '\n第五条　争议解决：因本合同引起的争议，双方协商解决。' }] }
  const ops = (id: string, headers: Record<string, string>, payload: unknown) => call('POST', `/api/documents/${id}/operations`, headers, payload)
  const logs = (id: string) => database.select().from(operationLog).where(eq(operationLog.documentId, id))
  const textOf = (d: { main: { value?: string; control?: { value?: { value: string }[] } }[] }) => d.main.map((e) => e.value || (e.control?.value ?? []).map((v) => v.value).join('')).join('')

  it('一批 3 个操作第 2 个找不到位置：整批不生效，返回第 2 条的错误；失败也记日志', async () => {
    const id = await newDocument({}, contract)
    const r = await ops(id, host, {
      version: 1,
      ops: [
        { op: 'setData', values: { partyA: '某某科技' } },
        { op: 'setText', target: { text: '文档里没有这段' }, text: 'x' },
        { op: 'setData', values: { amount: '1000' } },
      ],
    })
    expect(r.statusCode).toBe(422)
    expect(r.json()).toMatchObject({ code: 'TARGET_NOT_FOUND', index: 1 })
    const got = (await call('GET', `/api/documents/${id}`, host)).json()
    expect(got.version).toBe(1)
    expect(got.values.values.partyA).toBeUndefined()
    expect((await logs(id)).map((l) => l.result)).toEqual([{ ok: false, index: 1, code: 'TARGET_NOT_FOUND', error: expect.stringContaining('第 2 条') }])
  })

  it('不打开编辑器，用 PATCH data 和 operations 改值、改一段条款；再取文档是改后的内容，操作日志有记录', async () => {
    const id = await newDocument({}, contract)
    expect((await call('PATCH', `/api/documents/${id}/data`, host, { patch: { partyA: '某某科技' }, version: 1 })).statusCode).toBe(200)
    const r = await ops(id, host, {
      version: 2,
      ops: [
        { op: 'setText', target: { text: '双方协商解决' }, text: '第五条　争议解决：因本合同引起的争议，提交上海仲裁委员会仲裁。' },
        { op: 'setData', values: { amount: '358600', payMethod: 'stage' } },
      ],
    })
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json()).toMatchObject({ version: 3, values: { values: { partyA: '某某科技', amount: '358600', payMethod: 'stage' } } })
    const got = (await call('GET', `/api/documents/${id}`, host)).json()
    expect(textOf(got.doc)).toContain('提交上海仲裁委员会仲裁')
    expect(textOf(got.doc)).not.toContain('双方协商解决')
    expect(textOf(got.doc)).toContain('某某科技')
    const log = await logs(id)
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({ operator: expect.stringMatching(/^host:/), result: { ok: true, version: 3 } })
    expect((log[0]!.ops as { op: string }[]).map((o) => o.op)).toEqual(['setText', 'setData'])
  })

  it('填写模式：改不可编辑的字段整次被拒；只能改字段值；印章操作不走这里', async () => {
    const id = await newDocument({}, contract)
    const fill = { 'x-document-token': (await newToken(id, 'fill', { payMethod: 'readonly' })).token }
    const denied = await ops(id, fill, { version: 1, ops: [{ op: 'setData', values: { partyA: 'x' } }, { op: 'setData', values: { payMethod: 'stage' } }] })
    expect(denied.statusCode).toBe(403)
    expect(denied.json()).toMatchObject({ code: 'PERMISSION_DENIED', index: 1 })
    expect((await call('GET', `/api/documents/${id}`, host)).json().values.values.partyA).toBeUndefined()
    expect((await ops(id, fill, { version: 1, ops: [{ op: 'setText', target: { text: '双方协商解决' }, text: 'x' }] })).json()).toMatchObject({ code: 'MODE_FORBIDDEN', index: 0 })
    expect((await ops(id, host, { version: 1, ops: [{ op: 'removeSeal', id: 's' }] })).statusCode).toBe(400)
    // 缺字段：按这一条的入参错误返回 400，不是 500
    expect((await ops(id, host, { version: 1, ops: [{ op: 'setData' }] })).json()).toMatchObject({ code: 'BAD_ARGUMENT', index: 0 })
    const ok = await ops(id, fill, { version: 1, ops: [{ op: 'setData', values: { partyA: '某某' } }] })
    expect(ok.statusCode, ok.body).toBe(200)
  })
})

describe('出文件和导入（s11 第二部分：服务端调渲染服务）', () => {
  it('建模板传 docx：经渲染服务转成文档，返回导入报告和页数；doc 和 docx 只能给一个', async () => {
    const r = await call('POST', '/api/templates', host, { name: '导入的合同', docx: Buffer.from('样例').toString('base64') })
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json()).toMatchObject({ versionNo: 1, pageCount: 1, report: { textExact: true } })
    const v = (await call('GET', `/api/templates/${r.json().id}/versions/1`, host)).json()
    expect(v.doc.main[0].value).toBe('导入：样例')
    expect((await call('POST', '/api/templates', host, { name: 'x', doc, docx: 'eA==' })).statusCode).toBe(400)
  })

  it('下载：只用已保存的数据，带文档 id、版本；?version= 不对 409；令牌下载时隐藏字段的值不进文件', async () => {
    const id = await newDocument({ partyA: '机密公司', amount: '1000' })
    rendered.length = 0
    const r = await call('GET', `/api/documents/${id}/export?format=pdf`, host)
    expect(r.statusCode, r.body).toBe(200)
    expect(r.headers['content-type']).toBe('application/pdf')
    expect(r.headers['x-document-version']).toBe('1')
    expect(r.headers['content-disposition']).toContain(encodeURIComponent('采购合同.pdf'))
    expect(r.body).toBe('%PDF-1.7 fake')
    expect(rendered[0]).toMatchObject({ documentId: id, version: 1, title: '采购合同', outputs: ['pdf'], expectedPages: undefined })
    expect(JSON.stringify(rendered[0]!.doc)).toContain('机密公司')
    expect((await call('GET', `/api/documents/${id}/export?version=9`, host)).statusCode).toBe(409)
    const view = await newToken(id, 'view', { partyA: 'hidden' })
    const d = await call('GET', `/api/documents/${id}/export?format=docx`, { 'x-document-token': view.token })
    expect(d.statusCode, d.body).toBe(200)
    expect(d.headers['content-type']).toContain('wordprocessingml')
    expect(JSON.stringify(rendered[1]!.doc)).not.toContain('机密公司')
  })

  it('页数：编辑器保存时带的页数交给渲染服务核对，对不上 409 带两边页数；宿主直接改值后不再核对', async () => {
    const id = await newDocument()
    rendered.length = 0
    expect((await call('PATCH', `/api/documents/${id}/data`, host, { patch: { partyA: 'a' }, version: 1, pageCount: 3 })).statusCode).toBe(200)
    await call('GET', `/api/documents/${id}/export`, host)
    expect(rendered[0]!.expectedPages).toBe(3)
    expect((await call('PATCH', `/api/documents/${id}/data`, host, { patch: { partyA: 'b' }, version: 2, pageCount: 99 })).statusCode).toBe(200)
    const mismatch = await call('GET', `/api/documents/${id}/export`, host)
    expect(mismatch.statusCode).toBe(409)
    expect(mismatch.json()).toMatchObject({ code: 'PAGE_COUNT_MISMATCH', expected: 99, actual: 2 })
    expect((await call('PATCH', `/api/documents/${id}/data`, host, { patch: { partyA: 'c' }, version: 3 })).statusCode).toBe(200)
    await call('GET', `/api/documents/${id}/export`, host)
    expect(rendered.at(-1)!.expectedPages).toBeUndefined()
  })

  it('页数：令牌有隐藏字段时，保存带的页数不存（它数的是缺了隐藏值的文档），下载出的是剔除后的文档也不核对', async () => {
    const id = await newDocument({ amount: '1000' })
    const fill = await newToken(id, 'fill', { amount: 'hidden' })
    expect((await call('PATCH', `/api/documents/${id}/data`, { 'x-document-token': fill.token }, { patch: { partyA: 'a' }, version: 1, pageCount: 3 })).statusCode).toBe(200)
    rendered.length = 0
    await call('GET', `/api/documents/${id}/export`, host)
    expect(rendered[0]!.expectedPages).toBeUndefined()
    expect((await call('PATCH', `/api/documents/${id}/data`, host, { patch: { partyA: 'b' }, version: 2, pageCount: 3 })).statusCode).toBe(200)
    const view = await newToken(id, 'view', { amount: 'hidden' })
    expect((await call('GET', `/api/documents/${id}/export`, { 'x-document-token': view.token })).statusCode).toBe(200)
    expect(rendered.at(-1)!.expectedPages).toBeUndefined()
    await call('GET', `/api/documents/${id}/export`, host)
    expect(rendered.at(-1)!.expectedPages).toBe(3)
  })

  it('打印、下载按令牌：GET 文档返回能不能打印、下载；不能下载的令牌调 /export 403；不给时都能（验收 4）', async () => {
    const id = await newDocument()
    const r = await call('POST', '/api/tokens', host, { documentId: id, mode: 'view', userId: 'u1', actions: { download: false } })
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json().actions).toEqual({ print: true, download: false })
    const denied = { 'x-document-token': r.json().token as string }
    expect((await call('GET', `/api/documents/${id}`, denied)).json().actions).toEqual({ print: true, download: false })
    const e = await call('GET', `/api/documents/${id}/export`, denied)
    expect(e.statusCode).toBe(403)
    expect(e.json().code).toBe('ACTION_FORBIDDEN')
    const all = { 'x-document-token': (await newToken(id, 'view')).token }
    expect((await call('GET', `/api/documents/${id}`, all)).json().actions).toEqual({ print: true, download: true })
    expect((await call('GET', `/api/documents/${id}/export`, all)).statusCode).toBe(200)
  })

  it('POST /render：模板版本 + 数据直接出文件，不建文档', async () => {
    const t = (await call('POST', '/api/templates', host, { name: '采购合同', doc, fields })).json()
    rendered.length = 0
    const r = await call('POST', '/api/render', host, { templateId: t.id, versionNo: 1, values: { partyA: '某某科技', amount: '358600' }, format: 'pdf' })
    expect(r.statusCode, r.body).toBe(200)
    expect(r.headers['content-type']).toBe('application/pdf')
    expect(JSON.stringify(rendered[0]!.doc)).toContain('某某科技')
    expect(rendered[0]).toMatchObject({ outputs: ['pdf'], title: '采购合同' })
    expect((await call('POST', '/api/render', {}, { templateId: t.id, versionNo: 1 })).statusCode).toBe(401)
  })
})


describe('宿主字段库与模板快照', () => {
  it('字段库需宿主鉴权；拒绝重复 key 和无效带出配置', async () => {
    expect((await call('GET', '/api/field-library')).statusCode).toBe(401)
    expect((await call('PUT', '/api/field-library', host, { version: 0, fields: [fields[0], fields[0]] })).statusCode).toBe(400)
    expect((await call('PUT', '/api/field-library', host, { version: 0, fields: [{ ...fields[0], fill: { missing: 'name' } }] })).statusCode).toBe(400)
    expect((await call('PUT', '/api/field-library', host, { version: 0, fields: [{ ...fields[0], dataSource: { id: 'x', kind: 'invalid' } }] })).statusCode).toBe(400)
  })

  it('登记和更新按宿主隔离；并发首次登记只能成功一次', async () => {
    const key = 'library-isolation-key'
    await database.insert(apiClient).values({ id: crypto.randomUUID(), name: '另一个宿主', keyHash: hashKey(key) })
    const otherHost = { authorization: `Bearer ${key}` }
    expect((await call('GET', '/api/field-library', otherHost)).json()).toEqual({ version: 0, fields: [] })
    const results = await Promise.all([1, 2].map(() => call('PUT', '/api/field-library', otherHost, { version: 0, fields: [fields[0]] })))
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409])
    expect((await call('GET', '/api/field-library', otherHost)).json()).toEqual({ version: 1, fields: [fields[0]] })
    expect((await call('GET', '/api/field-library', host)).json()).toEqual({ version: 0, fields: [] })
    expect((await call('POST', '/api/templates', host, { name: '不能跨宿主引用', doc, fieldKeys: ['partyA'] })).json().code).toBe('FIELD_NOT_FOUND')
  })

  it('发布按 key 取定义，更新字段库后旧模板与合同保留原快照', async () => {
    const saved = await call('PUT', '/api/field-library', host, { version: 0, fields })
    expect(saved.statusCode, saved.body).toBe(200)
    expect(saved.json().version).toBe(1)
    const made = await call('POST', '/api/templates', host, { name: '字段库模板', doc, fieldKeys: fields.map((f) => f.key) })
    expect(made.statusCode, made.body).toBe(200)
    const id = made.json().id
    const created = await call('POST', '/api/documents', host, { templateId: id, versionNo: 1, values: { partyA: '客户甲' } })
    expect(created.statusCode, created.body).toBe(200)
    const updated = fields.map((f) => ({ ...f, label: f.label + '新版' }))
    expect((await call('PUT', '/api/field-library', host, { version: 1, fields: updated })).json().version).toBe(2)
    expect((await call('PUT', '/api/field-library', host, { version: 1, fields: [] })).statusCode).toBe(409)
    const old = await call('GET', `/api/templates/${id}/versions/1`, host)
    expect(old.json().fields).toEqual(fields)
    const contract = await call('GET', `/api/documents/${created.json().id}`, host)
    expect(contract.json().fields).toEqual(fields)
    expect(contract.json().values.values.partyA).toBe('客户甲')
    const next = await call('POST', `/api/templates/${id}/versions`, host, { doc, fieldKeys: ['partyA'] })
    expect(next.json().versionNo).toBe(2)
    expect((await call('POST', `/api/templates/${id}/versions`, host, { doc })).statusCode).toBe(400)
    expect((await call('GET', `/api/templates/${id}/versions/2`, host)).json().fields).toEqual([updated[0]])
    expect((await call('POST', '/api/templates', host, { name: '未知字段', doc, fieldKeys: ['missing'] })).json().code).toBe('FIELD_NOT_FOUND')
    expect((await call('POST', '/api/templates', host, { name: '冲突入参', doc, fields: [], fieldKeys: [] })).statusCode).toBe(400)
    expect((await call('POST', '/api/templates', host, { name: '重复引用', doc, fieldKeys: ['partyA', 'partyA'] })).statusCode).toBe(400)
    const { token } = await newToken(created.json().id, 'edit')
    expect((await call('GET', '/api/field-library', { 'x-document-token': token })).statusCode).toBe(401)
  })
})
