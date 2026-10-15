# Chia

A calm home for docs, sheets and slides, with its own editor, plus an MCP endpoint that lets local AI agents create documents. Signing in with Google, or linking Google later, turns on automatic Drive backup.

- `api/`: FastAPI, the official MCP Python SDK and Google API clients. WeasyPrint, python-docx, python-pptx and openpyxl load only when a server-side export runs, so the API starts fast (and fits a slim Lambda)
- `web/`: React with a TipTap editor (bold, italic, underline, font size, alignment, Letter/A4 pages, a right-click format menu, print, and export). The editor header follows Google Docs: title and save status on top, then a tool strip whose groups move into a ⋮ menu when the window is narrow

## Run

```sh
cd api && cp -n .env.example .env   # first run only; fill in secrets
uv run fastapi dev app/main.py      # REST at /api, MCP at /mcp, OpenAPI docs at /docs
                                    # (applies database migrations on startup)

cd web && npm install && npm run dev
```

The root account is created on first start from `ROOT_*` in `api/.env`. You can sign in with either the username or the email.

## Google Workspace setup (one time)

1. In Google Cloud Console, create a project and enable the **Google Drive**, **Google Docs**, **Google Sheets** and **Google Slides** APIs. From the CLI: `gcloud services enable drive.googleapis.com docs.googleapis.com sheets.googleapis.com slides.googleapis.com`.
2. Configure the OAuth consent screen: External, Testing mode, and add your Google account as a test user. Chia only asks for `drive.file`, a non-sensitive scope, so it needs no Google verification.
3. Create an OAuth client ID of type **Web application** with the redirect URI `http://localhost:8000/api/google/callback`. Google offers no CLI for this step.
4. Put `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `api/.env` and restart the API.
5. Use **Continue with Google** on the login screen (this creates the account on first use), or **Back up to Google Drive** in the sidebar for password accounts.

Stopping backup from the sidebar revokes Chia's access; existing backups stay in Drive.

Optional, for **Import › Pick from Google Drive**: enable the Picker API (`gcloud services enable picker.googleapis.com`), create an API key restricted to the Picker API and to `http://localhost:5173`, then set `GOOGLE_API_KEY` and `GOOGLE_APP_ID` (the project *number*, from `gcloud projects describe <project> --format='value(projectNumber)'`) in `api/.env`. Without them, Google files import by link.

## Import

**Import** in the library (or dropping files onto it) brings in:

- **Word** `.docx` as a doc: headings, lists, bold/italic/underline, font size, alignment, page size, text colour snapped to Chia's palette, tables (header rows, cells merged across, column widths) and pictures (sized as in Word). Cells merged down a column are split, tables inside tables become plain lines, and drawings Chia can't show (Word shapes, EMF) are left out. The toast says what was changed.
- **Excel** `.xlsx` and **CSV** as sheets: one sheet per worksheet, with formula results as values. The first 5,000 rows are kept.
- **PowerPoint** `.pptx` as slides: titles, text and bullets.
- **Markdown** and **text** as docs.
- **Google Docs, Sheets and Slides** by link, either through the user's linked Google account or Google's public export for files shared "Anyone with the link". When the Picker is configured, users can also pick files from Drive.

Legacy `.doc`, `.xls`, `.ppt` and OpenDocument files are refused with a "save as .docx/.xlsx/.pptx" hint. Uploads are limited to 25 MB.

## Pictures, tables and diagrams

- **Pictures:** toolbar **Image**, paste, or drop into the page. Large photos are scaled to 2400 px; WebP, AVIF, BMP and SVG become PNG or JPEG so every export can embed them. Select a picture to resize it (handles or S/M/L/Full), align it, add alt text or replace it. Image bytes live in blob storage (`api/.local_storage/` locally, S3 with `STORAGE_BACKEND=s3`), with their details in the `asset` table, and are served at `/api/assets/{id}` (with S3, a redirect to a short-lived presigned URL). That URL is public by design (`<img>` can't send the bearer token), so its long random id is the key. Deleting a doc removes images no other doc uses (tracked in `assetreference`).
- **Tables:** toolbar **Table** (pick a size on the grid). With the cursor in a table, a bar above it adds or removes rows and columns, merges or splits cells and toggles the header row; the same tools are on right-click. Drag column edges to resize. Tables break across pages between rows, so merges stay within a row.
- **Diagrams:** toolbar **Diagram** opens an editor with templates (flowchart, sequence, mind map, org chart, timeline, schedule, pie, quadrant, states, journey, data model, classes) and a live preview. Diagrams are written in [Mermaid](https://mermaid.js.org) and drawn in Chia's palette and type, redrawn for light or dark mode. A light-mode picture is stored with each diagram for PDF, Word and Google exports. MCP clients add diagrams as ```` ```mermaid ```` blocks in markdown; their picture is made the first time the doc is opened.

## Storage, backup and export

- **Storage:** Chia's database is the source of truth: SQLite locally, Postgres (`DATABASE_URL=postgresql+psycopg://...`) in production. Schema changes are Alembic migrations in `api/migrations` (`uv run alembic upgrade head`; the API runs it on startup unless `AUTO_MIGRATE=false`). Document bodies larger than `INLINE_CONTENT_MAX_BYTES` (64 KB of JSON by default) are gzipped into blob storage as `docs/{id}/rev-{revision}-{nonce}.json.gz`, with a stub in the row; reads fetch them transparently, and blobs go when their last revision snapshot is pruned or the document is deleted.
- **Workspaces:** every user has a personal workspace, and requests without an `X-Workspace-Id` header use it, so solo use needs no setup. Teams create `team` or `enterprise` workspaces (`/api/workspaces`) with owner, admin, editor and viewer roles, and single documents can be shared with a person or one agent's key (`/api/documents/{id}/shares`). Documents shared with you from another workspace carry a **Shared** badge in your library.
- **Public links:** **Share › Public link** gives a read-only link, `/p/{token}`, that anyone can open without signing in (`POST /api/documents/{id}/shares {"principal_type": "public_link"}`; the page reads `GET /api/public/{token}`). Turning it off (deleting the share) revokes it at once.
- **Backup:** for users signed in with or linked to Google, each document is mirrored as a native Google Doc, Sheet or Slides file in a `Chia` folder in the creator's Drive. Saves mark the document `pending`; the mirror is written about 4 seconds after the last edit by a runner inside the API (`DRIVE_SYNC_RUNNER=local`) or by `app.worker` (a scheduled Lambda or `uv run python -m app.worker`). The state lives in the database, so pending backups survive restarts.
- **Export:** the **Export** button in every editor.
  - PDF, all kinds: **Export › PDF** (or Ctrl+P) opens the browser's print dialog; **Save as PDF** gives a vector PDF with no server work. Docs print on their Letter/A4 pages, slides one per 16:9 landscape page, sheets on landscape paper with formulas evaluated.
  - Docs: `GET /api/documents/{id}/export/pdf?background=%23F7F4ED` (server-rendered PDF with any page colour; answers 501 where WeasyPrint's native libraries aren't installed) and `GET .../export/docx` (Word).
  - Sheets: `GET .../export/xlsx` (Excel, grey frozen header row).
  - Slides: `GET .../export/pptx` (16:9 PowerPoint; lines starting with `- ` become bullets).
  - All kinds: `POST .../export/google` syncs the Drive copy and returns its Google Docs, Sheets or Slides URL.

## Connect AI agents over MCP

Use **AI agents** in the sidebar. Pick an agent, press **Connect**, and run the command it shows; each agent's own `mcp add` command writes its config. One key per agent, shown once; **New key** replaces it and **Disconnect** revokes it. Keys act as the user who made them, and the key's name labels the agent's work in Chia.

| Agent | Command the dialog gives (key filled in) | Notes |
| --- | --- | --- |
| Claude Code (CLI and VS Code) | `claude mcp add --transport http --scope user chia http://localhost:8000/mcp --header "Authorization: Bearer <key>"` | |
| Codex (CLI and VS Code) | `set -Ux CHIA_MCP_KEY <key>` (fish) or an `export` line (bash/zsh), then `codex mcp add chia --url http://localhost:8000/mcp --bearer-token-env-var CHIA_MCP_KEY` | Writes ask for approval. For unattended runs: `codex exec -c 'mcp_servers.chia.default_tools_approval_mode="approve"' ...` |
| Gemini CLI | `gemini mcp add --scope user --transport http chia http://localhost:8000/mcp --header "Authorization: Bearer <key>"` | Gemini turns MCP servers off in folders it doesn't trust. Trust the folder when it asks. |
| Copilot CLI | `copilot mcp add --transport http --header "Authorization: Bearer <key>" chia http://localhost:8000/mcp` | |

Any other streamable-HTTP client: URL `http://localhost:8000/mcp`, header `Authorization: Bearer <key>`, plus `X-Workspace-Id: <id>` to work in a team workspace (the personal workspace otherwise). Keys can also be issued with `POST /api/keys {"name": "..."}`; add `"workspace_id"` to lock the agent to one workspace and `"role": "viewer"` to make it read-only. `MCP_API_KEY` in `.env` is a bootstrap key for the root user; its edits show as "AI agent".

Tools:
- Read-only: `list_workspaces`, `list_documents`, `search_documents` (title and text), `get_document` (docs as markdown, or `format="html"` to keep styling).
- Write: `create_doc` (markdown), `create_sheet`, `create_slides`, and small edits that leave everything else untouched: `patch_doc` (append, prepend, or replace the section under one heading), `update_sheet_cells` (set cells by row and column name or letter, append rows), `update_slide` (add, edit or move one slide), and `append_to_doc`.
- Replace: `update_document`, which overwrites a document's title or content.

`list_documents`, `search_documents` and the `create_*` tools take an optional `workspace_id`.

Results include `chia_url`, which opens the document in Chia, and `drive_url` once the document has a Drive backup. Tools carry read-only and destructive hints, so clients can decide which calls need approval.

**Live edits.** Nothing polls. Open tabs keep one WebSocket (`/api/ws`) that pushes a small notice whenever someone, or an agent, creates, changes or deletes a document in the workspace or the open document. A hidden tab closes it, and a tab that comes back checks once with an ETag (`If-None-Match`, usually answered 304). Library cards name the agent that last changed or created a document. With `REALTIME_BACKEND=aws_appsync` (Lambda, which can't hold sockets) the API also publishes each notice to AWS AppSync Events (`APPSYNC_HTTP_ENDPOINT`, signed with IAM), and tabs subscribe there instead (`APPSYNC_REALTIME_ENDPOINT`, found through `GET /api/realtime/config`); the AppSync Lambda authorizer `app.lambda_handler.appsync_authorizer` lets each user subscribe only to channels they may read.

**Saving and merging.** Edits land in the browser's IndexedDB at once ("Saved locally"), then go to the server ("Synced"). Offline edits wait in the same place ("Offline · saved on this device") and go out when the network returns, even after a reload. Each save carries the revision it builds on. When an agent saved in between, the server merges the two three ways instead of refusing: docs paragraph by paragraph, sheets cell by cell, slides slide by slide (each slide has a stable `id`). A part both sides changed keeps both versions. The server keeps the last 10 revisions of each document for this; an older save still merges, keeping everything from both sides.

## AWS Lambda

`app.lambda_handler` has the entry points: `api_handler` (the whole API, REST and MCP, through Mangum), `migrate_handler` (run once per deploy, with `AUTO_MIGRATE=false` on the API) and `appsync_authorizer`; Drive backups run in `app.worker.handler`. Set `MCP_ALLOWED_HOSTS` to the domain MCP clients use (MCP refuses other `Host` headers), `STORAGE_BACKEND=s3`, `DRIVE_SYNC_RUNNER=external` and `REALTIME_BACKEND=aws_appsync`.

## Tests

`cd api && uv run pytest` runs the end-to-end suite (HTTP API, MCP, WebSocket, the Lambda handler, AppSync sink and authorizer) on a throwaway SQLite database; set `TEST_DATABASE_URL` to an empty Postgres database to run it there. `cd web && npm test` runs the sheet formula tests (Node's test runner); pytest runs them too when Node is installed.

## Content shapes

| Kind | Shape |
| --- | --- |
| doc | `{ "html": "...", "page": "letter" \| "a4" }`. MCP clients may send `{ "markdown": "..." }` instead; pipe tables and ```` ```mermaid ```` blocks are supported. |
| sheet | `{ "columns": [...], "rows": [[...]], "row_ids": [...] }`. A value starting with `=` is a formula: the editor shows its result, while storage, MCP and exports keep the formula (Google Sheets and Excel evaluate it). Supported in the editor: cell references (`A1` is the first row under the header), ranges, `+ - * / ^ & %`, comparisons, `SUM`, `AVERAGE`/`AVG`, `MIN`, `MAX`, `COUNT`, `COUNTA`, `IF`, `ROUND`, `CONCAT`; errors show as `#ERROR!`, `#DIV/0!`, `#REF!`, `#NAME?`, `#VALUE!` or `#CYCLE!`. `row_ids` are optional on input (filled in) and keep rows matched when rows are inserted or deleted concurrently. |
| slides | `{ "slides": [{ "id", "title", "body" }] }`. `id` is optional on input and kept stable afterwards. Body lines starting with `- ` become bullets in Google Slides. |
