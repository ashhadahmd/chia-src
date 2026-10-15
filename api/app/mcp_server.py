"""MCP server that lets locally running AI agents create and edit documents through Chia.

Each request authenticates with `Authorization: Bearer <key>`; the key decides which Chia
user the agent acts as, and may lock it to one workspace or to read-only. Otherwise the agent
works in the workspace named by an `X-Workspace-Id` header, or the user's personal workspace,
so a solo user's agent needs nothing beyond the key.
"""

from collections.abc import Callable
from contextvars import ContextVar
from typing import Any, Literal

import anyio
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.types import ToolAnnotations
from pydantic import BaseModel
from sqlmodel import Session
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from app import documents
from app.config import get_settings
from app.db import engine
from app.models import DocKind, Document, DocumentSummary, Role
from app.routes.keys import agent_for_key
from app.workspaces import AccessError, Actor, resolve_actor

current_actor: ContextVar[Actor] = ContextVar("chia_mcp_actor")

mcp = MCPServer(
    name="chia",
    title="Chia",
    instructions=(
        "Chia is the user's own docs, sheets and slides app. Three kinds of documents: 'doc' "
        "(rich text), 'sheet' (columns + rows; strings starting with '=' are formulas) and "
        "'slides' (list of {title, body}). Write docs in markdown: GitHub-style pipe tables "
        "become real tables, and ```mermaid fenced blocks become diagrams (flowchart, "
        "sequenceDiagram, mindmap, timeline, pie, gantt, erDiagram, classDiagram, "
        "stateDiagram-v2, journey, quadrantChart) drawn in Chia's own style, so don't add colours "
        "or themes to them. get_document returns docs as markdown. To add to a doc use "
        "append_to_doc, which keeps the user's formatting. update_document replaces the whole "
        "content: sending markdown drops styling markdown can't express (font sizes, colours, "
        "alignment, picture sizes), so for a styled doc read it with format='html' and send html "
        "back (allowed tags: p, h1-h3, ul/ol/li, strong, em, u, s, br, "
        "<span style='font-size:14pt'>, style='text-align:center' on blocks, table/tr/th/td, "
        "<img src='/api/assets/...'> for images already in the doc, and "
        "<figure data-type='diagram' data-code='mermaid source'>). The user sees your changes "
        "live if the document is open, labelled with your name. Every result has chia_url, a "
        "link that opens the document in Chia; share it with the user. Prefer creating new "
        "documents over overwriting existing ones unless asked to edit."
    ),
)


# Hints clients use to decide what needs the user's approval.
READ = ToolAnnotations(read_only_hint=True, open_world_hint=False)
CREATE = ToolAnnotations(read_only_hint=False, destructive_hint=False, idempotent_hint=False, open_world_hint=False)
REPLACE = ToolAnnotations(read_only_hint=False, destructive_hint=True, idempotent_hint=True, open_world_hint=False)


class Slide(BaseModel):
    title: str
    body: str = ""


class DocumentInfo(BaseModel):
    id: str
    kind: DocKind
    workspace_id: str
    title: str
    chia_url: str
    drive_url: str | None
    edited_by: str | None  # AI agent behind the latest change; None when the user made it
    updated_at: str


class DocumentFull(DocumentInfo):
    content: dict[str, Any]


class SearchHit(DocumentInfo):
    snippet: str


def _info(doc: Document | DocumentSummary) -> DocumentInfo:
    summary = doc if isinstance(doc, DocumentSummary) else DocumentSummary.of(doc)
    return DocumentInfo(
        **summary.model_dump(include={"id", "kind", "workspace_id", "title", "drive_url", "edited_by"}),
        chia_url=f"{get_settings().frontend_url.rstrip('/')}/d/{summary.id}",
        updated_at=summary.updated_at.isoformat(),
    )


def _run(fn, *args, **kwargs):
    """Open a session, call `fn(session, actor, ...)`, and surface errors as tool errors."""
    with Session(engine) as session:
        try:
            return fn(session, current_actor.get(), *args, **kwargs)
        except (documents.DocumentError, AccessError) as exc:
            raise ToolError(str(exc)) from exc


def _create(kind: DocKind, title: str, content: dict[str, Any]) -> DocumentInfo:
    return _run(lambda s, actor: _info(documents.create_document(s, actor, kind, title, content, source="mcp")))


def _update(document_id: str, title: str | None, content: Callable[[Document], dict[str, Any]] | None) -> DocumentInfo:
    def update(s: Session, actor: Actor) -> DocumentInfo:
        doc = documents.get_document(s, actor, document_id, Role.editor)
        new = content(doc) if content else None
        return _info(documents.update_document(s, doc, title, new, edited_by=actor.agent))

    return _run(update)


@mcp.tool(annotations=READ)
def list_documents(kind: DocKind | None = None) -> list[DocumentInfo]:
    """List the user's documents, newest first. Optionally filter by kind: doc, sheet or slides."""
    return _run(lambda s, actor: [_info(d) for d in documents.list_documents(s, actor.workspace_id, kind)])


@mcp.tool(annotations=READ)
def search_documents(query: str, kind: DocKind | None = None) -> list[SearchHit]:
    """Find documents whose title or text contains `query` (case-insensitive), newest first."""
    needle = " ".join(query.split()).lower()

    def search(s: Session, actor: Actor) -> list[SearchHit]:
        hits = []
        for doc in documents.search_documents(s, actor.workspace_id, query, kind):
            text = doc.search_text
            at = text.lower().find(needle)
            snippet = text[max(0, at - 60) : at + len(needle) + 60] if at >= 0 else text[:120]
            hits.append(SearchHit(**_info(doc).model_dump(), snippet=snippet))
        return hits

    return _run(search)


@mcp.tool(annotations=READ)
def get_document(document_id: str, format: Literal["markdown", "html"] = "markdown") -> DocumentFull:
    """Fetch one document with its full content. Docs come as {markdown, page}, or
    {html, page} with format='html' (use that before rewriting a styled doc)."""

    def read(s: Session, actor: Actor) -> DocumentFull:
        doc = documents.read_document(documents.get_document(s, actor, document_id))
        content = doc.content
        if doc.kind is DocKind.doc and format == "markdown":
            content = {"markdown": documents.html_to_markdown(content["html"]), "page": content["page"]}
        return DocumentFull(**_info(doc).model_dump(), content=content)

    return _run(read)


@mcp.tool(annotations=CREATE)
def create_doc(title: str, markdown: str) -> DocumentInfo:
    """Create a text document from markdown: headings, lists, bold, italic, pipe tables and
    ```mermaid diagrams (rendered in Chia's style)."""
    return _create(DocKind.doc, title, {"markdown": markdown})


@mcp.tool(annotations=CREATE)
def create_sheet(title: str, columns: list[str], rows: list[list[str | float | int | bool | None]]) -> DocumentInfo:
    """Create a spreadsheet. `columns` is the header row; each row is padded/trimmed to its width."""
    return _create(DocKind.sheet, title, {"columns": columns, "rows": rows})


@mcp.tool(annotations=CREATE)
def create_slides(title: str, slides: list[Slide]) -> DocumentInfo:
    """Create a slide deck. Each slide has a title and a body; '- ' lines in the body become bullets."""
    return _create(DocKind.slides, title, {"slides": [s.model_dump() for s in slides]})


@mcp.tool(annotations=CREATE)
def append_to_doc(document_id: str, markdown: str) -> DocumentInfo:
    """Add markdown (text, tables, ```mermaid diagrams) to the end of a text document,
    keeping everything already in it exactly as it is."""

    def appended(doc: Document) -> dict[str, Any]:
        if doc.kind is not DocKind.doc:
            raise documents.DocumentError(422, f"append_to_doc works on docs; this is a {doc.kind}")
        content = documents.content_of(doc)
        return {**content, "html": content["html"] + documents.markdown_to_html(markdown)}

    return _update(document_id, None, appended)


@mcp.tool(annotations=REPLACE)
def update_document(document_id: str, title: str | None = None, content: dict[str, Any] | None = None) -> DocumentInfo:
    """Rename a document and/or replace its whole content. `content` must match the kind's shape:
    doc {markdown} or {html, page}, sheet {columns, rows}, slides {slides: [{title, body}]}.
    To add to a doc without touching what's there, use append_to_doc instead."""
    return _update(document_id, title, (lambda _: content) if content is not None else None)


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

        requested = dict(scope["headers"]).get(b"x-workspace-id", b"").decode(errors="ignore") or None

        def lookup() -> Actor | None:
            with Session(engine) as session:
                grant = agent_for_key(session, key) if key else None
                if grant is None:
                    return None
                return resolve_actor(
                    session,
                    grant.user_id,
                    requested,
                    agent=grant.agent,
                    key_id=grant.key_id,
                    key_role=grant.role,
                    key_workspace_id=grant.workspace_id,
                )

        try:
            actor = await anyio.to_thread.run_sync(lookup)
        except AccessError as exc:
            await JSONResponse({"detail": str(exc)}, status_code=exc.status)(scope, receive, send)
            return
        if actor is None:
            await JSONResponse({"detail": "Missing or invalid MCP API key"}, status_code=401)(scope, receive, send)
            return
        token = current_actor.set(actor)
        try:
            await self.app(scope, receive, send)
        finally:
            current_actor.reset(token)


mcp_app = MCPAuth(mcp.streamable_http_app(streamable_http_path="/mcp", stateless_http=True, json_response=True))
