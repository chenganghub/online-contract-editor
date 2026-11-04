// 影响排版的编辑器选项。前端编辑器和渲染页必须用同一套，否则 PDF 的分页会和屏幕上不一样（方案第 12 节）。
// 文档自己的纸张设置在 DocData.page，没有就用 A4 竖放。
import type { PageSetup } from './types'

export const DEFAULT_FONT = '宋体'
export const DEFAULT_SIZE = 16
export const A4: Required<Pick<PageSetup, 'width' | 'height' | 'margins'>> = { width: 794, height: 1123, margins: [96, 120, 96, 120] }
const PAGE_NUMBER = { format: '第{pageNo}页 / 共{pageCount}页', size: 12, color: '#8e8e93', rowFlex: 'center' as const, disabled: false }
// 水印用渲染服务配了的字体（apps/renderer/src/fonts.ts），PDF 和屏幕上一样
const WATERMARK = { color: '#aeb5c0', opacity: 0.3, size: 120, font: 'Microsoft YaHei' }

export interface LayoutOptions {
  width: number
  height: number
  paperDirection: 'vertical' | 'horizontal'
  margins: [number, number, number, number]
  pageGap: number
  defaultFont: string
  defaultSize: number
  pageNumber: { format: string; size: number; color: string; rowFlex: 'left' | 'center' | 'right'; disabled: boolean }
  /** data 为空串就是没有水印（canvas-editor 按 data 判断） */
  watermark: { data: string; color: string; opacity: number; size: number; font: string }
}

const clamp = (v: unknown, min: number, max: number, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback)

/** 文档里的水印设置是外部输入：文字最多 20 个字，颜色只认 #rrggbb，透明度、字号按范围收 */
function watermarkOf(w: PageSetup['watermark']): LayoutOptions['watermark'] {
  const data = typeof w?.data === 'string' ? w.data.trim().slice(0, 20) : ''
  return {
    data,
    color: typeof w?.color === 'string' && /^#[0-9a-f]{6}$/i.test(w.color) ? w.color : WATERMARK.color,
    opacity: clamp(w?.opacity, 0.05, 0.8, WATERMARK.opacity),
    size: clamp(w?.size, 24, 300, WATERMARK.size),
    font: WATERMARK.font,
  }
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
    watermark: watermarkOf(page?.watermark),
  }
}

/** 页面实际的宽高（横放时交换） */
export function pageSize(page?: PageSetup): { width: number; height: number } {
  const o = layoutOptions(page)
  return o.paperDirection === 'horizontal' ? { width: o.height, height: o.width } : { width: o.width, height: o.height }
}
