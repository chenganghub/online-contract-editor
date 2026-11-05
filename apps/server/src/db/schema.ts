// 表结构（方案第 5 节 + 第 12 节的令牌和权限表）。改了这里要重新生成迁移：pnpm --filter @oe/server db:generate
import { sql } from 'drizzle-orm'
import { boolean, datetime, int, json, mysqlEnum, mysqlTable, primaryKey, uniqueIndex, varchar, char, bigint, index } from 'drizzle-orm/mysql-core'
import type { DocData, DocValues, FieldDef, Mode, Permission } from '@oe/core'

const id = (name = 'id') => varchar(name, { length: 36 })
const now = (name: string) => datetime(name, { mode: 'date', fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`)

export const apiClient = mysqlTable('api_client', {
  id: id().primaryKey(),
  name: varchar('name', { length: 100 }).notNull(),
  keyHash: char('key_hash', { length: 64 }).notNull().unique(),
  status: mysqlEnum('status', ['active', 'disabled']).notNull().default('active'),
  createdAt: now('created_at'),
})

export const template = mysqlTable('template', {
  id: id().primaryKey(),
  name: varchar('name', { length: 200 }).notNull(),
  category: varchar('category', { length: 100 }),
  status: mysqlEnum('status', ['active', 'archived']).notNull().default('active'),
  createdBy: varchar('created_by', { length: 100 }).notNull(),
  createdAt: now('created_at'),
})

export const templateVersion = mysqlTable(
  'template_version',
  {
    id: id().primaryKey(),
    templateId: id('template_id').notNull(),
    versionNo: int('version_no').notNull(),
    doc: json('doc_json').$type<DocData>().notNull(),
    fields: json('fields_json').$type<FieldDef[]>().notNull(),
    publishedAt: now('published_at'),
  },
  (t) => [uniqueIndex('uq_template_version').on(t.templateId, t.versionNo)],
)

export const document = mysqlTable(
  'document',
  {
    id: id().primaryKey(),
    templateVersionId: id('template_version_id').notNull(),
    bizKey: varchar('biz_key', { length: 100 }),
    title: varchar('title', { length: 200 }).notNull(),
    status: mysqlEnum('status', ['filling', 'sealing', 'sealed', 'void']).notNull().default('filling'),
    doc: json('doc_json').$type<DocData>().notNull(),
    values: json('values_json').$type<DocValues>().notNull(),
    fields: json('fields_json').$type<FieldDef[]>().notNull(),
    pageCount: int('page_count'),
    version: int('version').notNull().default(1),
    lockedAt: datetime('locked_at', { mode: 'date', fsp: 3 }),
    // 多人编辑（08 第 3 节）：每个字段最后在哪一版被谁改的（填写时按字段合并用）；正文最后在哪一版整份保存过
    fieldVersions: json('field_versions').$type<Record<string, { v: number; by: string; name?: string; conn?: string }>>(),
    bodyVersion: int('body_version').notNull().default(1),
    // 正文编辑锁：谁拿着、哪个事件流连接、到什么时候（续约顺延，过期就当没锁）
    editLockUser: varchar('edit_lock_user', { length: 100 }),
    editLockName: varchar('edit_lock_name', { length: 100 }),
    editLockConn: varchar('edit_lock_conn', { length: 36 }),
    editLockExpires: datetime('edit_lock_expires', { mode: 'date', fsp: 3 }),
    /** 签署截止时间（t12）：过了就不能开始签署、不能签 */
    signDeadline: datetime('sign_deadline', { mode: 'date', fsp: 3 }),
    createdAt: now('created_at'),
    updatedAt: now('updated_at'),
  },
  (t) => [index('idx_document_biz').on(t.bizKey)],
)

/**
 * 签署方（docs/设计/08 第 5 节，t12）：宿主设，按 order_no 从小到大签，一样的同时签。
 * key 对应签名区、签署日期字段的 signer（a 甲方、b 乙方……）；签署令牌的 userId 要和 user_id 一样
 */
export const signer = mysqlTable(
  'signer',
  {
    id: id().primaryKey(),
    documentId: id('document_id').notNull(),
    key: varchar('signer_key', { length: 32 }).notNull(),
    name: varchar('name', { length: 100 }).notNull(),
    kind: mysqlEnum('kind', ['person', 'org']).notNull().default('person'),
    userId: varchar('user_id', { length: 100 }).notNull(),
    orderNo: int('order_no').notNull(),
    /** 签之前要不要意愿认证（宿主登记的凭据，见 sign_intent） */
    intentRequired: boolean('intent_required').notNull().default(true),
    status: mysqlEnum('status', ['waiting', 'signed', 'rejected']).notNull().default('waiting'),
    intentMethod: varchar('intent_method', { length: 20 }),
    intentProof: varchar('intent_proof', { length: 200 }),
    signedAt: datetime('signed_at', { mode: 'date', fsp: 3 }),
    rejectReason: varchar('reject_reason', { length: 500 }),
  },
  (t) => [uniqueIndex('uq_signer').on(t.documentId, t.key)],
)

/** 意愿认证凭据：宿主做完短信验证码、人脸等之后用 API Key 登记，签署时用一次，10 分钟内有效 */
export const signIntent = mysqlTable('sign_intent', {
  id: id().primaryKey(),
  documentId: id('document_id').notNull(),
  signerKey: varchar('signer_key', { length: 32 }).notNull(),
  method: mysqlEnum('method', ['sms', 'face', 'password', 'cert', 'other']).notNull(),
  /** 宿主那边的凭据号（短信验证记录、人脸核验流水号），原样记进证据 */
  proof: varchar('proof', { length: 200 }).notNull(),
  expiresAt: datetime('expires_at', { mode: 'date', fsp: 3 }).notNull(),
  usedAt: datetime('used_at', { mode: 'date', fsp: 3 }),
  createdAt: now('created_at'),
})

/**
 * 证据链：签署过程每一步一条（谁、什么时候、IP、设备、当时的文档哈希、细节）。
 * hash = SHA-256(上一条的 hash + 这一条的内容)，第一条的上一条是 64 个 0；改了、删了哪一条，往后的都对不上
 */
export const signEvidence = mysqlTable(
  'sign_evidence',
  {
    id: id().primaryKey(),
    documentId: id('document_id').notNull(),
    seq: int('seq').notNull(),
    action: varchar('action', { length: 20 }).notNull(),
    signerKey: varchar('signer_key', { length: 32 }),
    operator: varchar('operator', { length: 100 }).notNull(),
    operatorName: varchar('operator_name', { length: 100 }).notNull(),
    ip: varchar('ip', { length: 64 }),
    userAgent: varchar('user_agent', { length: 300 }),
    docHash: char('doc_hash', { length: 64 }).notNull(),
    detail: json('detail_json').$type<Record<string, unknown>>().notNull(),
    prevHash: char('prev_hash', { length: 64 }).notNull(),
    hash: char('hash', { length: 64 }).notNull(),
    at: datetime('at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (t) => [uniqueIndex('uq_evidence').on(t.documentId, t.seq)],
)

/** 签署完成后出的最终 PDF（带数字签名），文件按 sha256 存在文件存储里；验签时按哈希认出是哪份合同 */
export const signedFile = mysqlTable(
  'signed_file',
  {
    id: id().primaryKey(),
    documentId: id('document_id').notNull(),
    version: int('version').notNull(),
    sha256: char('sha256', { length: 64 }).notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    pageCount: int('page_count').notNull(),
    certSubject: varchar('cert_subject', { length: 300 }).notNull(),
    certSerial: varchar('cert_serial', { length: 100 }).notNull(),
    testCert: boolean('test_cert').notNull(),
    at: now('at'),
  },
  (t) => [uniqueIndex('uq_signed_file').on(t.documentId, t.version), index('idx_signed_file_sha').on(t.sha256)],
)

/** 批注：不进文档 JSON、不进导出；按引用的原文和第几处定位（原文改了就找不到，界面上提示） */
export const comment = mysqlTable(
  'comment',
  {
    id: id().primaryKey(),
    documentId: id('document_id').notNull(),
    /** 回复时是被回复的那条批注 */
    parentId: id('parent_id'),
    quote: varchar('quote', { length: 500 }),
    occurrence: int('occurrence'),
    body: varchar('body', { length: 2000 }).notNull(),
    authorId: varchar('author_id', { length: 100 }).notNull(),
    authorName: varchar('author_name', { length: 100 }).notNull(),
    resolved: boolean('resolved').notNull().default(false),
    createdAt: now('created_at'),
    updatedAt: now('updated_at'),
  },
  (t) => [index('idx_comment_document').on(t.documentId)],
)

/** 版本历史：编辑模式整份保存、状态变化时存一份快照，版本对比用 */
export const documentRevision = mysqlTable(
  'document_revision',
  {
    id: id().primaryKey(),
    documentId: id('document_id').notNull(),
    version: int('version').notNull(),
    reason: varchar('reason', { length: 50 }).notNull(),
    doc: json('doc_json').$type<DocData>().notNull(),
    values: json('values_json').$type<DocValues>().notNull(),
    operator: varchar('operator', { length: 100 }).notNull(),
    operatorName: varchar('operator_name', { length: 100 }),
    at: now('at'),
  },
  (t) => [uniqueIndex('uq_revision').on(t.documentId, t.version)],
)

export const sealRecord = mysqlTable('seal_record', {
  // 印章 id 由客户端生成（用来去重），前端的写法是 seal-<uuid>，比 uuid 长
  id: varchar('id', { length: 100 }).primaryKey(),
  documentId: id('document_id').notNull(),
  sealId: varchar('seal_id', { length: 100 }).notNull(),
  sealName: varchar('seal_name', { length: 100 }).notNull(),
  imageHash: char('image_hash', { length: 64 }).notNull(),
  pageNo: int('page_no').notNull(),
  x: int('x').notNull(),
  y: int('y').notNull(),
  width: int('width').notNull(),
  height: int('height').notNull(),
  operator: varchar('operator', { length: 100 }).notNull(),
  at: now('at'),
  status: mysqlEnum('status', ['valid', 'void']).notNull().default('valid'),
  /** 设了签署方的文档：哪个签署方盖的（只有他能移、删，签完就不能动了） */
  signerKey: varchar('signer_key', { length: 32 }),
})

export const operationLog = mysqlTable('operation_log', {
  id: id().primaryKey(),
  documentId: id('document_id').notNull(),
  ops: json('ops_json').notNull(),
  result: json('result_json').notNull(),
  operator: varchar('operator', { length: 100 }).notNull(),
  at: now('at'),
})

export const fileAsset = mysqlTable('file_asset', {
  id: id().primaryKey(),
  kind: mysqlEnum('kind', ['docx', 'pdf', 'image', 'other']).notNull(),
  path: varchar('path', { length: 500 }).notNull(),
  sha256: char('sha256', { length: 64 }).notNull(),
  size: bigint('size', { mode: 'number' }).notNull(),
  createdAt: now('created_at'),
})

export const docToken = mysqlTable('doc_token', {
  id: id().primaryKey(),
  documentId: id('document_id').notNull(),
  mode: mysqlEnum('mode', ['edit', 'fill', 'seal', 'view']).$type<Mode>().notNull(),
  userId: varchar('user_id', { length: 100 }).notNull(),
  /** 显示用的名字（在场、批注、修订、编辑锁里显示）；宿主签发时给，不给就显示 userId */
  userName: varchar('user_name', { length: 100 }),
  /** 签署令牌绑定的签署方（signer.signer_key，t12）；只有盖章模式的令牌能绑 */
  signerKey: varchar('signer_key', { length: 32 }),
  // 能不能打印、下载（方案 4.2「按令牌权限显示打印、下载按钮」）；下载在 /export 校验，打印只能在前端拦
  canPrint: boolean('can_print').notNull().default(true),
  canDownload: boolean('can_download').notNull().default(true),
  expiresAt: datetime('expires_at', { mode: 'date', fsp: 3 }).notNull(),
  revokedAt: datetime('revoked_at', { mode: 'date', fsp: 3 }),
  createdAt: now('created_at'),
})

export const tokenPermission = mysqlTable(
  'token_permission',
  {
    tokenId: id('token_id').notNull(),
    fieldKey: varchar('field_key', { length: 100 }).notNull(),
    permission: mysqlEnum('permission', ['editable', 'readonly', 'required', 'hidden']).$type<Permission>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.tokenId, t.fieldKey] })],
)

/** 每个宿主一份字段库；模板版本保存所选定义的快照。 */
export const fieldLibrary = mysqlTable('field_library', {
  clientId: id('client_id').primaryKey(),
  version: int('version').notNull(),
  fields: json('fields_json').$type<FieldDef[]>().notNull(),
})

/** 可修改的工作稿；正式合同只引用 template_version。 */
export const templateDraft = mysqlTable('template_draft', {
  templateId: id('template_id').primaryKey(),
  clientId: id('client_id').notNull(),
  doc: json('doc_json').$type<DocData>().notNull(),
  fields: json('fields_json').$type<FieldDef[]>().notNull(),
  version: int('version').notNull().default(1),
})

export const templateEditToken = mysqlTable('template_edit_token', {
  id: id().primaryKey(),
  templateId: id('template_id').notNull(),
  userId: varchar('user_id', { length: 100 }).notNull(),
  expiresAt: datetime('expires_at', { mode: 'date', fsp: 3 }).notNull(),
  revokedAt: datetime('revoked_at', { mode: 'date', fsp: 3 }),
})
