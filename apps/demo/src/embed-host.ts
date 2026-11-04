// 业务系统嵌入示例（父页面）：不用 Vue，只用 @oe/web/embed 的 connectEmbed。
// 文档由业务系统交给编辑器；保存、客户搜索在父页面实现（这里存 localStorage、查样例客户，真实系统换成自己的接口和登录态）
import { connectEmbed, type EmbedHandle } from '@oe/web/embed'
import { CUSTOMERS, queryCustomers } from './customers'
import { DATA_SOURCES, FIELDS, sampleDoc } from './sample'

const KEY = 'oe-embed-demo-document'
const log = document.querySelector<HTMLPreElement>('#log')!
const write = (line: string) => (log.textContent = `${new Date().toLocaleTimeString()} ${line}\n${log.textContent}`.slice(0, 4000))
const iframe = document.querySelector<HTMLIFrameElement>('#editor')!
// 嵌入页和本页同源；跨域部署时 origin 写编辑器的地址，嵌入页地址上的 origin 写本页的来源
iframe.src = new URL(`embed.html?origin=${encodeURIComponent(location.origin)}`, location.href).href
const saved = localStorage.getItem(KEY)

const handle: EmbedHandle = await connectEmbed(iframe, {
  origin: location.origin,
  mode: 'edit',
  modes: ['edit', 'fill', 'view'],
  document: saved ? { title: '采购合同', ...JSON.parse(saved) } : { title: '采购合同', doc: sampleDoc(), fields: FIELDS },
  dataSources: DATA_SOURCES,
  host: {
    save: async ({ doc, values, fields }) => {
      localStorage.setItem(KEY, JSON.stringify({ doc, values, fields }))
      write('父页面保存了文档')
    },
    // 远程数据源的请求经父页面发（带父页面自己的登录态）；这里直接查样例客户
    request: async ({ url, query }) => {
      if (new URL(url, location.href).pathname.endsWith('/api/customers')) return queryCustomers(CUSTOMERS, new URLSearchParams(Object.entries(query ?? {}).map(([k, v]) => [k, String(v)])))
      throw new Error(`示例没有接口 ${url}`)
    },
  },
})
write('编辑器装好了')
handle.on('field-change', (c) => write(`字段 ${c.key}：${JSON.stringify(c.previous)} → ${JSON.stringify(c.value)}`))
handle.on('saved', (s) => write(`保存成功（${s.mode}）`))
handle.on('mode-change', (m) => write(`模式：${m}`))
handle.on('dirty-change', (d) => write(d ? '有没保存的修改' : '修改都保存了'))
handle.on('field-focus', (f) => f && write(`光标进入字段：${f.label}`))

const on = (id: string, fn: () => Promise<unknown>) =>
  document.querySelector(`#${id}`)!.addEventListener('click', () => fn().catch((e) => write(`出错：${e instanceof Error ? e.message : e}`)))
on('setData', () => handle.setData({ contractNo: document.querySelector<HTMLInputElement>('#contractNo')!.value }))
on('validate', async () => write(`校验：${JSON.stringify(await handle.validate())}`))
on('getData', async () => write(`数据：${JSON.stringify((await handle.getData()).values.values)}`))
on('getText', async () => write(`文字前 60 字：${(await handle.getText()).slice(0, 60)}`))
on('fill', () => handle.setMode('fill'))
on('edit', () => handle.setMode('edit'))
on('pdf', () => handle.download('pdf'))
on('docx', () => handle.download('docx'))
on('apply', async () => {
  const r = await handle.apply([{ op: 'replace', target: { text: '十二个月' }, with: [{ value: '二十四个月' } as never] }])
  write(r.ok ? '已把质保期改成二十四个月' : `批量操作失败：第 ${r.index + 1} 条 ${r.error}`)
})
