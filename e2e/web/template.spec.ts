import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '@playwright/test'
import { createServer, type ViteDevServer } from '../../apps/demo/node_modules/vite/dist/node/index.js'
import { startTempServer } from '../../apps/server/src/temp-server'
import { FIELDS } from '../../apps/demo/src/sample'
import { HOST_TOKEN } from '../../apps/demo/src/customers'
import { startRenderer } from '../../apps/renderer/src/app'
import { loadConfig } from '../../apps/renderer/src/config'
import JSZip from '../../packages/docx/node_modules/jszip/lib/index.js'
import type { EditorHandle } from '../../packages/web/src/sdk'

let server: Awaited<ReturnType<typeof startTempServer>>
let vite: ViteDevServer
let origin: string
let renderer: Awaited<ReturnType<typeof startRenderer>>
const documentCreates: unknown[] = []
const host = () => ({ authorization: `Bearer ${server.apiKey}` })

test.describe.configure({ mode: 'default' })

test.beforeAll(async () => {
  test.setTimeout(180_000)
  server = await startTempServer()
  server.app.addHook('preHandler', async (req) => {
    if (req.method === 'POST' && req.url === '/api/documents') documentCreates.push(req.body)
  })
  await server.app.listen({ host: '127.0.0.1', port: 0 })
  process.env.OE_SERVER_URL = server.app.listeningOrigin
  process.env.OE_API_KEY = server.apiKey
  const library = await server.app.inject({ method: 'PUT', url: '/api/field-library', headers: host(), payload: { version: 0, fields: FIELDS } })
  expect(library.statusCode, library.body).toBe(200)
  renderer = await startRenderer({ ...loadConfig({}), RENDERER_PORT: 0, POOL_SIZE: 1 })
  vite = await createServer({ root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../apps/demo'), server: { host: '127.0.0.1', port: 0, proxy: { '/convert': renderer.origin } } })
  await vite.listen()
  origin = vite.resolvedUrls!.local[0]!
})

test.afterAll(async () => {
  await vite?.close()
  await renderer?.close()
  await server?.stop()
})

test('模板设计：专用令牌打开，插入字段、保存重开、冻结快照发布并生成合同', async ({ page }) => {
  test.setTimeout(120_000)
  const errors: string[] = []
  const requests: { url: string; headers: Record<string, string> }[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('request', (r) => { if (r.url().includes('/api/templates/')) requests.push({ url: r.url(), headers: r.headers() }) })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${origin}?template=new`)
  await expect(page.getByRole('button', { name: '保存草稿' })).toBeVisible()
  await expect(page.locator('.doc canvas').first()).toBeVisible()
  await expect(page).toHaveURL(/template=[a-f0-9-]{36}/)
  const templateId = new URL(page.url()).searchParams.get('template')!
  await page.evaluate(() => (window as unknown as { __oe: EditorHandle }).__oe.editor!.command.executeSetRange(0, 0))
  await page.getByRole('searchbox', { name: '搜索字段' }).fill('金额')
  await page.locator('[data-library-field="amount"]').click()
  await page.getByRole('button', { name: '保存草稿' }).click()
  await expect(page.locator('.doc-status')).toHaveText('已保存')
  const base = `/api/templates/${templateId}`
  const saved = await server.app.inject({ method: 'GET', url: `${base}/draft`, headers: host() })
  expect(saved.json().fields).toEqual([FIELDS.find((f) => f.key === 'amount')])

  // 字段库更新后重开模板：列表使用新版，已用定义和重复插入仍沿用原来的快照。
  await server.app.inject({ method: 'PUT', url: '/api/field-library', headers: host(), payload: {
    version: 1, fields: FIELDS.map((f) => f.key === 'amount' ? { ...f, label: '新版合同金额' } : f),
  } })
  await page.reload()
  await expect(page.locator('[data-library-field="amount"]')).toHaveText('新版合同金额')
  await expect(page.locator('.doc canvas').first()).toBeVisible()
  await page.evaluate(() => (window as unknown as { __oe: EditorHandle }).__oe.editor!.command.executeSetRange(0, 0))
  await page.locator('[data-library-field="amount"]').click()
  await page.locator('[data-library-field="partyA"]').click()
  await page.getByRole('button', { name: '发布模板' }).click()
  await expect(page.locator('.doc-status')).toHaveText('已发布')
  const published = (await server.app.inject({ method: 'GET', url: `${base}/versions/1`, headers: host() })).json()
  expect(published.fields.find((f: { key: string }) => f.key === 'amount').label).toBe('合同金额')
  expect(published.fields.map((f: { key: string }) => f.key).sort()).toEqual(['amount', 'partyA', 'partyAAddress', 'partyACredit'])
  const controls = await page.evaluate(() => (window as unknown as { __oe: EditorHandle }).__oe.editor!.command.getControlList())
  expect(new Set(controls.filter((c) => c.control?.conceptId === 'amount').map((c) => c.controlId)).size).toBe(2)
  const created = await server.app.inject({ method: 'POST', url: '/api/documents', headers: host(), payload: { templateId, versionNo: 1, values: { amount: '5200' } } })
  expect(created.statusCode, created.body).toBe(200)
  const contract = (await server.app.inject({ method: 'GET', url: `/api/documents/${created.json().id}`, headers: host() })).json()
  expect(contract.values.values.amount).toBe('5200')
  expect(requests.length).toBeGreaterThan(3)
  expect(requests.every((r) => r.headers['x-template-token'] && !r.headers.authorization && !r.url.includes('token='))).toBe(true)
  expect(errors).toEqual([])
  await page.screenshot({ path: 'test-results/template-design.png', fullPage: true })
})

test('模板入口拒绝未登录的宿主请求', async ({ request }) => {
  const r = await request.post(`${origin}host/template`, { data: { templateId: 'new' } })
  expect(r.status()).toBe(401)
})

test('模板交互：拖放到正文、选区转换及属性保存', async ({ page }) => {
  test.setTimeout(120_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${origin}?template=new`)
  await expect(page.locator('.doc canvas').first()).toBeVisible()
  await page.evaluate(() => {
    const command = (window as unknown as { __oe: EditorHandle }).__oe.editor!.command
    command.executeSetValue({ main: [{ value: '甲方：____；金额：____。' }] })
    command.executeSetRange(3, 3)
  })
  const position = await page.evaluate(() => (window as unknown as { __oe: EditorHandle }).__oe.editor!.command.getCursorPosition()!)
  const canvas = page.locator('.doc canvas').first()
  await page.locator('[data-library-field="amount"]').dragTo(canvas, { targetPosition: { x: position.coordinate.rightTop[0]!, y: position.coordinate.rightTop[1]! + 8 } })
  await expect.poll(() => page.evaluate(() => (window as unknown as { __oe: EditorHandle }).__oe.editor!.command.getControlList().length)).toBe(1)
  const dropped = await page.evaluate(() => (window as unknown as { __oe: EditorHandle }).__oe.editor!.command.getValue().data.main)
  const idx = dropped.findIndex((e) => e.control?.conceptId === 'amount')
  expect(dropped.slice(0, idx).map((e) => e.value).join('').replace(/\u200b/g, '')).toBe('甲方：')

  await page.evaluate(() => {
    const command = (window as unknown as { __oe: EditorHandle }).__oe.editor!.command
    command.executeSetValue({ main: [{ value: '甲方：____；金额。' }] })
    command.executeSetRange(3, 7)
  })
  await page.getByRole('button', { name: '设为字段', exact: true }).click()
  await page.locator('.field-chooser [data-library-field="partyA"]').click()
  const converted = await page.evaluate(() => (window as unknown as { __oe: EditorHandle }).__oe.editor!.command.getValue().data.main)
  expect(converted.map((e) => e.value).join('')).not.toContain('____')
  expect(converted.some((e) => e.control?.conceptId === 'partyA')).toBe(true)
  await page.locator('[data-insert="partyA"]').click()
  await page.getByRole('textbox', { name: '字段名称' }).fill('采购客户')
  await page.getByRole('textbox', { name: '字段名称' }).press('Tab')
  await page.getByRole('button', { name: '保存草稿' }).click()
  await expect(page.locator('.doc-status')).toHaveText('已保存')
  await page.reload()
  await expect(page.locator('[data-insert="partyA"]')).toHaveText(/采购客户/)
  expect(errors).toEqual([])
})

test('快捷插入保留日期正文，样例预览不改模板', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${origin}?template=new`)
  await expect(page.locator('.doc canvas').first()).toBeVisible()
  await page.evaluate(() => {
    const c = (window as unknown as { __oe: EditorHandle }).__oe.editor!.command
    c.executeSetValue({ main: [{ value: '日期：' }] }); c.executeSetRange(3, 3); c.executeFocus()
  })
  await page.keyboard.type('2026/3/18')
  await expect(page.locator('.field-chooser')).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => (window as unknown as { __oe: EditorHandle }).__oe.getData().doc.main.map((e) => e.value).join(''))).toContain('2026/3/18')
  await page.keyboard.type(' /')
  await expect(page.locator('.field-chooser')).toBeVisible()
  await page.locator('.field-chooser input').fill('amount')
  await page.locator('.field-chooser input').press('Enter')
  expect(errors).toEqual([])
  await expect.poll(() => page.evaluate(() => (window as unknown as { __oe: EditorHandle }).__oe.getData().fields.some((f) => f.key === 'amount'))).toBe(true)
  const before = await page.evaluate(() => (window as unknown as { __oe: EditorHandle }).__oe.getData())
  await page.getByRole('button', { name: '预览', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '样例数据预览' })).toBeVisible()
  await expect(page.locator('.preview-pages canvas').first()).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await page.getByLabel('样例单据').selectOption('1')
  await expect(page.locator('.preview-pages canvas').first()).toBeVisible()
  await page.getByRole('button', { name: '返回设计' }).click()
  const after = await page.evaluate(() => (window as unknown as { __oe: EditorHandle }).__oe.getData())
  expect(after).toEqual(before)
  expect(errors).toEqual([])
})

test('导入后的三种空白可以逐个转换，转换后候选刷新', async ({ page }) => {
  test.setTimeout(120_000)
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
  zip.file('word/document.xml', '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t xml:space="preserve">甲方：______；地址：（    ）；日期：  年  月  日。</w:t></w:r></w:p></w:body></w:document>')
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${origin}?template=new`)
  await expect(page.locator('.doc canvas').first()).toBeVisible()
  await page.setInputFiles('.oe input[type="file"]', { name: 'blanks.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: await zip.generateAsync({ type: 'nodebuffer' }) })
  const candidates = page.getByRole('region', { name: '待设字段的空白' }).getByRole('button')
  await expect(candidates).toHaveCount(3)
  await expect(candidates).toHaveText([/______/, /（\s+）/, /年\s+月\s+日/])
  for (const key of ['partyA', 'partyAAddress', 'signDate']) {
    await candidates.first().click()
    await page.locator(`.field-chooser [data-library-field="${key}"]`).click()
  }
  await expect(candidates).toHaveCount(0)
  const controls = await page.evaluate(() => (window as unknown as { __oe: EditorHandle }).__oe.editor!.command.getControlList())
  expect(controls.map((c) => c.control?.conceptId).sort()).toEqual(['partyA', 'partyAAddress', 'signDate'])
})

test('无代码设计发布，宿主按订单建合同，客户联填与字典快照保存重开', async ({ page, request }) => {
  test.setTimeout(120_000)
  const library = (await server.app.inject({ method: 'GET', url: '/api/field-library', headers: host() })).json()
  const reset = await server.app.inject({ method: 'PUT', url: '/api/field-library', headers: host(), payload: { version: library.version, fields: FIELDS } })
  expect(reset.statusCode, reset.body).toBe(200)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${origin}?template=new`)
  await expect(page.locator('.doc canvas').first()).toBeVisible()
  const templateId = new URL(page.url()).searchParams.get('template')!
  for (const key of ['contractNo', 'partyA', 'partyAAddress', 'partyACredit', 'amount', 'payMethod', 'signDate', 'items']) {
    await page.getByRole('complementary', { name: '字段库' }).getByRole('button', { name: FIELDS.find((f) => f.key === key)!.label, exact: true }).click()
    const inserted = await page.evaluate(() => (window as unknown as { __oe: EditorHandle }).__oe.getData())
    expect(inserted.fields.some((f) => f.key === key)).toBe(true)
    expect(JSON.stringify(inserted.doc)).toContain(key === 'items' ? '"loop":"items"' : `"conceptId":"${key}"`)
    expect(errors, key).toEqual([])
  }
  const placed = await page.evaluate(() => (window as unknown as { __oe: EditorHandle }).__oe.editor!.command.getControlList().map((c) => c.control?.conceptId))
  expect(placed).toEqual(expect.arrayContaining(['contractNo', 'partyA', 'partyAAddress', 'partyACredit', 'amount', 'payMethod', 'signDate']))
  await page.getByRole('button', { name: '发布模板' }).click()
  await expect(page.locator('.doc-status')).toHaveText('已发布')
  const base = { templateId, versionNo: 1 }
  const old = await server.app.inject({ method: 'POST', url: '/api/documents', headers: host(), payload: base })
  expect(old.statusCode, old.body).toBe(200)
  const beforeOld = (await server.app.inject({ method: 'GET', url: `/api/documents/${old.json().id}`, headers: host() })).json()
  const beforeTemplate = (await server.app.inject({ method: 'GET', url: `/api/templates/${templateId}/versions/1`, headers: host() })).json()
  const oldOptions = beforeOld.fields.find((f: { key: string }) => f.key === 'payMethod').options
  const templateOptions = beforeTemplate.fields.find((f: { key: string }) => f.key === 'payMethod').options
  expect(oldOptions).toEqual(FIELDS.find((f) => f.key === 'payMethod')!.options)
  expect(templateOptions).toEqual(oldOptions)
  const dictionary = await request.get(`${origin}api/payment-methods`, { headers: { authorization: HOST_TOKEN } })
  expect(dictionary.status()).toBe(200)
  const options = [...await dictionary.json() as { code: string; value: string }[], { code: 'credit', value: '赊销付款' }]
  // 宿主业务字典新增选项后，在新建合同边界提交最新快照。
  const fresh = await server.app.inject({ method: 'POST', url: '/api/documents', headers: host(), payload: { ...base, dictionaries: { 'payment-method': options } } })
  expect(fresh.statusCode, fresh.body).toBe(200)
  await page.goto(`${origin}?doc=${fresh.json().id}&mode=fill`)
  await expect(page.locator('.doc canvas').first()).toBeVisible()
  const paymentControls = await page.evaluate(() => (window as unknown as { __oe: EditorHandle }).__oe.editor!.command.getControlList().filter((c) => c.control?.conceptId === 'payMethod'))
  expect(paymentControls.length).toBeGreaterThan(0)
  for (const c of paymentControls) expect(c.control!.valueSets).toEqual(options)
  await page.locator('[data-locate="partyA"]').click()
  await expect(page.locator('.picker-list li')).toHaveCount(5)
  await page.locator('.picker input[type="search"]').fill('江苏')
  await expect(page.locator('.picker-list li').first()).toContainText('苏州')
  await page.keyboard.press('Enter')
  const firstCustomer = await page.evaluate(() => (window as unknown as { __oe: EditorHandle }).__oe.getData().values.values)
  expect(firstCustomer).toMatchObject({ partyA: '苏州工业园区精工机械有限公司', partyAAddress: '江苏省苏州市工业园区星湖街 328 号', partyACredit: '91320594MA1N3C8Y5P' })
  await page.locator('[data-locate="partyA"]').click()
  await page.locator('.picker input[type="search"]').fill('上海')
  await expect(page.locator('.picker-list li')).toHaveCount(1)
  await page.keyboard.press('Enter')
  const changedCustomer = await page.evaluate(() => (window as unknown as { __oe: EditorHandle }).__oe.getData().values.values)
  expect(changedCustomer).toMatchObject({ partyA: '上海浦江重型装备股份有限公司', partyAAddress: '上海市闵行区江川路 1800 号', partyACredit: '91310112MA1K4B2X7Q' })
  await page.locator('[data-locate="payMethod"]').click()
  await page.getByText('赊销付款', { exact: true }).click()
  await page.getByRole('button', { name: '提交', exact: true }).click()
  await expect(page.locator('.doc-status')).toHaveText('已提交')
  await page.reload()
  await expect(page.locator('.doc canvas').first()).toBeVisible()
  const data = await page.evaluate(() => (window as unknown as { __oe: EditorHandle }).__oe.getData())
  expect(data.values.values).toMatchObject({ payMethod: 'credit', partyA: '上海浦江重型装备股份有限公司', partyAAddress: '上海市闵行区江川路 1800 号', partyACredit: '91310112MA1K4B2X7Q' })
  const reopenedText = await page.evaluate(() => (window as unknown as { __oe: EditorHandle }).__oe.editor!.command.getText().main)
  for (const value of ['赊销付款', '上海浦江重型装备股份有限公司', '上海市闵行区江川路 1800 号', '91310112MA1K4B2X7Q']) expect(reopenedText).toContain(value)
  const retrieved = await server.app.inject({ method: 'GET', url: `/api/documents/${fresh.json().id}`, headers: host() })
  expect(retrieved.statusCode).toBe(200)
  expect(retrieved.json().values.values).toEqual(data.values.values)
  const deniedCustomer = await request.get(`${origin}api/customers?q=上海`)
  expect(deniedCustomer.status()).toBe(401)
  const oldDoc = (await server.app.inject({ method: 'GET', url: `/api/documents/${old.json().id}`, headers: host() })).json()
  expect(oldDoc.fields.find((f: { key: string }) => f.key === 'payMethod').options).toEqual(oldOptions)
  const unchangedTemplate = (await server.app.inject({ method: 'GET', url: `/api/templates/${templateId}/versions/1`, headers: host() })).json()
  expect(unchangedTemplate.fields.find((f: { key: string }) => f.key === 'payMethod').options).toEqual(templateOptions)
  await page.goto(`${origin}?fromTemplate=${templateId}&version=1`)
  await expect(page.locator('.doc canvas').first()).toBeVisible()
  await expect(page).toHaveURL(/doc=.*mode=fill/)
  const order = await page.evaluate(() => (window as unknown as { __oe: EditorHandle }).__oe.getData())
  expect(order.values.values).toMatchObject({ contractNo: 'CG-2026-001', amount: '5200', items: [{ name: '显示器', model: '27英寸', qty: '2', price: '2600' }] })
  expect(documentCreates).toContainEqual(expect.objectContaining({ templateId, versionNo: 1, bizKey: 'order-1', values: { contractNo: 'CG-2026-001', amount: '5200', items: [{ name: '显示器', model: '27英寸', qty: '2', price: '2600' }] } }))
  const controls = await page.evaluate(() => (window as unknown as { __oe: EditorHandle }).__oe.editor!.command.getControlList())
  for (const key of ['contractNo', 'amount', 'name', 'model', 'qty', 'price']) {
    const matching = controls.filter((c) => c.control!.conceptId === key)
    expect(matching.length, key).toBeGreaterThan(0)
    expect(matching.every((c) => c.control!.disabled), key).toBe(true)
  }
  const visibleDoc = JSON.stringify(order.doc)
  for (const value of ['CG-2026-001', '5200', '显示器', '27英寸', '2600']) expect(visibleDoc).toContain(value)
  expect(errors).toEqual([])
})

for (const scheme of ['light', 'dark'] as const) {
  test(`模板面板规范与右键设为字段（${scheme}）`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`${origin}?template=new`)
    await expect(page.locator('.doc canvas').first()).toBeVisible()
    await page.evaluate(() => {
      const c = (window as unknown as { __oe: EditorHandle }).__oe.editor!.command
      c.executeSetValue({ main: [{ value: '待替换' }] }); c.executeSetRange(0, 3)
    })
    await page.locator('.doc canvas').first().click({ button: 'right', position: { x: 140, y: 110 } })
    await page.getByText('设为字段', { exact: true }).last().hover()
    await page.getByText('签订日期', { exact: true }).last().click()
    await expect.poll(() => page.evaluate(() => (window as unknown as { __oe: EditorHandle }).__oe.editor!.command.getControlList().some((c) => c.control?.conceptId === 'signDate'))).toBe(true)
    await page.locator('[data-insert="signDate"]').click()
    const audit = await page.evaluate(() => {
      const bad: string[] = []
      for (const el of document.querySelectorAll<HTMLElement>('.template-fields *, .inspector *')) {
        if (!el.getBoundingClientRect().width) continue
        const s = getComputedStyle(el)
        if (!s.fontFamily.startsWith('-apple-system')) bad.push(`font ${el.className}`)
        for (const value of [s.color, s.backgroundColor, s.borderBottomColor, s.boxShadow]) {
          for (const m of value.matchAll(/rgba?\(([^)]+)\)/g)) {
            const [r, g, b, a = 1] = m[1]!.split(/[ ,/]+/).filter(Boolean).map(Number)
            const gray = Math.max(r!, g!, b!) - Math.min(r!, g!, b!) <= 12
            const accent = r! <= 22 && g! >= 110 && g! <= 144 && b! >= 252
            if (a && !gray && !accent) bad.push(`${el.className}: ${value}`)
          }
        }
      }
      const box = (s: string) => document.querySelector(s)!.getBoundingClientRect()
      return { bad, left: box('.template-fields').width, right: box('.inspector').width, row: box('.template-fields .row').height }
    })
    expect(audit).toEqual({ bad: [], left: 280, right: 280, row: 32 })
    await page.screenshot({ path: `test-results/template-${scheme}.png` })
  })
}
