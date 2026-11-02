import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

export interface StoredFile {
  sha256: string
  path: string
  size: number
}

/** 文件存储接口：一期是本地目录，以后换对象存储只换实现 */
export interface FileStore {
  put(data: Buffer): Promise<StoredFile>
  get(sha256: string): Promise<Buffer>
}

/** 按内容的 sha256 存：同样的文件只存一份 */
export function localFileStore(root: string): FileStore {
  const fileOf = (sha: string) => path.join(root, sha.slice(0, 2), sha)
  return {
    async put(data) {
      const sha256 = crypto.createHash('sha256').update(data).digest('hex')
      const file = fileOf(sha256)
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, data, { flag: 'wx' }).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== 'EEXIST') throw e
      })
      return { sha256, path: path.relative(root, file), size: data.length }
    },
    get: (sha256) => fs.readFile(fileOf(sha256)),
  }
}
