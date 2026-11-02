// 影响排版的编辑器选项。前端编辑器和渲染页必须用同一套，否则 PDF 的分页会和屏幕上不一样（方案第 12 节）。
// 文档自己的纸张设置在 DocData.page，没有就用 A4 竖放。
import type { PageSetup } from './types'

export const DEFAULT_FONT = '宋体'
export const DEFAULT_SIZE = 16
export const A4: Required<Pick<PageSetup, 'width' | 'height' | 'margins'>> = { width: 794, height: 1123, margins: [96, 120, 96, 120] }
const PAGE_NUMBER = { format: '第{pageNo}页 / 共{pageCount}页', size: 12, color: '#8e8e93', rowFlex: 'center' as const, disabled: false }

export interface LayoutOptions {
  width: number
  height: number
  paperDirection: 'vertical' | 'horizontal'
  margins: [number, number, number, number]
  pageGap: number
  defaultFont: string
  defaultSize: number
  pageNumber: { format: string; size: number; color: string; rowFlex: 'left' | 'center' | 'right'; disabled: boolean }
}

export function layoutOptions(page?: PageSetup): LayoutOptions {
  return {
    width: page?.width ?? A4.width,
    height: page?.height ?? A4.height,
    paperDirection: page?.paperDirection ?? 'vertical',
    // 复制一份：编辑器可能改选项里的数组，不能改到常量
    margins: [...(page?.margins ?? A4.margins)] as [number, number, number, number],
    pageGap: 24,
    defaultFont: DEFAULT_FONT,
    defaultSize: DEFAULT_SIZE,
    pageNumber: { ...PAGE_NUMBER, ...page?.pageNumber },
  }
}

/** 页面实际的宽高（横放时交换） */
export function pageSize(page?: PageSetup): { width: number; height: number } {
  const o = layoutOptions(page)
  return o.paperDirection === 'horizontal' ? { width: o.height, height: o.width } : { width: o.width, height: o.height }
}
