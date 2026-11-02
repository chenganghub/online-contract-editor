import { afterEach, describe, expect, it, vi } from 'vitest'
import { uid } from './ids'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const real = globalThis.crypto
const many = () => new Set(Array.from({ length: 200 }, () => uid()))

describe('uid', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('有 randomUUID 时用它', () => {
    const ids = many()
    expect(ids.size).toBe(200)
    for (const id of ids) expect(id).toMatch(UUID)
  })

  it('没有 randomUUID（内网 http 部署）时用 getRandomValues 拼，格式一样、不重复', () => {
    const getRandomValues = vi.fn((b: Uint8Array<ArrayBuffer>) => real.getRandomValues(b))
    vi.stubGlobal('crypto', { getRandomValues })
    const ids = many()
    expect(getRandomValues).toHaveBeenCalled()
    expect(ids.size).toBe(200)
    for (const id of ids) expect(id).toMatch(UUID)
  })

  it('连 crypto 都没有时也能用', () => {
    vi.stubGlobal('crypto', undefined)
    const ids = many()
    expect(ids.size).toBe(200)
    for (const id of ids) expect(id).toMatch(UUID)
  })
})
