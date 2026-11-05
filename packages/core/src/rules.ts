// 校验规则（docs/设计/08 第 4 节，t11）：字数、常用格式（手机号、身份证号、统一社会信用代码、邮箱）、数值范围。
// 编辑器填写时标出、提交时拦住，服务端写值（applyFill）时再查一遍，不合规的整次拒绝。值是空的不查（必填另算）。
// 不收宿主自己写的正则：服务端要拿它去匹配别人填的值，写得不好的正则会把服务端卡住
import { toNumber } from './formula'
import type { FieldDef, FieldRules, FieldValue } from './types'

const MOBILE = /^1[3-9]\d{9}$/
const EMAIL = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/
const ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]
const ID_CHECK = '10X98765432'
/** 统一社会信用代码用的字（GB 32100-2015：不用 I、O、Z、S、V） */
const CREDIT_CHARS = '0123456789ABCDEFGHJKLMNPQRTUWXY'
const CREDIT_WEIGHTS = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28]

/** 18 位身份证号：出生日期是真的日期、校验位对 */
export function isIdCard(s: string): boolean {
  const v = s.toUpperCase()
  if (!/^\d{17}[\dX]$/.test(v)) return false
  const [y, m, d] = [Number(v.slice(6, 10)), Number(v.slice(10, 12)), Number(v.slice(12, 14))]
  const born = new Date(Date.UTC(y, m - 1, d))
  if (y < 1900 || born.getUTCMonth() !== m - 1 || born.getUTCDate() !== d || born.getTime() > Date.now()) return false
  const sum = ID_WEIGHTS.reduce((n, w, i) => n + w * Number(v[i]), 0)
  return ID_CHECK[sum % 11] === v[17]
}

/** 统一社会信用代码：18 位，字都在规定的字符集里，校验位对 */
export function isCreditCode(s: string): boolean {
  const v = s.toUpperCase()
  if (v.length !== 18 || [...v].some((c) => !CREDIT_CHARS.includes(c))) return false
  const sum = CREDIT_WEIGHTS.reduce((n, w, i) => n + w * CREDIT_CHARS.indexOf(v[i]!), 0)
  return CREDIT_CHARS[(31 - (sum % 31)) % 31] === v[17]
}

const PATTERNS: Record<NonNullable<FieldRules['pattern']>, { test: (s: string) => boolean; message: string }> = {
  mobile: { test: (s) => MOBILE.test(s), message: '要是 11 位手机号' },
  idCard: { test: isIdCard, message: '要是 18 位身份证号' },
  creditCode: { test: isCreditCode, message: '要是 18 位统一社会信用代码' },
  email: { test: (s) => EMAIL.test(s), message: '要是邮箱地址' },
}
/** 界面上列规则用的名字 */
export const RULE_PATTERNS = (Object.keys(PATTERNS) as NonNullable<FieldRules['pattern']>[]).map((key) => ({
  key,
  label: { mobile: '手机号', idCard: '身份证号', creditCode: '统一社会信用代码', email: '邮箱' }[key],
}))

/** 一个值合不合字段的规则；合规（或者没有规则、值是空的）返回 null，否则返回原因 */
export function ruleError(f: FieldDef, value: FieldValue | undefined): string | null {
  const r = f.rules
  if (!r || value === null || value === undefined || value === '' || typeof value === 'boolean' || Array.isArray(value)) return null
  const s = String(value).trim()
  const length = [...s].length
  if (r.minLength !== undefined && length < r.minLength) return `至少 ${r.minLength} 个字`
  if (r.maxLength !== undefined && length > r.maxLength) return `最多 ${r.maxLength} 个字`
  if (r.pattern && !PATTERNS[r.pattern].test(s)) return PATTERNS[r.pattern].message
  if (r.min !== undefined || r.max !== undefined) {
    const n = toNumber(s)
    if (n === null) return '要是数字'
    if (r.min !== undefined && n < r.min) return `不能小于 ${r.min}`
    if (r.max !== undefined && n > r.max) return `不能大于 ${r.max}`
  }
  return null
}

/** 一组值里不合规的（keys 给了就只查这些） */
export function ruleErrors(fields: FieldDef[], values: Record<string, FieldValue>, keys: string[] = Object.keys(values)): { key: string; error: string }[] {
  const defs = new Map(fields.map((f) => [f.key, f]))
  return keys.flatMap((key) => {
    const f = defs.get(key)
    const error = f ? ruleError(f, values[key]) : null
    return error ? [{ key, error }] : []
  })
}
