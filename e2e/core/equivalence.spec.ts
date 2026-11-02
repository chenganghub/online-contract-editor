// 验收 12、13：同一组操作分别用编辑器命令和 @oe/core 执行，装回编辑器后文档 JSON 结构相同；批量原子。
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, type Page } from '@playwright/test'
import { applyBatch, toChineseAmount, type DocData, type Op } from '../../packages/core/src/index'
import { contractDoc, contractFields } from '../../packages/core/src/__fixtures__/contract'
import { startTempServer } from '../../apps/server/src/temp-server'
import { serve } from '../helpers/serve'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// 编辑器每次加载都会重新生成的 id，比较前去掉
const RANDOM_IDS = new Set(['id', 'controlId', 'titleId', 'tableId', 'trId', 'tdId', 'listId', 'areaId', 'hyperlinkId', 'dateId', 'groupIds'])
const norm = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(norm)
  if (v && typeof v === 'object')
    return Object.fromEntries(Object.entries(v).filter(([k]) => !RANDOM_IDS.has(k)).map(([k, x]) => [k, norm(x)]))
  return v
}

const SEAL_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='
const PARTY_A = '某某科技有限公司'
const NEW_CLAUSE = '因本合同引起的争议，提交上海仲裁委员会，按照申请仲裁时该会现行有效的仲裁规则进行仲裁。'

const open = async (page: Page, origin: string, data: DocData) => {
  await page.goto(`${origin}/e2e/core/fixture/index.html`)
  await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready)
  await page.evaluate((d) => (window as unknown as { createEditor: (d: unknown) => void }).createEditor(d), data)
  await page.waitForTimeout(300)
}
const getData = (page: Page) =>
  page.evaluate(() => (window as unknown as { editor: { command: { getValue: () => { data: unknown } } } }).editor.command.getValue().data)

/** 编辑器命令执行那组操作：下划线换控件、填值、改一段条款、（放印章）、设只读 */
const runInEditor = (page: Page, withSeal: boolean) =>
  page.evaluate(
      ({ PARTY_A, NEW_CLAUSE, SEAL_URL, amountCN, withSeal }) => {
        type Cmd = Record<string, (...a: unknown[]) => unknown>
        const w = window as unknown as { editor: { command: Cmd } }
        const cmd = w.editor.command
        const range = (k: string) => (cmd.getKeywordRangeList!(k) as { startIndex: number; endIndex: number }[])[0]!
        // 1. 「甲方：」后面的下划线换成 partyA 控件
        const r1 = range('甲方：________')
        cmd.executeSetRange!(r1.startIndex - 1 + '甲方：'.length, r1.endIndex)
        cmd.executeInsertElementList!([
          { type: 'control', value: '', control: { type: 'text', value: null, conceptId: 'partyA', placeholder: 'partyA', prefix: '', postfix: '' } },
        ])
        // 2. 填值；金额大写是计算字段，编辑器里由宿主算好写进去
        cmd.executeSetControlValueList!([
          { conceptId: 'partyA', value: PARTY_A },
          { conceptId: 'payMethod', value: 'stage' },
          { conceptId: 'amount', value: '358600' },
          { conceptId: 'amountCN', value: amountCN },
        ])
        // 3. 改一段条款：选中整段，换成新文字，沿用段首第一个字的样式
        const text = (cmd.getText!() as { main: string }).main
        const para = text.split('\n').find((p) => p.includes('双方协商解决'))!
        const r3 = range(para)
        cmd.executeSetRange!(r3.startIndex - 1, r3.endIndex)
        const ctx = cmd.getRangeContext!() as { selectionElementList: Record<string, unknown>[] }
        const style = { ...ctx.selectionElementList[0] }
        delete style.value
        cmd.executeInsertElementList!([{ ...style, value: NEW_CLAUSE }])
        // 4. 印章追加到正文末尾
        if (withSeal)
          cmd.executeAppendElementList!([
            { id: 'seal-1', type: 'image', value: SEAL_URL, width: 151, height: 151, imgDisplay: 'float-top', imgFloatPosition: { x: 420, y: 640, pageNo: 0 } },
          ])
        // 5. 付款方式设只读
        cmd.executeSetControlPropertiesList!([{ conceptId: 'payMethod', properties: { disabled: true } }])
      },
      { PARTY_A, NEW_CLAUSE, SEAL_URL, amountCN: toChineseAmount('358600'), withSeal },
    )
/** 同一组操作给 core 和服务端 /operations 用（印章操作服务端走 /seals，不在这组里） */
const opsFor = (withSeal: boolean): Op[] => [
  {
    op: 'replace',
    target: { text: '________' },
    with: [{ type: 'control', value: '', control: { type: 'text', value: null, conceptId: 'partyA', placeholder: 'partyA', prefix: '', postfix: '' } }] as never,
  },
  { op: 'setData', values: { partyA: PARTY_A, payMethod: 'stage', amount: '358600' } },
  { op: 'setText', target: { text: '双方协商解决' }, text: NEW_CLAUSE },
  ...(withSeal ? [{ op: 'placeSeal', seal: { id: 'seal-1', dataURL: SEAL_URL, pageNo: 0, x: 420, y: 640, width: 151, height: 151 } } as Op] : []),
  { op: 'update', target: { field: 'payMethod' }, properties: { disabled: true } },
]

test('同一组操作：编辑器命令和 core 的结果装回编辑器后相同', async ({ page, context }) => {
  const server = await serve(root)
  try {
    await open(page, server.origin, contractDoc())
    const initial = (await getData(page)) as DocData

    // (a) 编辑器命令
    await runInEditor(page, true)
    const byEditor = await getData(page)

    // (b) core，在 Node 里执行，再装进一个新页面
    const r = applyBatch(initial, opsFor(true), { fields: contractFields })
    expect(r.ok, r.ok ? '' : r.error).toBe(true)
    if (!r.ok) return
    const page2 = await context.newPage()
    await open(page2, server.origin, r.data)
    const byCore = await getData(page2)

    expect(norm(byCore)).toEqual(norm(byEditor))
    // core 直接产出的 JSON（不经编辑器规整）也应该已经一致
    expect.soft(norm(r.data)).toEqual(norm(byEditor))
  } finally {
    await server.close()
  }
})

test('同一组操作：服务端 POST /documents/{id}/operations 和编辑器命令的结果装回编辑器后相同（验收 12）', async ({ page, context }) => {
  test.setTimeout(120_000)
  const server = await serve(root)
  const api = await startTempServer()
  try {
    const host = { authorization: `Bearer ${api.apiKey}` }
    // 模板是在编辑器里做好、按编辑器的格式存的
    await open(page, server.origin, contractDoc())
    const authored = (await getData(page)) as DocData
    const t = await api.app.inject({ method: 'POST', url: '/api/templates', headers: host, payload: { name: '采购合同', doc: authored, fields: contractFields } })
    expect(t.statusCode, t.body).toBe(200)
    const d = await api.app.inject({ method: 'POST', url: '/api/documents', headers: host, payload: { templateId: t.json().id, versionNo: 1 } })
    const id = d.json().id as string
    // 两边都从服务端存的那份文档开始
    const start = (await api.app.inject({ method: 'GET', url: `/api/documents/${id}`, headers: host })).json().doc as DocData

    // (a) 编辑器命令
    await open(page, server.origin, start)
    await runInEditor(page, false)
    const byEditor = await getData(page)

    // (b) 服务端：同一组操作走接口，取回文档装进新页面
    const r = await api.app.inject({ method: 'POST', url: `/api/documents/${id}/operations`, headers: host, payload: { ops: opsFor(false), version: 1 } })
    expect(r.statusCode, r.body).toBe(200)
    const saved = (await api.app.inject({ method: 'GET', url: `/api/documents/${id}`, headers: host })).json().doc as DocData
    const page2 = await context.newPage()
    await open(page2, server.origin, saved)
    const byServer = await getData(page2)

    expect(norm(byServer)).toEqual(norm(byEditor))
    // 服务端存的 JSON（不经编辑器规整）也一致
    expect.soft(norm(saved)).toEqual(norm(byEditor))
  } finally {
    await api.stop()
    await server.close()
  }
})

test('批量原子：第 2 条找不到位置，整批不生效，返回第 2 条的错误', async ({ page }) => {
  const server = await serve(root)
  try {
    await open(page, server.origin, contractDoc())
    const initial = (await getData(page)) as DocData
    const before = JSON.stringify(initial)
    const r = applyBatch(
      initial,
      [
        { op: 'setData', values: { partyA: PARTY_A } },
        { op: 'replace', target: { text: '这句话在合同里不存在' }, with: [] },
        { op: 'update', target: { field: 'payMethod' }, properties: { disabled: true } },
      ],
      { fields: contractFields },
    )
    expect(r).toMatchObject({ ok: false, index: 1, code: 'TARGET_NOT_FOUND' })
    expect(JSON.stringify(initial)).toBe(before)
  } finally {
    await server.close()
  }
})
