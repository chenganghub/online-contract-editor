// 公式（docs/设计/08 第 4 节，t11）：计算字段的四则运算和循环表的行内计算、列合计，浏览器和服务端同一套。
// 写法：数字、字段 key、+ - * /、括号；sum(循环字段.列) 是这一列所有行的合计。循环表的行内公式里直接写同一行的列名。
// 引用的值是空的（还没填），结果也是空的；除以 0 也是空。不用 eval
import { toChineseAmount } from './amount'
import type { FieldDef, FieldValue } from './types'

export type Formula =
  | { k: 'num'; v: number }
  | { k: 'ref'; key: string }
  | { k: 'sum'; loop: string; col: string }
  | { k: 'neg'; a: Formula }
  | { k: 'bin'; op: '+' | '-' | '*' | '/'; a: Formula; b: Formula }

export class FormulaError extends Error {}

/** 一个词：数字、名字，或者别的单个字（运算符、括号、点；认不出的字也拆出来，解析时报错） */
const TOKEN = /\s*(?:(\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|(.))/y

/** 解析公式；写错了抛 FormulaError（错在哪） */
export function parseFormula(expr: string): Formula {
  const tokens: string[] = []
  for (let pos = 0; pos < expr.length; ) {
    TOKEN.lastIndex = pos
    const m = TOKEN.exec(expr)
    // 只剩空白
    if (!m) break
    pos = TOKEN.lastIndex
    tokens.push(m[1] ?? m[2] ?? m[3]!)
  }
  let i = 0
  const peek = () => tokens[i]
  const take = (t?: string) => {
    const got = tokens[i]
    if (t !== undefined && got !== t) throw new FormulaError(got === undefined ? `公式没写完，缺「${t}」` : `这里应该是「${t}」，写的是「${got}」`)
    i++
    return got
  }
  const isName = (t: string | undefined) => !!t && /^[A-Za-z_]/.test(t)
  function expression(): Formula {
    let a = term()
    while (peek() === '+' || peek() === '-') a = { k: 'bin', op: take() as '+' | '-', a, b: term() }
    return a
  }
  function term(): Formula {
    let a = factor()
    while (peek() === '*' || peek() === '/') a = { k: 'bin', op: take() as '*' | '/', a, b: factor() }
    return a
  }
  function factor(): Formula {
    const t = peek()
    if (t === '-' || t === '+') {
      take()
      const a = factor()
      return t === '-' ? { k: 'neg', a } : a
    }
    if (t === '(') {
      take('(')
      const a = expression()
      take(')')
      return a
    }
    if (t !== undefined && /^\d/.test(t)) {
      take()
      return { k: 'num', v: Number(t) }
    }
    if (isName(t)) {
      const name = take()!
      if (peek() !== '(') return { k: 'ref', key: name }
      if (name !== 'sum') throw new FormulaError(`没有函数 ${name}（只有 sum）`)
      take('(')
      const loop = take()
      take('.')
      const col = take()
      if (!isName(loop) || !isName(col)) throw new FormulaError('sum 里要写「循环字段.列」，如 sum(items.amount)')
      take(')')
      return { k: 'sum', loop: loop!, col: col! }
    }
    throw new FormulaError(t === undefined ? '公式没写完' : `这里不能是「${t}」`)
  }
  if (!tokens.length) throw new FormulaError('公式是空的')
  const f = expression()
  if (i < tokens.length) throw new FormulaError(`多出了「${tokens[i]}」`)
  return f
}

/** 公式里引用的字段（或同一行的列）和合计的循环字段 */
export function formulaRefs(f: Formula): { refs: string[]; sums: { loop: string; col: string }[] } {
  const refs = new Set<string>()
  const sums: { loop: string; col: string }[] = []
  const visit = (n: Formula) => {
    if (n.k === 'ref') refs.add(n.key)
    else if (n.k === 'sum') sums.push({ loop: n.loop, col: n.col })
    else if (n.k === 'neg') visit(n.a)
    else if (n.k === 'bin') {
      visit(n.a)
      visit(n.b)
    }
  }
  visit(f)
  return { refs: [...refs], sums }
}

/** 字段的值当数字：去掉千分位逗号、空格、人民币符号；空的、不是数字的是 null */
export function toNumber(v: FieldValue | unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string') return null
  const s = v.replace(/[,，\s¥￥]/g, '')
  if (!/^[-+]?(\d+(\.\d*)?|\.\d+)$/.test(s)) return null
  return Number(s)
}

/**
 * 按小数位四舍五入，末尾的 0 去掉（5200、5200.5、0.33）。按十进制移位再取整（1.005 保留两位是 1.01，
 * 直接乘 100 会因为浮点误差变成 1）；很大、很小、写成科学计数法的数直接乘
 */
export function formatNumber(x: number, digits = 2): string {
  const s = String(x)
  const r = s.includes('e') ? Math.round(x * 10 ** digits) / 10 ** digits : Number(`${Math.round(Number(`${s}e${digits}`))}e-${digits}`)
  return String(Object.is(r, -0) ? 0 : r)
}

/** 算公式：get 取字段（或同一行的列）的值，sumOf 取某个循环字段某一列的合计；有一个是空的结果就是空 */
export function evalFormula(f: Formula, get: (key: string) => number | null, sumOf: (loop: string, col: string) => number | null): number | null {
  switch (f.k) {
    case 'num':
      return f.v
    case 'ref':
      return get(f.key)
    case 'sum':
      return sumOf(f.loop, f.col)
    case 'neg': {
      const a = evalFormula(f.a, get, sumOf)
      return a === null ? null : -a
    }
    case 'bin': {
      const a = evalFormula(f.a, get, sumOf)
      const b = evalFormula(f.b, get, sumOf)
      if (a === null || b === null) return null
      if (f.op === '/') return b === 0 ? null : a / b
      return f.op === '+' ? a + b : f.op === '-' ? a - b : a * b
    }
  }
}

/** 计算字段依赖的字段（金额大写的来源、公式引用的字段和合计的循环字段） */
export function computedDeps(f: FieldDef): string[] {
  const c = f.computed
  if (!c) return []
  if (c.fn === 'amountCN') return [c.from]
  const { refs, sums } = formulaRefs(parseFormula(c.expr))
  return [...new Set([...refs, ...sums.map((s) => s.loop)])]
}

/**
 * 检查一组字段定义里的公式：写法对不对、引用的字段在不在、合计的是不是循环字段的列、行内公式只引用同一行的列、有没有循环引用。
 * 返回问题列表（没问题是空的），宿主登记字段库、编辑器新建字段时用
 */
export function checkFormulas(fields: FieldDef[]): { key: string; error: string }[] {
  const out: { key: string; error: string }[] = []
  const defs = new Map(fields.map((f) => [f.key, f]))
  for (const f of fields) {
    try {
      if (f.computed?.fn === 'formula') {
        const { refs, sums } = formulaRefs(parseFormula(f.computed.expr))
        for (const r of refs) {
          const d = defs.get(r)
          if (!d) throw new FormulaError(`引用的字段 ${r} 不存在`)
          if (d.type === 'loop') throw new FormulaError(`循环字段 ${r} 要用 sum(${r}.列) 合计`)
        }
        for (const s of sums) {
          const d = defs.get(s.loop)
          if (d?.type !== 'loop') throw new FormulaError(`${s.loop} 不是循环字段`)
          if (!d.loop?.columns.includes(s.col)) throw new FormulaError(`循环字段 ${s.loop} 没有列 ${s.col}`)
        }
      }
      for (const [col, expr] of Object.entries(f.loop?.formulas ?? {})) {
        if (!f.loop!.columns.includes(col)) throw new FormulaError(`行内公式的列 ${col} 不在列里`)
        const { refs, sums } = formulaRefs(parseFormula(expr))
        if (sums.length) throw new FormulaError(`行内公式（${col}）里不能用 sum`)
        for (const r of refs) if (r === col || !f.loop!.columns.includes(r)) throw new FormulaError(`行内公式（${col}）引用的列 ${r} 不对`)
      }
    } catch (e) {
      if (!(e instanceof FormulaError)) throw e
      out.push({ key: f.key, error: e.message })
    }
  }
  if (!out.length) for (const key of cycleOf(fields)) out.push({ key, error: '公式互相引用（循环引用）' })
  return out
}

/** 计算字段按依赖排好的顺序；有循环引用的不在里面（cycleOf 给出它们） */
function computedOrder(fields: FieldDef[]): { order: FieldDef[]; cyclic: string[] } {
  const computed = new Map(fields.filter((f) => f.computed).map((f) => [f.key, f]))
  const order: FieldDef[] = []
  const state = new Map<string, 'visiting' | 'done'>()
  const cyclic = new Set<string>()
  const visit = (f: FieldDef): boolean => {
    const s = state.get(f.key)
    if (s === 'done') return true
    if (s === 'visiting') return false
    state.set(f.key, 'visiting')
    let ok = true
    for (const d of safeDeps(f)) {
      const dep = computed.get(d)
      if (dep && !visit(dep)) ok = false
    }
    state.set(f.key, 'done')
    if (ok) order.push(f)
    else cyclic.add(f.key)
    return ok
  }
  for (const f of computed.values()) visit(f)
  return { order, cyclic: [...cyclic] }
}
const cycleOf = (fields: FieldDef[]) => computedOrder(fields).cyclic
/** 依赖；公式写错了当没有依赖（checkFormulas 会报出来，算的时候结果是空） */
const safeDeps = (f: FieldDef) => {
  try {
    return computedDeps(f)
  } catch (e) {
    if (e instanceof FormulaError) return []
    throw e
  }
}

type Row = Record<string, unknown>

/** 循环表一行按行内公式算一遍（按 formulas 里写的顺序，后面的列可以用前面算出来的），不改传进来的行；公式写错的列是空 */
export function computeRow(f: FieldDef, row: Row): Row {
  const next = { ...row }
  for (const [col, expr] of Object.entries(f.loop?.formulas ?? {})) {
    let v: number | null = null
    try {
      v = evalFormula(parseFormula(expr), (k) => toNumber(next[k]), () => null)
    } catch (e) {
      if (!(e instanceof FormulaError)) throw e
    }
    next[col] = v === null ? '' : formatNumber(v)
  }
  return next
}

/** 改了这些字段（或循环表的这些列）要重算：计算字段的依赖，有行内公式、被合计的循环表的所有列 */
export function formulaTriggers(fields: FieldDef[]): Set<string> {
  const deps = new Set(fields.flatMap((f) => (f.computed ? safeDeps(f) : [])))
  const out = new Set(deps)
  for (const f of fields) if (f.type === 'loop' && (f.loop?.formulas || deps.has(f.key))) for (const c of f.loop?.columns ?? []) out.add(c)
  return out
}

/**
 * 算计算字段和循环表的行内公式。values 是现在的全部字段值；changed 给了就只算受这些字段影响的（循环字段改了就重算它的行），
 * 不给就全部重算。返回算出来的那些（计算字段的值，带行内公式结果的循环字段行），不改 values
 */
export function computeValues(fields: FieldDef[], values: Record<string, FieldValue>, changed?: ReadonlySet<string>): Record<string, FieldValue> {
  const out: Record<string, FieldValue> = {}
  const now: Record<string, FieldValue> = { ...values }
  const touched = new Set(changed ?? [])
  const hit = (keys: string[]) => !changed || keys.some((k) => touched.has(k))
  for (const f of fields) {
    if (f.type !== 'loop' || !f.loop?.formulas || !hit([f.key]) || !Array.isArray(now[f.key])) continue
    now[f.key] = out[f.key] = (now[f.key] as Row[]).map((r) => computeRow(f, r)) as FieldValue
  }
  const sumOf = (loop: string, col: string) => {
    const rows = now[loop]
    if (!Array.isArray(rows)) return null
    const nums = (rows as Row[]).map((r) => toNumber(r[col])).filter((n): n is number => n !== null)
    return nums.length ? nums.reduce((a, b) => a + b, 0) : null
  }
  for (const f of computedOrder(fields).order) {
    const c = f.computed!
    if (!hit(safeDeps(f))) continue
    let v: FieldValue
    if (c.fn === 'amountCN') {
      const src = now[c.from]
      v = src === null || src === undefined || src === '' ? null : toChineseAmount(String(src))
    } else {
      let r: number | null = null
      try {
        r = evalFormula(parseFormula(c.expr), (k) => toNumber(now[k]), sumOf)
      } catch (e) {
        if (!(e instanceof FormulaError)) throw e
      }
      v = r === null ? null : formatNumber(r, c.digits ?? 2)
    }
    now[f.key] = out[f.key] = v
    touched.add(f.key)
  }
  return out
}
