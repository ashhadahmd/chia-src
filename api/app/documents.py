"""Document operations shared by the REST API and the MCP server.

Chia's DB holds every document. Users who linked Google also get a debounced backup mirror
in their Drive (see `app.google.backup`).
"""

import re
from copy import deepcopy
from typing import Any

from markdown_it import MarkdownIt
from pydantic import BaseModel, ValidationError
from sqlmodel import Session, col, select

from app import assets
from app.google import backup, oauth
from app.models import (
    EMPTY_CONTENT,
    Asset,
    DocKind,
    Document,
    DocumentRead,
    DocumentSummary,
    PageSize,
    utcnow,
)

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


_SHAPES: dict[DocKind, type[BaseModel]] = {DocKind.doc: _Doc, DocKind.sheet: _Sheet, DocKind.slides: _Slides}


_MERMAID = re.compile(r'<pre><code class="language-mermaid">(.*?)</code></pre>', re.DOTALL)


def markdown_to_html(markdown: str) -> str:
    """Markdown to editor HTML; ```mermaid fences become diagrams, drawn when the doc opens."""
    html = _md.render(markdown)
    return _MERMAID.sub(lambda m: f'<figure data-type="diagram" data-code="{m.group(1).rstrip()}"></figure>', html)


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
    return data


def content_of(doc: Document) -> dict[str, Any]:
    """Stored content, upgrading docs saved before the rich editor ({"markdown": ...})."""
    content = doc.content or deepcopy(EMPTY_CONTENT[doc.kind])
    if doc.kind is DocKind.doc and "html" not in content:
        return validate_content(doc.kind, content)
    return content


def _changed(session: Session, doc: Document) -> None:
    if oauth.has_google(session, doc.owner_id):
        backup.schedule(doc.id)


def list_documents(session: Session, owner_id: int, kind: DocKind | None = None) -> list[Document]:
    query = select(Document).where(Document.owner_id == owner_id)
    if kind is not None:
        query = query.where(Document.kind == kind)
    return list(session.exec(query.order_by(col(Document.updated_at).desc())).all())


def get_document(session: Session, owner_id: int, doc_id: str) -> Document:
    doc = session.get(Document, doc_id)
    if doc is None or doc.owner_id != owner_id:
        raise DocumentError(404, f"No document with id {doc_id}")
    return doc


def read_document(doc: Document) -> DocumentRead:
    return DocumentRead(**DocumentSummary.of(doc).model_dump(), content=content_of(doc))


def create_document(
    session: Session,
    owner_id: int,
    kind: DocKind,
    title: str,
    content: dict[str, Any] | None = None,
    source: str = "ui",
) -> Document:
    data = validate_content(kind, content) if content is not None else deepcopy(EMPTY_CONTENT[kind])
    doc = Document(kind=kind, title=title.strip() or "Untitled", content=data, source=source, owner_id=owner_id)
    session.add(doc)
    session.commit()
    session.refresh(doc)
    _changed(session, doc)
    return doc


def update_document(
    session: Session, doc: Document, title: str | None = None, content: dict[str, Any] | None = None
) -> Document:
    if content is not None:
        doc.content = validate_content(doc.kind, content)
    if title is not None:
        doc.title = title.strip() or "Untitled"
    doc.updated_at = utcnow()
    session.add(doc)
    session.commit()
    session.refresh(doc)
    _changed(session, doc)
    return doc


def delete_document(session: Session, doc: Document) -> None:
    """Removes the document and the images only it used; its Drive mirror goes to the Drive
    trash (restorable for 30 days)."""
    if doc.google_file_id:
        backup.trash_mirror(doc.owner_id, doc.google_file_id)
    images = assets.ids_in([(doc.content or {}).get("html", "")])
    session.delete(doc)
    if images:
        others = session.exec(select(Document).where(Document.owner_id == doc.owner_id, Document.id != doc.id)).all()
        still_used = assets.ids_in((d.content or {}).get("html", "") for d in others if d.kind is DocKind.doc)
        for asset in session.exec(select(Asset).where(Asset.owner_id == doc.owner_id, col(Asset.id).in_(images - still_used))).all():
            session.delete(asset)
    session.commit()
