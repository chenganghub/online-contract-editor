// 字段 → 插进文档的元素（方案 4.1）。绑定写法和 @oe/core 写值时认的一致：
// 控件 conceptId = 字段 key；图片、签名区 extension.field = 字段 key；表格循环的循环行 tr.extension.loop = 字段 key，行里控件的 conceptId = 列名。
// 宿主自己拼文档时也用它（@oe/web 导出），写法就和编辑器插入的一样。
// 控件统一不带前后缀（导出 docx 不出花括号，K7 补测）；编辑器里照样画控件边界。
import type { IElement } from '@hufe921/canvas-editor'
import type { FieldDef } from '@oe/core'
import { uid as randomId } from './ids'

// 内网 http 部署下没有 crypto.randomUUID，统一用 ids.ts 的
const uid = (prefix: string) => `${prefix}-${randomId()}`

const control = (conceptId: string, placeholder: string, extra: Record<string, unknown>) => ({
  type: 'control',
  value: '',
  control: { value: null, placeholder, conceptId, prefix: '', postfix: '', ...extra },
})

/**
 * 签名区没签时的占位图：透明底，下面一道浅灰线，线上写字段名（像纸面合同的签名栏，打出来也不突兀）。
 * 同一张图存在 extension.placeholder：拒签、驳回清掉签名时服务端换回它（服务端画不了图）
 */
function signatureImage(label: string, width: number, height: number): string {
  const c = document.createElement('canvas')
  c.width = width * 2
  c.height = height * 2
  const g = c.getContext('2d')!
  g.fillStyle = '#c7c7cc'
  g.fillRect(0, c.height - 6, c.width, 2)
  g.fillStyle = '#aeaeb2'
  g.font = '22px -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText(label, c.width / 2, c.height / 2 - 4)
  return c.toDataURL('image/png')
}

/** 图片字段没有值时的占位图：浅灰底、居中写字段名 */
function placeholderImage(label: string, width: number, height: number): string {
  const c = document.createElement('canvas')
  c.width = width * 2
  c.height = height * 2
  const g = c.getContext('2d')!
  g.fillStyle = '#f2f2f7'
  g.fillRect(0, 0, c.width, c.height)
  g.fillStyle = '#8e8e93'
  g.font = '24px -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText(label, c.width / 2, c.height / 2)
  return c.toDataURL('image/png')
}

/** innerWidth：正文宽度，循环表格按列平分 */
export function fieldElement(f: FieldDef, innerWidth: number): IElement {
  switch (f.type) {
    case 'select':
    case 'radio':
    case 'checkbox':
      return control(f.key, f.label, { type: f.type, code: null, valueSets: f.options ?? [] }) as unknown as IElement
    case 'date':
      return control(f.key, f.label, { type: 'date', dateFormat: f.format ?? 'yyyy年MM月dd日' }) as unknown as IElement
    case 'image':
      return { id: uid('image'), type: 'image', value: placeholderImage(f.label, 160, 90), width: 160, height: 90, extension: { field: f.key } } as unknown as IElement
    case 'signature': {
      const placeholder = signatureImage(f.label, 160, 56)
      return { id: uid('image'), type: 'image', value: placeholder, width: 160, height: 56, extension: { field: f.key, signer: f.signer, placeholder } } as unknown as IElement
    }
    // 签署日期由服务端在签署时写，编辑、填写都不能改
    case 'signDate':
      return control(f.key, f.label, { type: 'text', disabled: true }) as unknown as IElement
    case 'loop': {
      const cols = f.loop?.columns ?? []
      const labels = cols.map((c, i) => f.loop?.labels?.[i] ?? c)
      const width = Math.floor(innerWidth / Math.max(1, cols.length))
      const cell = (value: unknown[]) => ({ colspan: 1, rowspan: 1, value })
      return {
        id: uid('table'),
        type: 'table',
        value: '',
        colgroup: cols.map(() => ({ width })),
        trList: [
          // 表头：跨页时每页重复
          { height: 40, pagingRepeat: true, tdList: labels.map((l) => cell([{ value: l, bold: true }])) },
          // 循环行：按数据一条一行（@oe/core 的 setFieldValues）
          // 行内公式算出来的列不能手填
          { height: 40, extension: { loop: f.key }, tdList: cols.map((c, i) => cell([control(c, labels[i]!, { type: 'text', ...(f.loop?.formulas?.[c] ? { disabled: true } : {}) })])) },
        ],
      } as unknown as IElement
    }
    default:
      return control(f.key, f.label, { type: 'text', ...(f.type === 'computed' ? { disabled: true } : {}) }) as unknown as IElement
  }
}

/** 新建字段的键：字母开头，字母、数字、下划线 */
export const FIELD_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
