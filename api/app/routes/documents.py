from typing import Annotated
from urllib.parse import quote

import re

from fastapi import APIRouter, Query, Response, UploadFile, status
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel

from app import assets, documents, export, importer
from app.db import SessionDep
from app.deps import CurrentUser
from app.documents import DocumentError
from app.google import backup, oauth, workspace
from app.models import (
    DocKind,
    DocumentCreate,
    DocumentRead,
    DocumentSummary,
    DocumentUpdate,
    PageSize,
)

router = APIRouter(prefix="/documents", tags=["documents"])


@router.get("")
def list_documents(session: SessionDep, user: CurrentUser, kind: DocKind | None = None) -> list[DocumentSummary]:
    assert user.id is not None
    return [DocumentSummary.of(d) for d in documents.list_documents(session, user.id, kind)]


@router.post("", status_code=status.HTTP_201_CREATED)
def create_document(body: DocumentCreate, session: SessionDep, user: CurrentUser) -> DocumentRead:
    assert user.id is not None
    return documents.read_document(documents.create_document(session, user.id, body.kind, body.title, body.content))


@router.get("/{doc_id}")
def get_document(doc_id: str, session: SessionDep, user: CurrentUser) -> DocumentRead:
    assert user.id is not None
    return documents.read_document(documents.get_document(session, user.id, doc_id))


@router.patch("/{doc_id}")
def update_document(doc_id: str, body: DocumentUpdate, session: SessionDep, user: CurrentUser) -> DocumentSummary:
    assert user.id is not None
    doc = documents.get_document(session, user.id, doc_id)
    return DocumentSummary.of(documents.update_document(session, doc, body.title, body.content))


@router.delete("/{doc_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_document(doc_id: str, session: SessionDep, user: CurrentUser) -> None:
    assert user.id is not None
    documents.delete_document(session, documents.get_document(session, user.id, doc_id))


# ───────────── Import ─────────────


class ImportResult(BaseModel):
    documents: list[DocumentSummary]
    notes: list[str]  # what the conversion left out, e.g. images


class GoogleImport(BaseModel):
    url: str | None = None  # a Docs/Sheets/Slides/Drive link
    file_id: str | None = None  # a file chosen in the Google Picker


_FILE_ID = re.compile(r"^[A-Za-z0-9_-]{10,200}$")


def _image_store(session: SessionDep, user_id: int) -> importer.StoreImage:
    def store(data: bytes) -> str | None:
        try:
            return assets.url(assets.store(session, user_id, data))
        except DocumentError:  # too large or an unusable format
            return None

    return store


def _save(session: SessionDep, user_id: int, result: importer.Result) -> ImportResult:
    docs = [documents.create_document(session, user_id, i.kind, i.title, i.content) for i in result.items]
    return ImportResult(documents=[DocumentSummary.of(d) for d in docs], notes=result.notes)


@router.post("/import", status_code=status.HTTP_201_CREATED)
def import_file(file: UploadFile, session: SessionDep, user: CurrentUser) -> ImportResult:
    """Word, Excel, CSV, PowerPoint, Markdown or text. A workbook yields one sheet per tab."""
    assert user.id is not None
    data = file.file.read(importer.MAX_UPLOAD + 1)
    if len(data) > importer.MAX_UPLOAD:
        raise DocumentError(413, "That file is larger than 25 MB")
    return _save(session, user.id, importer.convert(file.filename or "", data, _image_store(session, user.id)))


def _from_drive(session: SessionDep, user_id: int, file_id: str) -> tuple[str, bytes]:
    creds = oauth.credentials_for(session, user_id)
    if creds is None:
        raise DocumentError(409, "Connect Google to import from Drive")
    try:
        return workspace.download(creds, file_id, importer.MAX_UPLOAD)
    except workspace.GoogleApiError as exc:
        if exc.status in (403, 404):
            raise DocumentError(403, "Chia can't open that Drive file. Pick it from Drive so Google lets Chia read it.") from exc
        raise DocumentError(exc.status, str(exc)) from exc


@router.post("/import/google", status_code=status.HTTP_201_CREATED)
def import_google(body: GoogleImport, session: SessionDep, user: CurrentUser) -> ImportResult:
    """Import a Google Doc/Sheet/Slides file by picker selection or by link.

    Links go through the user's Google account when linked (files Chia may read), then fall
    back to Google's public export, which works for files shared "Anyone with the link".
    """
    assert user.id is not None
    try:
        if body.file_id is not None:
            if not _FILE_ID.match(body.file_id):
                raise DocumentError(422, "Invalid Drive file id")
            name, data = _from_drive(session, user.id, body.file_id)
        else:
            editor, file_id = importer.parse_google_link(body.url or "")
            fetched = None
            if oauth.has_google(session, user.id):
                try:
                    fetched = _from_drive(session, user.id, file_id)
                except DocumentError as exc:
                    if exc.status != 403:
                        raise
                except oauth.GoogleReconnectRequired:
                    pass  # a public link may still work
            if fetched is None and editor is None:
                raise DocumentError(
                    403, "Chia can't open that Drive file. Download it and import the file, or pick it from Drive."
                )
            name, data = fetched or importer.fetch_public(editor or "", file_id)
    except oauth.GoogleReconnectRequired as exc:
        raise DocumentError(409, str(exc)) from exc
    return _save(session, user.id, importer.convert(name, data, _image_store(session, user.id)))


# ───────────── Export ─────────────


def _text_doc(session: SessionDep, user: CurrentUser, doc_id: str):
    assert user.id is not None
    doc = documents.get_document(session, user.id, doc_id)
    if doc.kind is not DocKind.doc:
        raise DocumentError(400, "PDF and Word export are available for docs only")
    content = documents.content_of(doc)
    return doc, content["html"], PageSize(content.get("page", "letter"))


def _download(data: bytes, title: str, ext: str, media_type: str) -> Response:
    name = f"{title.strip() or 'Untitled'}.{ext}"
    ascii_name = name.encode("ascii", "ignore").decode().replace('"', "") or f"document.{ext}"
    disposition = f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(name)}"
    return Response(data, media_type=media_type, headers={"Content-Disposition": disposition})


@router.get("/{doc_id}/export/pdf")
async def export_pdf(
    doc_id: str,
    session: SessionDep,
    user: CurrentUser,
    background: Annotated[str | None, Query(description="Page colour, e.g. #FAF8F5; default white")] = None,
) -> Response:
    doc, html, page = _text_doc(session, user, doc_id)
    try:
        bg = export.parse_background(background)
    except ValueError as exc:
        raise DocumentError(422, str(exc)) from exc
    resolve = assets.resolver(session, doc.owner_id, html)
    pdf = await run_in_threadpool(export.to_pdf, doc.title, html, page, bg, resolve)
    return _download(pdf, doc.title, "pdf", "application/pdf")


@router.get("/{doc_id}/export/docx")
async def export_docx(doc_id: str, session: SessionDep, user: CurrentUser) -> Response:
    doc, html, page = _text_doc(session, user, doc_id)
    resolve = assets.resolver(session, doc.owner_id, html)
    data = await run_in_threadpool(export.to_docx, doc.title, html, page, resolve)
    return _download(data, doc.title, "docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")


class GoogleExport(BaseModel):
    url: str


@router.post("/{doc_id}/export/google")
async def export_google(doc_id: str, session: SessionDep, user: CurrentUser) -> GoogleExport:
    """Sync the Drive mirror right now and return its Google editor URL."""
    assert user.id is not None
    doc = documents.get_document(session, user.id, doc_id)
    if not oauth.has_google(session, user.id):
        raise DocumentError(409, "Connect Google to export to Google Docs")
    synced = await run_in_threadpool(backup.backup_now, doc.id)
    summary = DocumentSummary.of(synced) if synced else None
    if summary is None or summary.drive_url is None:
        raise DocumentError(502, (synced.backup_error if synced else None) or "Google export failed")
    return GoogleExport(url=summary.drive_url)
