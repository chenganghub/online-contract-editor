# Online Contract Editor · 在线合同编辑器

基于 Vue 3、TypeScript 和 canvas-editor 的开源合同编辑器与模板设计器。支持业务数据联填、Word 导入、PDF / DOCX / HTML 等格式导出，通过 SDK、iframe 和 API 嵌入业务系统。

[English](README.en.md) · [开源说明与搜索词](docs/open-source.md) · [MIT License](LICENSE)

**[在线演示](https://chenganghub.github.io/online-contract-editor/)**：打开即可编辑模板、填写合同、放置印章、打印，打开和下载 Word、PDF 等文件；顶部「范本」可切换采购、销售、技术服务、房屋租赁、保密协议 5 份合同，客户联选使用样例数据。保存仅在当前浏览器；带文字层的 PDF 和模板发布需本地运行完整服务。

演示由 GitHub Actions 自动部署到 Pages。自行部署时，在仓库 Settings → Pages 将 Source 设为 GitHub Actions；构建命令为 `pnpm --filter @oe/demo build --mode pages`，产物位于 `apps/demo/dist`。

**开发预览版：一期功能已通过本地验收。** Word 排版保真仍有已知差异，详见下文。

## 功能

- 编辑、填写、盖章、只读四种模式。
- 按 Word / WPS 习惯编辑：字体和中文字号、颜色和突出显示、删除线和上下标、行距、编号和项目符号、按行列插表格、图片、分页符、格式刷、查找替换、撤销重做、特殊符号、插入日期、页眉页脚；底部显示页码、字数、缩放和大纲；页面设置（纸张、方向、页边距、页码、水印）随文档保存，PDF 和 Word 导出沿用。
- 模板字段插入、选中文本设为字段、Word 空白识别、预览与发布。
- 客户联选、字典快照、订单数据预填、只读字段与重复字段同步。
- 明细表循环、可编辑区域、下拉、单选、复选、金额大写、图片与印章图片。
- 文件：浏览器里打开 Word、HTML、Markdown、纯文本、JSON，下载 PDF（图片版）、Word、HTML、纯文本、每页图片、JSON，不依赖服务端；服务端出带文字层的 PDF、Word、HTML、纯文本，`POST /api/convert` 做格式转换。DOCX 导入带导入报告。
- 对接：Vue 编辑器组件、SDK（方法和事件）、iframe 嵌入（任何网页都能用，来源白名单）、模板与文档 REST API、访问令牌与版本控制，见 [接入指南](docs/接入指南.md)。
- 5 份业务合同范本（`apps/demo/src/samples.ts`），演示地址加 `?sample=sales`、`service`、`lease`、`nda` 打开。

印章功能用于放置印章图片，不提供证书签名或签名验证。

## 本地运行

当前验证环境：Windows、Node.js 24、pnpm 10.14.0、系统 Google Chrome。其他平台尚未完成验证。

```powershell
pnpm install --frozen-lockfile
pnpm exec tsx apps/demo/scripts/stack.ts
```

打开 `http://127.0.0.1:5173`。演示脚本会启动临时 MySQL 8、API（3100）、渲染服务（3200）和前端（5173）。首次运行需要下载 MySQL，退出脚本后临时数据库数据不保留。

依赖安装默认使用 `.npmrc` 配置的镜像源。渲染服务默认使用 Windows 字体和 Chrome 安装路径；可通过 `CHROME_PATH`、`FONT_CONFIG` 配置，格式见 [渲染配置](apps/renderer/src/config.ts) 和 [字体加载](apps/renderer/src/fonts.ts)。仓库不分发字体。

## 结构

```mermaid
flowchart LR
  Host[业务系统] --> Web[Vue 编辑器 / SDK]
  Web --> API[Fastify API]
  API --> DB[(MySQL)]
  API --> Renderer[Chrome 渲染服务]
  Web --> Core[文档模型与操作]
  Renderer --> Docx[DOCX 导入导出适配]
```

| 目录 | 包 | 作用 |
| --- | --- | --- |
| `packages/core` | `@oe/core` | 文档 JSON 操作库，纯函数，浏览器和 Node 共用；`src/types.ts` 是各包之间的接口约定 |
| `packages/docx` | `@oe/docx` | canvas-editor DOCX 插件的适配与修正、导入报告 |
| `packages/web` | `@oe/web` | Vue 3 编辑器组件、模板设计器和 SDK |
| `apps/server` | `@oe/server` | 服务端：模板、文档、令牌、操作接口（Fastify + MySQL 8） |
| `apps/renderer` | `@oe/renderer` | 渲染服务：无头 Chrome 页面池，出 PDF、docx、页数 |
| `apps/demo` | `@oe/demo` | 演示宿主页：模拟业务系统接入 |
| `e2e` | | 端到端测试；`helpers/serve.ts` 起本地静态服务 |

## 验证与已知限制

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm e2e
```

端到端测试依赖系统 Chrome。涉及外部真实合同的测试通过 `OE_REAL_CONTRACT` 指定本机文件，默认跳过该场景；仓库不包含真实合同。

- Word 导入仍存在首行缩进、列表编号、字体替换和行距差异，可能改变分页；不承诺与 Word / WPS 像素一致。
- 浏览器里下载的 PDF 是页面图片，不能选字；正式件用服务端出的带文字层 PDF。复选、单选在 Word、HTML、纯文本里写成 ☑ ☐。
- PDF 鼠标选字、模式权限、导出一致性及 WPS 排版对比已补测；保留已知 Word 排版差异。项目所有者已确认改用本地审查完成一期验收；本轮未向外部模型发送材料，没有第二模型终审报告。
- 演示环境用于本地试用。生产接入需要自行配置持久化数据库、存储、宿主身份认证和密钥；配置入口见 [API 配置](apps/server/src/config.ts)。
- 工作区包暂未发布到 npm。
- 2026-11-03：lint、类型检查、127 个单元与集成用例、31 个浏览器用例全部通过（含本地私有合同补测）。循环表格权限差异已修复；完整浏览器测试使用两个 worker。详见 [验证记录](docs/verification.md)。
- 2026-11-05：编辑体验、文件格式、SDK 和 iframe 对接、页码水印、合同范本两轮改动后，lint、类型检查、127 个单元与集成用例通过，浏览器用例 31 个通过、1 个跳过（真实合同未提供）。

## 开源与贡献

项目采用 [MIT](LICENSE) 许可证，第三方依赖继续遵守各自许可证，见 [第三方说明](THIRD_PARTY_NOTICES.md)。欢迎提交问题和 PR；复现材料请使用合成数据，移除合同原文、个人信息、密钥和业务凭证。

搜索关键词：在线合同编辑器、合同模板设计器、业务数据联填、Word 导入、PDF 导出、文档自动化；online contract editor, document template designer, document automation, Vue 3, TypeScript, canvas-editor, DOCX, PDF generation.
