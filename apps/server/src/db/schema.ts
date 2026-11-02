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
    createdAt: now('created_at'),
    updatedAt: now('updated_at'),
  },
  (t) => [index('idx_document_biz').on(t.bizKey)],
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
