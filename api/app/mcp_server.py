"""MCP server that lets locally running AI agents create and edit documents through Chia.

Each request authenticates with `Authorization: Bearer <key>`; the key decides which Chia
user the agent acts as. Documents go to that user's Google Drive when they have linked
Google, otherwise to Chia's local store.
"""

from contextvars import ContextVar
from typing import Any

import anyio
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from pydantic import BaseModel
from sqlmodel import Session
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from app import documents
from app.db import engine
from app.models import DocKind, Document, DocumentSummary
from app.routes.keys import user_for_key

current_user_id: ContextVar[int] = ContextVar("chia_mcp_user_id")

mcp = MCPServer(
    name="chia",
    title="Chia",
    instructions=(
        "Chia manages three kinds of documents: 'doc' (rich text), 'sheet' (columns + rows; "
        "strings starting with '=' are formulas) and 'slides' (list of {title, body}). Create docs "
        "from markdown. Reading a doc returns {html, page}; to edit one, send content "
        "{markdown} or {html} (allowed tags: p, h1-h3, ul/ol/li, strong, em, u, s, br, "
        "<span style='font-size:14pt'>, style='text-align:center' on blocks). When the user has "
        "linked Google, documents are backed up to Drive and results include drive_url. Prefer "
        "creating new documents over overwriting existing ones unless asked to edit."
    ),
)


class Slide(BaseModel):
    title: str
    body: str = ""


class DocumentInfo(BaseModel):
    id: str
    kind: DocKind
    title: str
    drive_url: str | None
    updated_at: str


class DocumentFull(DocumentInfo):
    content: dict[str, Any]


def _info(doc: Document | DocumentSummary) -> DocumentInfo:
    summary = doc if isinstance(doc, DocumentSummary) else DocumentSummary.of(doc)
    return DocumentInfo(**summary.model_dump(include={"id", "kind", "title", "drive_url"}), updated_at=summary.updated_at.isoformat())


def _run(fn, *args, **kwargs):
    """Open a session, call `fn(session, user_id, ...)`, and surface errors as tool errors."""
    with Session(engine) as session:
        try:
            return fn(session, current_user_id.get(), *args, **kwargs)
        except documents.DocumentError as exc:
            raise ToolError(str(exc)) from exc


def _create(kind: DocKind, title: str, content: dict[str, Any]) -> DocumentInfo:
    return _run(lambda s, uid: _info(documents.create_document(s, uid, kind, title, content, source="mcp")))


@mcp.tool()
def list_documents(kind: DocKind | None = None) -> list[DocumentInfo]:
    """List the user's documents, newest first. Optionally filter by kind: doc, sheet or slides."""
    return _run(lambda s, uid: [_info(d) for d in documents.list_documents(s, uid, kind)])


@mcp.tool()
def get_document(document_id: str) -> DocumentFull:
    """Fetch one document with its full content."""

    def read(s: Session, uid: int) -> DocumentFull:
        doc = documents.read_document(documents.get_document(s, uid, document_id))
        return DocumentFull(**_info(doc).model_dump(), content=doc.content)

    return _run(read)


@mcp.tool()
def create_doc(title: str, markdown: str) -> DocumentInfo:
    """Create a text document from markdown (headings, lists, bold, italic)."""
    return _create(DocKind.doc, title, {"markdown": markdown})


@mcp.tool()
def create_sheet(title: str, columns: list[str], rows: list[list[str | float | int | bool | None]]) -> DocumentInfo:
    """Create a spreadsheet. `columns` is the header row; each row is padded/trimmed to its width."""
    return _create(DocKind.sheet, title, {"columns": columns, "rows": rows})


@mcp.tool()
def create_slides(title: str, slides: list[Slide]) -> DocumentInfo:
    """Create a slide deck. Each slide has a title and a body; '- ' lines in the body become bullets."""
    return _create(DocKind.slides, title, {"slides": [s.model_dump() for s in slides]})


@mcp.tool()
def update_document(document_id: str, title: str | None = None, content: dict[str, Any] | None = None) -> DocumentInfo:
    """Rename a document and/or replace its whole content. `content` must match the kind's shape:
    doc {markdown} or {html, page}, sheet {columns, rows}, slides {slides: [{title, body}]}."""

    def update(s: Session, uid: int) -> DocumentInfo:
        return _info(documents.update_document(s, documents.get_document(s, uid, document_id), title, content))

    return _run(update)


class MCPAuth:
    """Resolves `Authorization: Bearer <key>` to a Chia user before the MCP app runs."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope["method"] == "OPTIONS":
            await self.app(scope, receive, send)
            return
        header = dict(scope["headers"]).get(b"authorization", b"").decode(errors="ignore")
        key = header.removeprefix("Bearer ").strip() if header.startswith("Bearer ") else ""

        def lookup() -> int | None:
            with Session(engine) as session:
                return user_for_key(session, key) if key else None

        user_id = await anyio.to_thread.run_sync(lookup)
        if user_id is None:
            await JSONResponse({"detail": "Missing or invalid MCP API key"}, status_code=401)(scope, receive, send)
            return
        token = current_user_id.set(user_id)
        try:
            await self.app(scope, receive, send)
        finally:
            current_user_id.reset(token)


mcp_app = MCPAuth(mcp.streamable_http_app(streamable_http_path="/mcp", stateless_http=True, json_response=True))
