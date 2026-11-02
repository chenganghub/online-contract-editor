const DIGITS = '零壹贰叁肆伍陆柒捌玖'
const UNITS = ['', '拾', '佰', '仟']
// 每 4 位一组：个、万、亿、万（万亿那一组后面要补「亿」）
const GROUP_UNITS = ['', '万', '亿', '万']

/** 一组 1～4 位数字读成大写，组内的 0 合并成一个「零」，组尾的 0 不读 */
function readGroup(g: string): string {
  let s = ''
  let zero = false
  for (let i = 0; i < g.length; i++) {
    const d = g.charCodeAt(i) - 48
    if (d === 0) {
      zero = s !== ''
      continue
    }
    if (zero) s += '零'
    zero = false
    s += DIGITS[d]! + UNITS[g.length - 1 - i]!
  }
  return s
}

function readInteger(digits: string): string {
  const groups: string[] = []
  for (let end = digits.length; end > 0; end -= 4) groups.unshift(digits.slice(Math.max(0, end - 4), end))
  let out = ''
  let gap = false
  groups.forEach((g, i) => {
    const level = groups.length - 1 - i
    if (/^0+$/.test(g)) {
      // 万亿组非零、亿组全零时，「亿」还是要读出来：壹万亿
      if (level === 2 && out) out += '亿'
      if (out) gap = true
      return
    }
    if (out && (gap || g.padStart(4, '0')[0] === '0')) out += '零'
    gap = false
    out += readGroup(g) + GROUP_UNITS[level]!
  })
  return out
}

/** 人民币大写。非数字、负数、超过一万万亿（16 位整数）返回空字符串；分以下四舍五入 */
export function toChineseAmount(input: number | string): string {
  const s = String(input).replace(/[,，\s]/g, '')
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s)
  if (!m) return ''
  const frac = (m[2] ?? '').padEnd(3, '0')
  // 用 BigInt 按「分」算，避免浮点误差
  let fen = BigInt(m[1]!) * 100n + BigInt(frac.slice(0, 2))
  if (Number(frac[2]) >= 5) fen += 1n
  const yuan = fen / 100n
  if (yuan >= 10n ** 16n) return ''
  const jiao = Number((fen % 100n) / 10n)
  const cents = Number(fen % 10n)
  const int = yuan === 0n ? '' : readInteger(yuan.toString())
  if (!int && !jiao && !cents) return '零元整'
  const head = int ? `${int}元` : ''
  if (!jiao && !cents) return `${head}整`
  if (!int) return (jiao ? `${DIGITS[jiao]}角` : '') + (cents ? `${DIGITS[cents]}分` : '')
  return head + (jiao ? `${DIGITS[jiao]}角` : '零') + (cents ? `${DIGITS[cents]}分` : '')
}
