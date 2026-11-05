# Online Contract Editor

An open-source contract editor and document template designer built with Vue 3, TypeScript and canvas-editor. Embed it in business applications through the SDK, an iframe or the API.

[中文](README.md) · [MIT License](LICENSE) · [Third-party notices](THIRD_PARTY_NOTICES.md)

**[Live demo](https://chenganghub.github.io/online-contract-editor/)**: edit templates, fill contracts, place stamp images, print, and open or download Word, PDF and other files. The "范本" menu at the top switches between five sample contracts (purchase, sales, technical service, office lease, NDA); customer lookup uses sample data. Documents are saved only in your browser. Text-searchable PDFs, template publishing and collaboration require the full local stack.

GitHub Actions deploys the demo to Pages. For your own deployment, select GitHub Actions in Settings → Pages. Build with `pnpm --filter @oe/demo build --mode pages`; output is in `apps/demo/dist`.

**Development preview. Phase one has passed local acceptance.**

## Features

- Edit, fill, stamp-image and read-only modes.
- Word-style editing: font family and Chinese font sizes, text color and highlight, strikethrough and super/subscript, line spacing, numbered and bulleted lists, table grid picker, images, page breaks, format painter, find and replace, undo and redo, special symbols, date insertion, header and footer; a status bar with page number, word count, zoom and outline; page setup (paper, orientation, margins, page numbers, watermark) saved with the document and used by PDF and Word export.
- Template field insertion, selected-text conversion, Word blank recognition, preview and publishing.
- Linked customer data, dictionary snapshots, order prefill and synchronized repeated fields.
- Repeating tables, editable regions, select, radio and checkbox fields, uppercase Chinese amounts and images.
- Signature and signing-date fields bound to a signing party, with a signature-line placeholder until signed; formulas (quantity × price within a table row, column totals, arithmetic between fields), evaluated by the same code in the browser and on the server; conditional clauses shown or hidden by a select, radio or checkbox value, consistently in PDF, Word, HTML and plain text; validation rules (length, mobile number, Chinese ID number, unified social credit code, email, numeric range) flagged while filling and rejected by the server.
- Files: open Word, HTML, Markdown, plain text and JSON in the browser; download PDF (image-based), Word, HTML, plain text, page images and JSON without a server. The server produces text-searchable PDF, Word, HTML and plain text, and `POST /api/convert` converts between formats. DOCX import comes with an import report.
- Collaboration: see who is viewing and which field they are filling; several people fill fields at once with live sync (merged per field, first save wins on the same field); a body edit lock with request and hand-over, plus autosave; comments (quote the text, reply, resolve); track changes (who inserted or deleted what and when, accept or reject one by one or all; stamping cannot start while changes are pending); version history and comparison of any two versions. The server pushes over SSE; connect the editor with `sseCollab`.
- Integration: Vue component, SDK with methods and events, iframe embedding for any web page (origin allowlist), template/document REST APIs, access tokens and version control. See the [integration guide](docs/接入指南.md) (Chinese).
- Five sample business contracts in `apps/demo/src/samples.ts`; open them in the demo with `?sample=sales`, `service`, `lease` or `nda`.

Stamp images and signature fields hold images only; they do not provide certificate-based digital signatures or signature verification.

## Run locally

Verified on Windows with Node.js 24, pnpm 10.14.0 and installed Google Chrome. Other platforms have not been validated.

```powershell
pnpm install --frozen-lockfile
pnpm exec tsx apps/demo/scripts/stack.ts
```

Open `http://127.0.0.1:5173`. The script starts temporary MySQL 8, the API (3100), renderer (3200) and frontend (5173). The first run downloads MySQL; temporary database contents are discarded on exit.

To try collaboration, append `&user=Alice` to one of the printed edit or fill URLs and `&user=Bob` in a second window.

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

Word import has known first-line indentation, numbering, font and line-height differences that can change pagination. Pixel-identical Word/WPS rendering is not guaranteed. PDFs downloaded in the browser are page images without selectable text; use the server PDF for final copies. Checkbox and radio fields are written as ☑ ☐ text in Word, HTML and plain text. PDF mouse selection, mode permissions, export equivalence and WPS comparison have been checked. The project owner approved local review for phase-one acceptance. No materials were sent to an external model for this round, and no second-model final review report exists.

Collaboration is not character-level real-time co-editing: one person edits the body at a time (edit lock), while fields and editable regions can be filled by several people at once. Events are dispatched within a single server process; multi-instance deployments need a pub/sub such as Redis. The collaboration scenarios were verified with local multi-browser scripts and are not yet repository E2E tests.

The demo uses temporary storage. Production integration requires persistent database/storage, host authentication and secret configuration. See [API configuration](apps/server/src/config.ts). Workspace packages are not published to npm.

On 2026-11-03, lint, type checks, all 127 unit/integration tests and all 31 browser tests passed, including the local private-contract check. Repeating-table permission equivalence is fixed; the full browser suite uses two workers. On 2026-11-05, after the editing, file format, SDK/iframe integration, page setup and sample-contract work, lint, type checks and all 127 unit/integration tests passed; 31 browser tests passed and 1 was skipped (no private contract provided). The same checks passed after adding signature fields, formulas, conditional clauses and validation rules; their behavior in the editor, server-side value writes and PDF/Word/HTML/plain-text export was verified with local scripts, not yet as repository E2E tests. See the [verification record](docs/verification.md).

Contributions are welcome. Use synthetic reproduction data and remove contract contents, personal information and credentials before opening an issue or PR.

Keywords: contract editor, document editor, template designer, document automation, form filling, Vue 3, TypeScript, canvas-editor, Word import, DOCX export, PDF generation, 在线合同编辑器.
