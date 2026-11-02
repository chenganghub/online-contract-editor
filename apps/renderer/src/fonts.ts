import fs from 'node:fs'
import { z } from 'zod'

/**
 * 字体配置。一期跑在 Windows Server 上，Chrome 按名称用系统字体排版，和用户电脑一致（decisions 第 17 条）；
 * 以后换 Linux 时同一份配置改成开源字体文件，不改代码。
 */
export interface FontConfig {
  /** 合同里可能用到的字体：名称 → 字体文件。启动时检查文件都在，文档用了配置外的字体会在结果里提示 */
  families: Record<string, string>
  /** PDF 文字层嵌入的字体文件，按顺序找第一个有这个字的。文字层看不见，只为字能选、能搜 */
  textLayer: string[]
}

export const WINDOWS_FONTS: FontConfig = {
  families: {
    宋体: 'C:/Windows/Fonts/simsun.ttc',
    黑体: 'C:/Windows/Fonts/simhei.ttf',
    仿宋: 'C:/Windows/Fonts/simfang.ttf',
    楷体: 'C:/Windows/Fonts/simkai.ttf',
    'Microsoft YaHei': 'C:/Windows/Fonts/msyh.ttc',
    'Times New Roman': 'C:/Windows/Fonts/times.ttf',
    Arial: 'C:/Windows/Fonts/arial.ttf',
  },
  // 黑体缺的西文符号（如 ¥）用 Arial 补
  textLayer: ['C:/Windows/Fonts/simhei.ttf', 'C:/Windows/Fonts/arial.ttf'],
}

const schema = z.object({ families: z.record(z.string(), z.string()), textLayer: z.array(z.string()).min(1) })

export function loadFontConfig(file?: string): FontConfig {
  if (!file) return WINDOWS_FONTS
  return schema.parse(JSON.parse(fs.readFileSync(file, 'utf8')))
}

/** 启动检查：配置里的字体文件缺一个就不启动，免得悄悄用替代字体排版、分页和屏幕不一致 */
export function checkFonts(cfg: FontConfig): void {
  const missing = [...Object.values(cfg.families), ...cfg.textLayer].filter((f) => !fs.existsSync(f))
  if (missing.length) throw new Error(`字体文件不存在，渲染服务不启动：${[...new Set(missing)].join('、')}`)
}
