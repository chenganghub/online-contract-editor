export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** 额外放进响应体的字段，例如批量操作失败的序号、页数不一致时两边的页数 */
    readonly detail?: Record<string, unknown>,
  ) {
    super(message)
  }
}
