import type { OpErrorCode } from './types'

/** 操作失败：applyBatch 捕获后转成 { ok: false, index, code, error }；field 是出错的字段（有的话） */
export class OpError extends Error {
  field?: string
  constructor(
    readonly code: OpErrorCode,
    message: string,
    field?: string,
  ) {
    super(message)
    this.field = field
  }
}
