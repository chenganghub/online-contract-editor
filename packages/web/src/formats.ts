// 格式栏的选项。改这里先看 docs/设计/04-界面规范.md 第 6 节。
import { A4, layoutOptions, type PageSetup } from '@oe/core'

/**
 * 字体和渲染服务的字体配置（apps/renderer/src/fonts.ts 的 WINDOWS_FONTS）一一对应：渲染服务没有的字体，
 * 出 PDF 时会换成替代字体，分页就和屏幕上不一样，所以这里不放别的字体。value 是写进文档的字体名。
 */
export const FONTS = [
  { value: '宋体', label: '宋体' },
  { value: '黑体', label: '黑体' },
  { value: '仿宋', label: '仿宋' },
  { value: '楷体', label: '楷体' },
  { value: 'Microsoft YaHei', label: '微软雅黑' },
  { value: 'Times New Roman', label: 'Times New Roman' },
  { value: 'Arial', label: 'Arial' },
]

/** 磅 → 编辑器的 px（96 dpi），保留两位。导出 docx 时插件按 px × 1.5 取整得半磅，正好还原成整的磅数 */
const px = (pt: number) => Math.round((pt * 400) / 3) / 100
/** 中文字号（Word / WPS 的叫法） */
export const SIZES = (
  [
    ['初号', 42], ['小初', 36], ['一号', 26], ['小一', 24], ['二号', 22], ['小二', 18], ['三号', 16],
    ['小三', 15], ['四号', 14], ['小四', 12], ['五号', 10.5], ['小五', 9], ['六号', 7.5],
  ] as const
).map(([label, pt]) => ({ label, value: px(pt) }))

/** 字号框显示的文字：中文字号；不在列表里的（导入的、旧文档的）显示磅数 */
export function sizeLabel(size: number): string {
  return SIZES.find((s) => Math.abs(s.value - size) < 0.05)?.label ?? String(Math.round(size * 0.75 * 10) / 10)
}

/** 行距（canvas-editor 的 rowMargin 倍数；docx 插件按它算行高） */
export const ROW_MARGINS = [1, 1.25, 1.5, 1.75, 2, 2.5, 3]

// 调色板里是正文的颜色（内容），不是界面颜色，不受界面规范「主色加灰」的限制
export const TEXT_COLORS = ['#000000', '#595959', '#a6a6a6', '#c00000', '#ff0000', '#ed7d31', '#00b050', '#0070c0', '#002060', '#7030a0']
export const HIGHLIGHTS = ['#ffff00', '#ffe699', '#c6efce', '#bdd7ee', '#f8cbad', '#d9d9d9', '#00ffff', '#ff99cc', '#ccc0da', '#a9d08e']

/** 纸张（竖放的宽高，px，96 dpi） */
export const PAPERS = [
  { label: 'A4', width: A4.width, height: A4.height },
  { label: 'A3', width: 1123, height: 1587 },
  { label: 'A5', width: 559, height: 794 },
  { label: 'B5', width: 688, height: 971 },
  { label: '16 开', width: 695, height: 983 },
  { label: 'Letter', width: 816, height: 1056 },
]

/** 页码格式（canvas-editor 的 pageNumber.format）；第一项是 @oe/core 的默认值 */
export const PAGE_NUMBER_FORMATS = [
  { value: '第{pageNo}页 / 共{pageCount}页', label: '第 1 页 / 共 N 页' },
  { value: '第{pageNo}页', label: '第 1 页' },
  { value: '{pageNo} / {pageCount}', label: '1 / N' },
  { value: '- {pageNo} -', label: '- 1 -' },
]
/** 水印常用文字（输入框的候选，也可以自己写） */
export const WATERMARKS = ['草稿', '样稿', '机密', '内部资料', '副本', '作废']
/** 合同里常用的符号：勾选框、序号、货币、单位、数学、标点 */
export const SYMBOLS = [...'☐☑☒■□●○◆◇★☆※√×①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳￥$€£%‰℃°㎡㎥㎏㎎㎞㎜㎝±÷≈≠≤≥∞§№™®©—…·「」『』【】〔〕《》〈〉←→↑↓']
/** 今天的日期，两种写法 */
export function todayTexts(now = new Date()): string[] {
  const y = now.getFullYear()
  const m = now.getMonth() + 1
  const d = now.getDate()
  return [`${y}年${m}月${d}日`, `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`]
}

export const mm = (pxValue: number) => Math.round((pxValue * 254) / 96) / 10
export const fromMm = (mmValue: number) => Math.round((mmValue * 96) / 25.4)

/**
 * 页边距：文档里按竖放存「上、右、下、左」；横放时编辑器把它转 90°，页面上看到的是（上、右、下、左 ← 右、下、左、上）。
 * 界面上让人填看到的，换算后再存
 */
export function shownMargins(page: PageSetup | undefined): [number, number, number, number] {
  const o = layoutOptions(page)
  const m = o.margins
  return o.paperDirection === 'horizontal' ? [m[1], m[2], m[3], m[0]] : [m[0], m[1], m[2], m[3]]
}
export function storedMargins(shown: [number, number, number, number], horizontal: boolean): [number, number, number, number] {
  return horizontal ? [shown[3], shown[0], shown[1], shown[2]] : [...shown]
}

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent)
/**
 * 快捷键提示。默认的修饰键和 canvas-editor 一样：Mac 上是 ⌘，其他系统是 Ctrl；
 * ctrl: true 是不分系统都按 Control 的（canvas-editor 的删除线、标题快捷键）
 */
export function shortcut(key: string, o: { shift?: boolean; alt?: boolean; ctrl?: boolean } = {}): string {
  if (IS_MAC) return `${o.ctrl ? '⌃' : '⌘'}${o.alt ? '⌥' : ''}${o.shift ? '⇧' : ''}${key}`
  return ['Ctrl', o.alt && 'Alt', o.shift && 'Shift', key].filter(Boolean).join('+')
}
/** 按钮的悬停提示：名称加快捷键 */
export const tip = (name: string, keys?: string) => (keys ? `${name}（${keys}）` : name)

/** 光标处的文字样式（rangeStyleChange 给的），格式栏按它显示 */
export interface FormatState {
  bold: boolean
  italic: boolean
  underline: boolean
  strikeout: boolean
  /** 元素类型：上标、下标时是 superscript / subscript */
  type: string
  font: string
  size: number
  color: string | null
  highlight: string | null
  rowFlex: string
  rowMargin: number
  /** ol、ul，不在列表里是空串 */
  listType: string
  level: string
  painter: boolean
  undo: boolean
  redo: boolean
  /** 光标在可编辑区里 */
  area: boolean
  /** 能设可编辑区（选中了文字，或光标在区域里） */
  canArea: boolean
}
