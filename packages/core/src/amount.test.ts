import { describe, expect, it } from 'vitest'
import { toChineseAmount } from './amount'

describe('toChineseAmount', () => {
  it.each([
    [0, '零元整'],
    [1, '壹元整'],
    [10, '壹拾元整'],
    [15, '壹拾伍元整'],
    [100.05, '壹佰元零伍分'],
    [1.5, '壹元伍角'],
    [1.05, '壹元零伍分'],
    [0.5, '伍角'],
    [0.05, '伍分'],
    [0.55, '伍角伍分'],
    [1001, '壹仟零壹元整'],
    [1010, '壹仟零壹拾元整'],
    [100100, '壹拾万零壹佰元整'],
    [10001000, '壹仟万壹仟元整'],
    [358600, '叁拾伍万捌仟陆佰元整'],
    [100000001, '壹亿零壹元整'],
    ['1,234,567.89', '壹佰贰拾叁万肆仟伍佰陆拾柒元捌角玖分'],
    ['1000000000000', '壹万亿元整'],
    ['1000100000000', '壹万零壹亿元整'],
    ['100010000000000', '壹佰万零壹佰亿元整'],
  ])('%s → %s', (input, expected) => {
    expect(toChineseAmount(input)).toBe(expected)
  })

  it('分以下四舍五入，按分计算不受浮点误差影响', () => {
    expect(toChineseAmount('0.995')).toBe('壹元整')
    expect(toChineseAmount('2.004')).toBe('贰元整')
    expect(toChineseAmount('0.1')).toBe('壹角')
  })

  it('非法输入返回空字符串', () => {
    expect(toChineseAmount('abc')).toBe('')
    expect(toChineseAmount('-1')).toBe('')
    expect(toChineseAmount('1'.padEnd(17, '0'))).toBe('')
  })
})
