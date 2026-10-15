"""MCP server that lets locally running AI agents create and edit documents through Chia.

Each request authenticates with `Authorization: Bearer <key>`; the key decides which Chia
user the agent acts as, and may lock it to one workspace or to read-only. Otherwise the agent
works in the workspace named by an `X-Workspace-Id` header, or the user's personal workspace,
so a solo user's agent needs nothing beyond the key.
"""

import html as htmllib
import re
from collections.abc import Callable
from contextvars import ContextVar
from typing import Annotated, Any, Literal

import anyio
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.types import ToolAnnotations
from pydantic import BaseModel, Field
from sqlmodel import Session, col, select
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from app import documents
from app.config import get_settings
from app.db import engine
from app.merge import new_slide_id, split_blocks
from app.models import (
    DocKind,
    Document,
    DocumentSummary,
    Role,
    Workspace,
    WorkspaceKind,
    WorkspaceMember,
)
from app.routes.keys import agent_for_key
from app.workspaces import AccessError, Actor, resolve_actor

current_actor: ContextVar[Actor] = ContextVar("chia_mcp_actor")

mcp = MCPServer(
    name="chia",
    title="Chia",
    instructions=(
        "Chia is the user's own docs, sheets and slides app. Three kinds of documents: 'doc' "
        "(rich text), 'sheet' (columns + rows; strings starting with '=' are formulas) and "
        "'slides' (list of {id, title, body}). Write docs in markdown: GitHub-style pipe tables "
        "become real tables, and ```mermaid fenced blocks become diagrams (flowchart, "
        "sequenceDiagram, mindmap, timeline, pie, gantt, erDiagram, classDiagram, "
        "stateDiagram-v2, journey, quadrantChart) drawn in Chia's own style, so don't add colours "
        "or themes to them. get_document returns docs as markdown. For small changes use "
        "patch_doc (append, prepend or replace one section of a doc), update_sheet_cells (set "
        "cells or append rows) and update_slide (add, edit or move one slide): they keep the "
        "user's formatting and merge with edits the user is making at the same time. "
        "update_document replaces the whole content: sending markdown drops styling markdown can't express (font sizes, colours, "
        "alignment, picture sizes), so for a styled doc read it with format='html' and send html "
        "back (allowed tags: p, h1-h3, ul/ol/li, strong, em, u, s, br, "
        "<span style='font-size:14pt'>, style='text-align:center' on blocks, table/tr/th/td, "
        "<img src='/api/assets/...'> for images already in the doc, and "
        "<figure data-type='diagram' data-code='mermaid source'>). The user sees your changes "
        "live if the document is open, labelled with your name. Every result has chia_url, a "
        "link that opens the document in Chia; share it with the user. Prefer creating new "
        "documents over overwriting existing ones unless asked to edit. Tools work in the user's "
        "personal workspace unless you pass workspace_id (see list_workspaces)."
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


class WorkspaceInfo(BaseModel):
    id: str
    name: str
    kind: WorkspaceKind
    role: Role
    current: bool  # where tools work when no workspace_id is given


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


def _create(kind: DocKind, title: str, content: dict[str, Any], workspace_id: str | None) -> DocumentInfo:
    return _run(
        lambda s, actor: _info(documents.create_document(s, _in(s, actor, workspace_id), kind, title, content, source="mcp"))
    )


def _update(document_id: str, title: str | None, content: Callable[[Document], dict[str, Any]] | None) -> DocumentInfo:
    def update(s: Session, actor: Actor) -> DocumentInfo:
        doc = documents.get_document(s, actor, document_id, Role.editor)
        new = content(doc) if content else None
        saved, _ = documents.update_document(s, doc, title, new, edited_by=actor.agent)
        return _info(saved)

    return _run(update)


def _in(session: Session, actor: Actor, workspace_id: str | None) -> Actor:
    """The actor, moved to `workspace_id` when given (a key locked elsewhere is refused)."""
    if workspace_id is None or workspace_id == actor.workspace_id:
        return actor
    return resolve_actor(
        session,
        actor.user_id,
        workspace_id,
        agent=actor.agent,
        key_id=actor.key_id,
        key_role=actor.key_role,
        key_workspace_id=actor.key_workspace_id,
    )


WorkspaceArg = Annotated[
    str | None,
    Field(description="Workspace id to work in; omit for the default (your personal workspace, or the one this key is locked to)"),
]


@mcp.tool(annotations=READ)
def list_workspaces() -> list[WorkspaceInfo]:
    """Workspaces you can work in (pass an id as `workspace_id` to other tools)."""

    def listing(s: Session, actor: Actor) -> list[WorkspaceInfo]:
        rows = s.exec(
            select(Workspace, WorkspaceMember.role)
            .join(WorkspaceMember, col(WorkspaceMember.workspace_id) == Workspace.id)
            .where(WorkspaceMember.user_id == actor.user_id)
        ).all()
        return [
            WorkspaceInfo(id=ws.id, name=ws.name, kind=ws.kind, role=role, current=ws.id == actor.workspace_id)
            for ws, role in rows
            if actor.key_workspace_id in (None, ws.id)
        ]

    return _run(listing)


@mcp.tool(annotations=READ)
def list_documents(kind: DocKind | None = None, workspace_id: WorkspaceArg = None) -> list[DocumentInfo]:
    """List documents in a workspace, newest first. Optionally filter by kind: doc, sheet or slides."""
    return _run(lambda s, actor: [_info(d) for d in documents.list_documents(s, _in(s, actor, workspace_id).workspace_id, kind)])


@mcp.tool(annotations=READ)
def search_documents(query: str, kind: DocKind | None = None, workspace_id: WorkspaceArg = None) -> list[SearchHit]:
    """Find documents whose title or text contains `query` (case-insensitive), newest first."""
    needle = " ".join(query.split()).lower()

    def search(s: Session, actor: Actor) -> list[SearchHit]:
        hits = []
        for doc in documents.search_documents(s, _in(s, actor, workspace_id).workspace_id, query, kind):
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
def create_doc(title: str, markdown: str, workspace_id: WorkspaceArg = None) -> DocumentInfo:
    """Create a text document from markdown: headings, lists, bold, italic, pipe tables and
    ```mermaid diagrams (rendered in Chia's style)."""
    return _create(DocKind.doc, title, {"markdown": markdown}, workspace_id)


@mcp.tool(annotations=CREATE)
def create_sheet(
    title: str, columns: list[str], rows: list[list[str | float | int | bool | None]], workspace_id: WorkspaceArg = None
) -> DocumentInfo:
    """Create a spreadsheet. `columns` is the header row; each row is padded/trimmed to its width."""
    return _create(DocKind.sheet, title, {"columns": columns, "rows": rows}, workspace_id)


@mcp.tool(annotations=CREATE)
def create_slides(title: str, slides: list[Slide], workspace_id: WorkspaceArg = None) -> DocumentInfo:
    """Create a slide deck. Each slide has a title and a body; '- ' lines in the body become bullets."""
    return _create(DocKind.slides, title, {"slides": [s.model_dump() for s in slides]}, workspace_id)


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
    doc {markdown} or {html, page}, sheet {columns, rows}, slides {slides: [{id?, title, body}]}.
    For small changes prefer patch_doc, update_sheet_cells or update_slide."""

    def replaced(doc: Document) -> dict[str, Any]:
        assert content is not None
        if doc.kind is DocKind.slides and isinstance(content.get("slides"), list):
            # Slides sent without ids keep the id of the slide at the same place, so a person
            # editing the deck at the same time still has their edits matched up.
            old = documents.content_of(doc).get("slides", [])
            slides = [
                {**s, "id": s.get("id") or (old[i]["id"] if i < len(old) else None)} if isinstance(s, dict) else s
                for i, s in enumerate(content["slides"])
            ]
            return {**content, "slides": slides}
        return content

    return _update(document_id, title, replaced if content is not None else None)


# ───────────── Surgical edits ─────────────

_HEADING = re.compile(r"^<h([1-6])\b", re.IGNORECASE)


def _heading_level(block: str) -> int | None:
    m = _HEADING.match(block)
    return int(m.group(1)) if m else None


def _block_text(block: str) -> str:
    return " ".join(htmllib.unescape(re.sub(r"<[^>]+>", " ", block)).split())


@mcp.tool(annotations=CREATE)
def patch_doc(
    document_id: str,
    markdown: str,
    mode: Literal["append", "prepend", "replace_section"] = "append",
    heading: Annotated[str | None, Field(description="For replace_section: the heading whose section to replace")] = None,
) -> DocumentInfo:
    """Change part of a text document without sending all of it. `append` adds markdown at the
    end, `prepend` at the start; `replace_section` replaces everything under `heading` (up to the
    next heading of the same or higher level) and keeps the heading itself. Everything else,
    including the user's formatting, stays exactly as it is."""

    def patched(doc: Document) -> dict[str, Any]:
        if doc.kind is not DocKind.doc:
            raise documents.DocumentError(422, f"patch_doc works on docs; this is a {doc.kind}")
        content = documents.content_of(doc)
        new = documents.markdown_to_html(markdown)
        if mode == "append":
            return {**content, "html": content["html"] + new}
        if mode == "prepend":
            return {**content, "html": new + content["html"]}
        blocks = split_blocks(content["html"])
        wanted = " ".join((heading or "").lstrip("#").split()).lower()
        found = next((i for i, b in enumerate(blocks) if _heading_level(b) and _block_text(b).lower() == wanted), None)
        if found is None:
            names = [_block_text(b) for b in blocks if _heading_level(b)]
            raise documents.DocumentError(404, f"No heading {heading!r} in this doc. Headings: {names}")
        level = _heading_level(blocks[found]) or 1
        end = next((i for i in range(found + 1, len(blocks)) if (_heading_level(blocks[i]) or 99) <= level), len(blocks))
        return {**content, "html": "".join([*blocks[: found + 1], new, *blocks[end:]])}

    return _update(document_id, None, patched)


class CellEdit(BaseModel):
    row: Annotated[int, Field(ge=1, description="Data row number, 1 = the first row under the header")]
    column: Annotated[str | int, Field(description="Header name, column letter (A, B, AA) or 1-based number")]
    value: str | float | int | bool | None


def _column_index(columns: list[str], column: str | int) -> int:
    if isinstance(column, int):
        index = column - 1
    else:
        names = [c.strip().lower() for c in columns]
        key = column.strip().lower()
        if key in names:
            return names.index(key)
        if not re.fullmatch(r"[a-z]{1,3}", key):
            raise documents.DocumentError(404, f"No column {column!r}. Columns: {columns}")
        index = 0
        for ch in key:
            index = index * 26 + ord(ch) - 96
        index -= 1
    if not 0 <= index < len(columns):
        raise documents.DocumentError(404, f"Column {column!r} is outside this sheet's {len(columns)} columns: {columns}")
    return index


@mcp.tool(annotations=CREATE)
def update_sheet_cells(
    document_id: str,
    cells: list[CellEdit] | None = None,
    append_rows: list[list[str | float | int | bool | None]] | None = None,
) -> DocumentInfo:
    """Set individual cells and/or add rows at the bottom of a sheet, without sending the whole
    sheet. Strings starting with '=' are formulas. Rows past the end are created as needed."""

    def edited(doc: Document) -> dict[str, Any]:
        if doc.kind is not DocKind.sheet:
            raise documents.DocumentError(422, f"update_sheet_cells works on sheets; this is a {doc.kind}")
        content = documents.content_of(doc)
        columns, rows = list(content["columns"]), [list(r) for r in content["rows"]]
        for edit in cells or []:
            c = _column_index(columns, edit.column)
            while len(rows) < edit.row:
                rows.append([None] * len(columns))
            rows[edit.row - 1][c] = edit.value
        rows += [list(r) for r in append_rows or []]
        return {"columns": columns, "rows": rows}

    return _update(document_id, None, edited)


class SlideResult(DocumentInfo):
    slide_id: str
    slide_number: int
    slide_count: int


@mcp.tool(annotations=CREATE)
def update_slide(
    document_id: str,
    action: Literal["add", "update", "move"],
    slide_id: Annotated[str | None, Field(description="The slide's id (get_document shows them); or use `number`")] = None,
    number: Annotated[int | None, Field(ge=1, description="The slide's 1-based position, if no slide_id")] = None,
    title: str | None = None,
    body: Annotated[str | None, Field(description="Slide text; '- ' lines become bullets")] = None,
    position: Annotated[int | None, Field(ge=1, description="For add and move: 1-based place in the deck (default: end)")] = None,
) -> SlideResult:
    """Add one slide, change one slide's title/body, or move one slide, leaving the others as
    they are. Returns the slide's id and where it now sits."""
    touched: dict[str, str] = {}

    def edited(doc: Document) -> dict[str, Any]:
        if doc.kind is not DocKind.slides:
            raise documents.DocumentError(422, f"update_slide works on slide decks; this is a {doc.kind}")
        slides = [dict(s) for s in documents.content_of(doc)["slides"]]
        if action == "add":
            slide = {"id": new_slide_id(), "title": title or "", "body": body or ""}
            at = len(slides) if position is None else min(position - 1, len(slides))
            slides.insert(at, slide)
        else:
            if slide_id is not None:
                at = next((i for i, s in enumerate(slides) if s.get("id") == slide_id), None)
            else:
                at = number - 1 if number is not None and number <= len(slides) else None
            if at is None:
                raise documents.DocumentError(404, f"No such slide; ids in order: {[s.get('id') for s in slides]}")
            slide = slides[at]
            if action == "update":
                slide.update({k: v for k, v in (("title", title), ("body", body)) if v is not None})
            else:
                slides.pop(at)
                slides.insert(len(slides) if position is None else min(position - 1, len(slides)), slide)
        touched["id"] = slide["id"]
        return {"slides": slides}

    info = _update(document_id, None, edited)

    def where(s: Session, actor: Actor) -> SlideResult:
        slides = documents.content_of(documents.get_document(s, actor, document_id))["slides"]
        ids = [x.get("id") for x in slides]
        return SlideResult(**info.model_dump(), slide_id=touched["id"], slide_number=ids.index(touched["id"]) + 1, slide_count=len(ids))

    return _run(where)


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
