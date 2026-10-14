# Chia

A calm home for docs, sheets and slides, with its own editor, plus an MCP endpoint that lets local AI agents create documents. Signing in with Google, or linking Google later, turns on automatic Drive backup.

- `api/`: FastAPI, the official MCP Python SDK, Google API clients, WeasyPrint (PDF) and python-docx (Word)
- `web/`: React with a TipTap editor (bold, italic, underline, font size, alignment, Letter/A4 pages, a right-click format menu, print, and export)

## Run

```sh
cd api && cp -n .env.example .env   # first run only; fill in secrets
uv run fastapi dev app/main.py      # REST at /api, MCP at /mcp, OpenAPI docs at /docs

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

- **Word** `.docx` as a doc: headings, lists, bold/italic/underline, font size, alignment, page size, and text colour snapped to Chia's palette. Tables become plain lines; images are left out. The toast says what was dropped.
- **Excel** `.xlsx` and **CSV** as sheets: one sheet per worksheet, with formula results as values. The first 5,000 rows are kept.
- **PowerPoint** `.pptx` as slides: titles, text and bullets.
- **Markdown** and **text** as docs.
- **Google Docs, Sheets and Slides** by link, either through the user's linked Google account or Google's public export for files shared "Anyone with the link". When the Picker is configured, users can also pick files from Drive.

Legacy `.doc`, `.xls`, `.ppt` and OpenDocument files are refused with a "save as .docx/.xlsx/.pptx" hint. Uploads are limited to 25 MB.

## Storage, backup and export

- **Storage:** Chia's database is the source of truth.
- **Backup:** for users signed in with or linked to Google, each document is mirrored as a native Google Doc, Sheet or Slides file in a `Chia` folder in their Drive. The mirror is written about 4 seconds after the last edit. Backups that were still pending when the server stopped are resumed on startup.
- **Export (docs):**
  - `GET /api/documents/{id}/export/pdf?background=%23F7F4ED`: PDF with any page colour.
  - `GET /api/documents/{id}/export/docx`: Word document.
  - `POST /api/documents/{id}/export/google`: syncs the Drive copy and returns its URL.
- **Printing:** uses real `@page` sizes and always prints in light colours.

## Connect a local AI over MCP

Issue a key per agent: `POST /api/keys {"name": "LM Studio"}`. The full key is shown only once. Each key acts as the user who created it. `MCP_API_KEY` in `.env` is a bootstrap key mapped to the root user.

```json
{
  "mcpServers": {
    "chia": {
      "type": "http",
      "url": "http://localhost:8000/mcp",
      "headers": { "Authorization": "Bearer <key>" }
    }
  }
}
```

Tools: `list_documents`, `get_document`, `create_doc`, `create_sheet`, `create_slides`, `update_document`. Once a document has been backed up, results include its `drive_url`.

## Content shapes

| Kind | Shape |
| --- | --- |
| doc | `{ "html": "...", "page": "letter" \| "a4" }`. MCP clients may send `{ "markdown": "..." }` instead. |
| sheet | `{ "columns": [...], "rows": [[...]] }`. A value starting with `=` becomes a formula in Google Sheets. |
| slides | `{ "slides": [{ "title", "body" }] }`. Body lines starting with `- ` become bullets in Google Slides. |
