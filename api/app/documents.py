"""Document operations shared by the REST API and the MCP server.

Chia's DB holds every document, scoped to a workspace (see `app.workspaces` for who may do
what). Users who linked Google also get a backup mirror in their Drive: saves mark the doc
`pending` and a runner syncs it (see `app.google.backup`).
"""

import html as htmllib
import json
import re
import zlib
from collections.abc import Callable
from copy import deepcopy
from typing import Any

from markdown_it import MarkdownIt
from markdownify import MarkdownConverter
from pydantic import BaseModel, ValidationError
from sqlalchemy import delete, text
from sqlmodel import Session, col, func, or_, select

from app import assets, realtime
from app.google import backup
from app.merge import MergeResult, merge, with_ids
from app.models import (
    EMPTY_CONTENT,
    DocKind,
    Document,
    DocumentRead,
    DocumentShare,
    DocumentSnapshot,
    DocumentSummary,
    PageSize,
    Role,
    utcnow,
)
from app.workspaces import Actor, check_doc_access, require_workspace_role

_md = MarkdownIt("commonmark", {"html": False}).enable(["table", "strikethrough"])


class DocumentError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


class _Doc(BaseModel):
    html: str | None = None
    markdown: str | None = None  # accepted from MCP clients; converted to html
    page: PageSize = PageSize.letter


class _Sheet(BaseModel):
    columns: list[str]
    rows: list[list[str | int | float | bool | None]] = []


class _Slide(BaseModel):
    title: str = ""
    body: str = ""


class _Slides(BaseModel):
    slides: list[_Slide]


class _SlideWithId(_Slide):
    id: str | None = None  # stable across edits, so concurrent edits merge slide by slide


_SHAPES: dict[DocKind, type[BaseModel]] = {DocKind.doc: _Doc, DocKind.sheet: _Sheet, DocKind.slides: _Slides}


_MERMAID = re.compile(r'<pre><code class="language-mermaid">(.*?)</code></pre>', re.DOTALL)


def markdown_to_html(markdown: str) -> str:
    """Markdown to editor HTML; ```mermaid fences become diagrams, drawn when the doc opens."""
    html = _md.render(markdown)
    return _MERMAID.sub(lambda m: f'<figure data-type="diagram" data-code="{m.group(1).rstrip()}"></figure>', html)


class _ToMarkdown(MarkdownConverter):
    def convert_figure(self, el, text, parent_tags):  # diagrams go back to ```mermaid fences
        if el.get("data-type") == "diagram":
            return f"\n\n```mermaid\n{el.get('data-code', '').strip()}\n```\n\n"
        return text


_to_md = _ToMarkdown(heading_style="ATX", bullets="-")


def html_to_markdown(html: str) -> str:
    """Editor HTML as markdown for AI agents. Font sizes, colours, alignment and picture sizes
    are not carried over."""
    return re.sub(r"\n{3,}", "\n\n", _to_md.convert(html)).strip() + "\n"


def extract_text(kind: DocKind, content: dict[str, Any]) -> str:
    """Words in a document, whitespace collapsed, for search."""
    if kind is DocKind.doc:
        raw = htmllib.unescape(re.sub(r"<[^>]+>", " ", content.get("html") or content.get("markdown") or ""))
    elif kind is DocKind.sheet:
        raw = " ".join(str(v) for row in [content["columns"], *content["rows"]] for v in row if v is not None)
    else:
        raw = " ".join(f"{s['title']} {s['body']}" for s in content["slides"])
    return " ".join(raw.split())


def validate_content(kind: DocKind, content: dict[str, Any]) -> dict[str, Any]:
    try:
        data = _SHAPES[kind].model_validate(content).model_dump()
    except ValidationError as exc:
        raise DocumentError(422, f"Invalid {kind} content: {exc.errors(include_url=False)}") from exc
    if kind is DocKind.doc:
        html = data["html"] if data["html"] is not None else markdown_to_html(data["markdown"] or "")
        return {"html": html, "page": data["page"]}
    if kind is DocKind.sheet:
        width = len(data["columns"])
        data["rows"] = [(list(r) + [None] * width)[:width] for r in data["rows"]]
    if kind is DocKind.slides:
        slides = [_SlideWithId.model_validate(s).model_dump() for s in content.get("slides", [])]
        data["slides"] = with_ids(slides)
    return data


def content_of(doc: Document) -> dict[str, Any]:
    """Stored content, upgrading docs saved before the rich editor ({"markdown": ...})."""
    content = doc.content or deepcopy(EMPTY_CONTENT[doc.kind])
    if doc.kind is DocKind.doc and "html" not in content:
        return validate_content(doc.kind, content)
    return content


# Postgres full-text vector over title + body; the migration builds a GIN index on exactly this
# expression, so keep the two in step (see migrations/versions/0002_workspaces.py).
TSVECTOR_SQL = "to_tsvector('simple'::regconfig, coalesce(document.title, '') || ' ' || document.search_text)"
SEARCH_LIMIT = 50


# Revisions kept per document for three-way merges. A save built on an older revision than
# this falls back to a merge that keeps everything both sides have.
SNAPSHOTS_KEPT = 10


def _apply_content(session: Session, doc: Document, content: dict[str, Any]) -> None:
    doc.content = content
    doc.search_text = extract_text(doc.kind, content)
    if doc.kind is DocKind.doc:
        assets.sync_references(session, doc.id, content.get("html", ""))


def _snapshot(session: Session, doc: Document) -> None:
    """Record the doc as of its current revision and drop ones older than SNAPSHOTS_KEPT."""
    session.add(
        DocumentSnapshot(
            document_id=doc.id,
            revision=doc.revision,
            title=doc.title,
            content_z=zlib.compress(json.dumps(doc.content or {}).encode()),
        )
    )
    session.execute(
        delete(DocumentSnapshot).where(
            col(DocumentSnapshot.document_id) == doc.id, col(DocumentSnapshot.revision) <= doc.revision - SNAPSHOTS_KEPT
        )
    )


def snapshot_at(session: Session, doc_id: str, revision: int) -> tuple[str, dict[str, Any]] | None:
    snap = session.get(DocumentSnapshot, (doc_id, revision))
    if snap is None:
        return None
    return snap.title, json.loads(zlib.decompress(snap.content_z))


def _announce(doc: Document, kind: str) -> None:
    """Tell open tabs about a committed change (see app.realtime)."""
    summary = DocumentSummary.of(doc).model_dump(mode="json")
    realtime.publish(
        [realtime.workspace_channel(doc.workspace_id), realtime.doc_channel(doc.id)],
        {"type": kind, "doc_id": doc.id, "workspace_id": doc.workspace_id, "revision": doc.revision, "edited_by": doc.edited_by, "doc": summary},
    )


def list_etag(session: Session, workspace_id: str, shared_with: int | None = None) -> str:
    """A cheap fingerprint of a library listing (count, latest change, revision total), so a tab
    coming back can ask "anything new?" and get 304 Not Modified when nothing is."""
    stmt = select(func.count(), func.max(Document.updated_at), func.coalesce(func.sum(Document.revision), 0))
    where = Document.workspace_id == workspace_id
    if shared_with is not None:
        shared = select(DocumentShare.document_id).where(
            DocumentShare.principal_type == "user", DocumentShare.principal_id == str(shared_with)
        )
        where = or_(where, col(Document.id).in_(shared))
    count, latest, revisions = session.exec(stmt.where(where)).one()
    return f'W/"{count}-{latest.timestamp() if latest else 0}-{revisions}"'


def list_documents(session: Session, workspace_id: str, kind: DocKind | None = None) -> list[Document]:
    query = select(Document).where(Document.workspace_id == workspace_id)
    if kind is not None:
        query = query.where(Document.kind == kind)
    return list(session.exec(query.order_by(col(Document.updated_at).desc())).all())


def list_shared_with(session: Session, user_id: int) -> list[Document]:
    """Documents shared directly with a user, from any workspace."""
    query = (
        select(Document)
        .join(DocumentShare, col(DocumentShare.document_id) == Document.id)
        .where(DocumentShare.principal_type == "user", DocumentShare.principal_id == str(user_id))
        .order_by(col(Document.updated_at).desc())
    )
    return list(session.exec(query).all())


def search_documents(session: Session, workspace_id: str, query: str, kind: DocKind | None = None) -> list[Document]:
    """Documents in a workspace whose title or text matches `query`, newest first. Postgres uses
    its full-text index (word prefixes); SQLite does a case-insensitive substring match."""
    stmt = select(Document).where(Document.workspace_id == workspace_id)
    if kind is not None:
        stmt = stmt.where(Document.kind == kind)
    needle = " ".join(query.split())
    if session.get_bind().dialect.name == "postgresql":
        words = re.findall(r"\w+", needle)
        if not words:
            return []
        stmt = stmt.where(text(f"{TSVECTOR_SQL} @@ to_tsquery('simple', :tsq)").bindparams(tsq=" & ".join(f"{w}:*" for w in words)))
    else:
        pattern = "%" + re.sub(r"([\\%_])", r"\\\1", needle) + "%"
        stmt = stmt.where(or_(col(Document.title).ilike(pattern, escape="\\"), col(Document.search_text).ilike(pattern, escape="\\")))
    return list(session.exec(stmt.order_by(col(Document.updated_at).desc()).limit(SEARCH_LIMIT)).all())


def get_document(session: Session, actor: Actor, doc_id: str, min_role: Role = Role.viewer) -> Document:
    doc = session.get(Document, doc_id)
    if doc is None:
        raise DocumentError(404, f"No document with id {doc_id}")
    check_doc_access(session, actor, doc, min_role)
    return doc


def read_document(doc: Document) -> DocumentRead:
    return DocumentRead(**DocumentSummary.of(doc).model_dump(), content=content_of(doc))


def create_document(
    session: Session,
    actor: Actor,
    kind: DocKind,
    title: str,
    content: dict[str, Any] | None = None,
    source: str = "ui",
) -> Document:
    """Make a document in the actor's current workspace."""
    require_workspace_role(actor, Role.editor)
    data = validate_content(kind, content if content is not None else deepcopy(EMPTY_CONTENT[kind]))
    doc = Document(
        kind=kind,
        title=title.strip() or "Untitled",
        source=source,
        edited_by=actor.agent,
        created_by=actor.agent,
        workspace_id=actor.workspace_id,
        owner_id=actor.user_id,
    )
    session.add(doc)
    _apply_content(session, doc, data)
    _snapshot(session, doc)
    backup.mark_changed(session, doc)
    session.commit()
    session.refresh(doc)
    _announce(doc, "doc.created")
    return doc


def update_document(
    session: Session,
    doc: Document,
    title: str | None = None,
    content: dict[str, Any] | None = None,
    *,
    edited_by: str | None = None,
    base_revision: int | None = None,
) -> tuple[Document, MergeResult | None]:
    """Apply a change; the caller has checked editor access. `edited_by` names the AI agent
    making it (None: the user in Chia). A change built on an older `base_revision` is merged
    three ways with what was saved since, never refused; the MergeResult says so."""
    merged: MergeResult | None = None
    if content is not None:
        content = validate_content(doc.kind, content)
    if base_revision is not None and base_revision < doc.revision:
        base = snapshot_at(session, doc.id, base_revision)
        base_title, base_content = base if base else (None, None)
        if content is not None:
            merged = merge(doc.kind, base_content, content_of(doc), content)
            content = validate_content(doc.kind, merged.content)
        if title is not None and base is not None and doc.title != base_title and title.strip() == base_title:
            title = None  # only the other side renamed it
        merged = merged or MergeResult(content={})
    if content is not None:
        _apply_content(session, doc, content)
    if title is not None:
        doc.title = title.strip() or "Untitled"
    doc.revision += 1
    doc.edited_by = edited_by
    doc.updated_at = utcnow()
    session.add(doc)
    _snapshot(session, doc)
    backup.mark_changed(session, doc)
    session.commit()
    session.refresh(doc)
    _announce(doc, "doc.updated")
    return doc, merged


def delete_document(session: Session, doc: Document) -> Callable[[], None]:
    """Remove the document, its shares and the images only it used. Returns the follow-up work
    (deleting image files, sending the Drive mirror to the Drive trash, restorable for 30 days)
    for the caller to run after the response."""
    owner_id, file_id = doc.owner_id, doc.google_file_id
    keys = assets.release_document(session, doc.id)
    session.execute(delete(DocumentShare).where(col(DocumentShare.document_id) == doc.id))
    session.execute(delete(DocumentSnapshot).where(col(DocumentSnapshot.document_id) == doc.id))
    summary = DocumentSummary.of(doc)
    session.delete(doc)
    session.commit()
    realtime.publish(
        [realtime.workspace_channel(summary.workspace_id), realtime.doc_channel(summary.id)],
        {"type": "doc.deleted", "doc_id": summary.id, "workspace_id": summary.workspace_id, "revision": summary.revision},
    )

    def cleanup() -> None:
        assets.delete_blobs(keys)
        if file_id:
            backup.trash_mirror(owner_id, file_id)

    return cleanup
