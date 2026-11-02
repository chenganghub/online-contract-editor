// 16 × 16、1.5 线宽、圆头，接近 SF Symbols 的观感；样式由 .oe svg 统一控制。
// 用数据描述图形，由 Icon.vue 生成元素，不用 v-html
export interface IconShape {
  d: string[]
  /** 实心小圆点（列表符号） */
  dots?: [number, number][]
}

export const ICONS = {
  print: { d: ['M4.5 6V2.5h7V6', 'M4.5 11.5h-1a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v3.5a1 1 0 0 1-1 1h-1', 'M4.5 9.5h7v4h-7z'] },
  export: { d: ['M8 2.5v7.5', 'M5.25 5.25 8 2.5l2.75 2.75', 'M5 7.5H4a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-4a1 1 0 0 0-1-1h-1'] },
  left: { d: ['M2.5 4h11M2.5 8h7M2.5 12h9'] },
  center: { d: ['M2.5 4h11M4.5 8h7M3.5 12h9'] },
  right: { d: ['M2.5 4h11M6.5 8h7M4.5 12h9'] },
  alignment: { d: ['M2.5 4h11M2.5 8h11M2.5 12h11'] },
  list: { d: ['M6.5 4h7M6.5 8h7M6.5 12h7'], dots: [[3.25, 4], [3.25, 8], [3.25, 12]] },
  table: { d: ['M4 3h8a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 12 13H4a1.5 1.5 0 0 1-1.5-1.5v-7A1.5 1.5 0 0 1 4 3z', 'M2.5 6.5h11M6.5 6.5V13'] },
  chevronLeft: { d: ['M9.75 3.5 5.25 8l4.5 4.5'] },
  chevronRight: { d: ['M6.25 3.5 10.75 8l-4.5 4.5'] },
  xmark: { d: ['m4.5 4.5 7 7M11.5 4.5l-7 7'] },
  plus: { d: ['M8 3.5v9M3.5 8h9'] },
  checkmark: { d: ['m3.5 8.5 3 3 6-7'] },
  exclamation: { d: ['M8 3.5v6'], dots: [[8, 12.25]] },
  // 可编辑区：方框里一支笔（square.and.pencil）
  area: { d: ['M13 9v3.5a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1H7', 'M11.5 2.25l2.25 2.25L8.25 10H6V7.75z'] },
} satisfies Record<string, IconShape>

export type IconName = keyof typeof ICONS
