# Online Contract Editor

An open-source contract editor and document template designer built with Vue 3, TypeScript and canvas-editor. Embed it in business applications through the SDK and API.

[中文](README.md) · [MIT License](LICENSE) · [Third-party notices](THIRD_PARTY_NOTICES.md)

**[Live demo](https://chenganghub.github.io/online-contract-editor/)**: edit templates, fill contracts, place stamp images and print with sample customer data. Documents are saved only in your browser. Word import, server exports and template publishing require the full local stack.

GitHub Actions deploys the demo to Pages. For your own deployment, select GitHub Actions in Settings → Pages. Build with `pnpm --filter @oe/demo build --mode pages`; output is in `apps/demo/dist`.

**Development preview. Phase one has passed local acceptance.**

## Features

- Edit, fill, stamp-image and read-only modes.
- Template field insertion, selected-text conversion, Word blank recognition, preview and publishing.
- Linked customer data, dictionary snapshots, order prefill and synchronized repeated fields.
- Repeating tables, editable regions, uppercase Chinese amounts and images.
- Word / DOCX import with an import report, PDF / DOCX export and printing.
- Vue component, host SDK, template/document APIs, access tokens and version control.

Stamp images do not provide certificate-based digital signatures or signature verification.

## Run locally

Verified on Windows with Node.js 24, pnpm 10.14.0 and installed Google Chrome. Other platforms have not been validated.

```powershell
pnpm install --frozen-lockfile
pnpm exec tsx apps/demo/scripts/stack.ts
```

Open `http://127.0.0.1:5173`. The script starts temporary MySQL 8, the API (3100), renderer (3200) and frontend (5173). The first run downloads MySQL; temporary database contents are discarded on exit.

The renderer defaults to Windows fonts and Chrome paths. See [configuration](apps/renderer/src/config.ts) and [font loading](apps/renderer/src/fonts.ts) for `CHROME_PATH` and `FONT_CONFIG`. Fonts are not distributed. The npm registry mirror is configured in `.npmrc`.

## Packages

| Directory | Purpose |
| --- | --- |
| `packages/core` | Shared document model and operations |
| `packages/docx` | DOCX plugin adapter, corrections and import reports |
| `packages/web` | Vue editor, template designer and SDK |
| `apps/server` | Fastify API with MySQL |
| `apps/renderer` | Chrome rendering service for PDF, DOCX and page counts |
| `apps/demo` | Example host application |
| `e2e` | Playwright integration tests |

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm e2e
```

E2E tests use installed Chrome. The optional external contract test requires `OE_REAL_CONTRACT`; real contracts are excluded from this repository.

## Limitations

Word import has known first-line indentation, numbering, font and line-height differences that can change pagination. Pixel-identical Word/WPS rendering is not guaranteed. PDF mouse selection, mode permissions, export equivalence and WPS comparison have been checked. The project owner approved local review for phase-one acceptance. No materials were sent to an external model for this round, and no second-model final review report exists.

The demo uses temporary storage. Production integration requires persistent database/storage, host authentication and secret configuration. See [API configuration](apps/server/src/config.ts). Workspace packages are not published to npm.

On 2026-11-03, lint, type checks, all 127 unit/integration tests and all 31 browser tests passed, including the local private-contract check. Repeating-table permission equivalence is fixed; the full browser suite uses two workers. see the [verification record](docs/verification.md).

Contributions are welcome. Use synthetic reproduction data and remove contract contents, personal information and credentials before opening an issue or PR.

Keywords: contract editor, document editor, template designer, document automation, form filling, Vue 3, TypeScript, canvas-editor, Word import, DOCX export, PDF generation, 在线合同编辑器.
