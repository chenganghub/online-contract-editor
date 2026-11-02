import { describe, expect, it } from 'vitest'
import { layoutOptions, pageSize } from './layout'

describe('layoutOptions', () => {
  it('没有纸张设置时是 A4 竖放、默认页边距和页码', () => {
    expect(layoutOptions()).toMatchObject({ width: 794, height: 1123, paperDirection: 'vertical', margins: [96, 120, 96, 120], defaultFont: '宋体', defaultSize: 16 })
    expect(layoutOptions().pageNumber).toMatchObject({ format: '第{pageNo}页 / 共{pageCount}页', rowFlex: 'center', disabled: false })
    expect(pageSize()).toEqual({ width: 794, height: 1123 })
  })

  it('文档的纸张设置盖在默认值上，页码只换给了的项；横放时实际宽高交换', () => {
    const page = { width: 794, height: 1123, paperDirection: 'horizontal' as const, pageNumber: { format: '第 {pageNo} 页' } }
    expect(layoutOptions(page).pageNumber).toMatchObject({ format: '第 {pageNo} 页', size: 12, rowFlex: 'center' })
    expect(pageSize(page)).toEqual({ width: 1123, height: 794 })
  })
})
