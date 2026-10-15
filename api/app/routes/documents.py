import re
from typing import Annotated
from urllib.parse import quote

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Header,
    Query,
    Response,
    UploadFile,
    status,
)
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel
from sqlmodel import func, or_, select

from app import assets, documents, export, importer
from app.db import SessionDep
from app.deps import CurrentActor
from app.documents import DocumentError
from app.google import backup, oauth, workspace
from app.models import (
    ApiKey,
    DocKind,
    DocumentCreate,
    DocumentRead,
    DocumentRevision,
    DocumentSaved,
    DocumentShare,
    DocumentSummary,
    DocumentUpdate,
    PageSize,
    PrincipalType,
    Role,
    User,
)
from app.workspaces import Actor, check_doc_access, require_workspace_role

router = APIRouter(prefix="/documents", tags=["documents"])


@router.get("", response_model=list[DocumentSummary])
def list_documents(
    session: SessionDep,
    actor: CurrentActor,
    response: Response,
    kind: DocKind | None = None,
    include_shared: Annotated[bool, Query(description="Also list documents shared with you directly")] = False,
    if_none_match: Annotated[str | None, Header()] = None,
):
    """Documents in the current workspace (X-Workspace-Id, or your personal one), newest first.
    Send the last ETag as If-None-Match to get 304 when nothing changed."""
    shared_with = actor.user_id if include_shared else None
    etag = documents.list_etag(session, actor.workspace_id, shared_with) + (f";{kind}" if kind else "")
    if if_none_match == etag:
        return Response(status_code=status.HTTP_304_NOT_MODIFIED, headers={"ETag": etag})
    response.headers["ETag"] = etag
    docs = documents.list_documents(session, actor.workspace_id, kind)
    if shared_with is not None:
        mine = {d.id for d in docs}
        docs += [d for d in documents.list_shared_with(session, shared_with) if d.id not in mine and (kind is None or d.kind == kind)]
        docs.sort(key=lambda d: d.updated_at, reverse=True)
    return [DocumentSummary.of(d) for d in docs]


@router.get("/shared")
def list_shared(session: SessionDep, actor: CurrentActor) -> list[DocumentSummary]:
    """Documents other people shared with you directly, from any workspace."""
    return [DocumentSummary.of(d) for d in documents.list_shared_with(session, actor.user_id)]


@router.post("", status_code=status.HTTP_201_CREATED)
def create_document(body: DocumentCreate, session: SessionDep, actor: CurrentActor) -> DocumentRead:
    return documents.read_document(documents.create_document(session, actor, body.kind, body.title, body.content))


@router.get("/{doc_id}", response_model=DocumentRead)
def get_document(
    doc_id: str,
    session: SessionDep,
    actor: CurrentActor,
    response: Response,
    if_none_match: Annotated[str | None, Header()] = None,
):
    """One document with its content. ETag is the revision: If-None-Match answers 304 when the
    copy the browser has cached is current."""
    doc = documents.get_document(session, actor, doc_id)
    role = check_doc_access(session, actor, doc)
    etag = f'W/"{doc.revision}-{role}"'
    if if_none_match == etag:
        return Response(status_code=status.HTTP_304_NOT_MODIFIED, headers={"ETag": etag})
    response.headers["ETag"] = etag
    return documents.read_document(doc).model_copy(update={"role": role})


@router.patch("/{doc_id}")
def update_document(doc_id: str, body: DocumentUpdate, session: SessionDep, actor: CurrentActor) -> DocumentSaved:
    """Save a change. One built on an older revision (an AI agent or teammate saved since) is
    merged with theirs instead of refused; the reply then carries the merged content."""
    doc = documents.get_document(session, actor, doc_id, Role.editor)
    doc, merged = documents.update_document(session, doc, body.title, body.content, base_revision=body.base_revision)
    saved = DocumentSaved(**DocumentSummary.of(doc).model_dump())
    if merged is not None:
        saved.merged, saved.conflicts, saved.content = True, merged.conflicts, documents.content_of(doc)
    return saved


@router.get("/{doc_id}/revision")
def get_revision(doc_id: str, session: SessionDep, actor: CurrentActor) -> DocumentRevision:
    """Cheap check a tab makes when it comes back into view or reconnects."""
    doc = documents.get_document(session, actor, doc_id)
    return DocumentRevision(revision=doc.revision, edited_by=doc.edited_by, updated_at=doc.updated_at)


@router.delete("/{doc_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_document(doc_id: str, session: SessionDep, actor: CurrentActor, background: BackgroundTasks) -> None:
    """Editors delete what they created; deleting someone else's document takes an admin."""
    doc = documents.get_document(session, actor, doc_id, Role.editor)
    if doc.owner_id != actor.user_id:
        check_doc_access(session, actor, doc, Role.admin)
    background.add_task(documents.delete_document(session, doc))


# ───────────── Sharing ─────────────


class ShareCreate(BaseModel):
    principal_type: PrincipalType = PrincipalType.user
    # A user's email or username, or an API key id (principal_type "apikey").
    principal: str
    role: Role = Role.viewer


class ShareRead(BaseModel):
    id: int
    principal_type: PrincipalType
    principal_id: str
    label: str  # the person's username or the agent key's name
    role: Role


def _share_read(session: SessionDep, row: DocumentShare) -> ShareRead:
    target = None
    if row.principal_type is PrincipalType.user:
        user = session.get(User, int(row.principal_id))
        target = user.username if user else None
    elif row.principal_type is PrincipalType.apikey:
        key = session.get(ApiKey, int(row.principal_id))
        target = key.name if key else None
    return ShareRead(**row.model_dump(), label=target or "(removed)")


@router.get("/{doc_id}/shares")
def list_shares(doc_id: str, session: SessionDep, actor: CurrentActor) -> list[ShareRead]:
    doc = documents.get_document(session, actor, doc_id, Role.admin)
    rows = session.exec(select(DocumentShare).where(DocumentShare.document_id == doc.id)).all()
    return [_share_read(session, r) for r in rows]


@router.post("/{doc_id}/shares", status_code=status.HTTP_201_CREATED)
def share(doc_id: str, body: ShareCreate, session: SessionDep, actor: CurrentActor) -> ShareRead:
    """Give one person (or one AI agent's key) access to this document alone. Public links
    arrive with the local-first sharing work."""
    doc = documents.get_document(session, actor, doc_id, Role.admin)
    if body.role not in (Role.editor, Role.viewer):
        raise DocumentError(422, "A share's role is editor or viewer")
    if body.principal_type is PrincipalType.user:
        who = body.principal.strip().lower()
        target = session.exec(select(User).where(or_(func.lower(User.email) == who, func.lower(User.username) == who))).first()
        if target is None:
            raise DocumentError(404, "No Chia user with that email or username")
        principal_id = str(target.id)
    elif body.principal_type is PrincipalType.apikey:
        key = session.get(ApiKey, int(body.principal)) if body.principal.isdigit() else None
        if key is None or key.user_id != actor.user_id:
            raise DocumentError(404, "No API key of yours with that id")
        principal_id = str(key.id)
    else:
        raise DocumentError(422, "Public links aren't available yet")
    row = session.exec(
        select(DocumentShare).where(
            DocumentShare.document_id == doc.id,
            DocumentShare.principal_type == body.principal_type,
            DocumentShare.principal_id == principal_id,
        )
    ).first() or DocumentShare(document_id=doc.id, principal_type=body.principal_type, principal_id=principal_id, role=body.role)
    row.role = body.role
    session.add(row)
    session.commit()
    session.refresh(row)
    return _share_read(session, row)


@router.delete("/{doc_id}/shares/{share_id}", status_code=status.HTTP_204_NO_CONTENT)
def unshare(doc_id: str, share_id: int, session: SessionDep, actor: CurrentActor) -> None:
    doc = documents.get_document(session, actor, doc_id, Role.admin)
    row = session.get(DocumentShare, share_id)
    if row is None or row.document_id != doc.id:
        raise DocumentError(404, "No such share")
    session.delete(row)
    session.commit()


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


def _save(session: SessionDep, actor: Actor, result: importer.Result) -> ImportResult:
    docs = [documents.create_document(session, actor, i.kind, i.title, i.content) for i in result.items]
    return ImportResult(documents=[DocumentSummary.of(d) for d in docs], notes=result.notes)


@router.post("/import", status_code=status.HTTP_201_CREATED)
def import_file(file: UploadFile, session: SessionDep, actor: CurrentActor) -> ImportResult:
    """Word, Excel, CSV, PowerPoint, Markdown or text. A workbook yields one sheet per tab."""
    require_workspace_role(actor, Role.editor)
    data = file.file.read(importer.MAX_UPLOAD + 1)
    if len(data) > importer.MAX_UPLOAD:
        raise DocumentError(413, "That file is larger than 25 MB")
    return _save(session, actor, importer.convert(file.filename or "", data, _image_store(session, actor.user_id)))


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
def import_google(body: GoogleImport, session: SessionDep, actor: CurrentActor) -> ImportResult:
    """Import a Google Doc/Sheet/Slides file by picker selection or by link.

    Links go through the user's Google account when linked (files Chia may read), then fall
    back to Google's public export, which works for files shared "Anyone with the link".
    """
    require_workspace_role(actor, Role.editor)
    user_id = actor.user_id
    try:
        if body.file_id is not None:
            if not _FILE_ID.match(body.file_id):
                raise DocumentError(422, "Invalid Drive file id")
            name, data = _from_drive(session, user_id, body.file_id)
        else:
            editor, file_id = importer.parse_google_link(body.url or "")
            fetched = None
            if oauth.has_google(session, user_id):
                try:
                    fetched = _from_drive(session, user_id, file_id)
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
    return _save(session, actor, importer.convert(name, data, _image_store(session, user_id)))


# ───────────── Export ─────────────


def _text_doc(session: SessionDep, actor: Actor, doc_id: str):
    doc = documents.get_document(session, actor, doc_id)
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
    actor: CurrentActor,
    background: Annotated[str | None, Query(description="Page colour, e.g. #FAF8F5; default white")] = None,
) -> Response:
    doc, html, page = _text_doc(session, actor, doc_id)
    try:
        bg = export.parse_background(background)
    except ValueError as exc:
        raise DocumentError(422, str(exc)) from exc
    resolve = assets.resolver(session, html)
    pdf = await run_in_threadpool(export.to_pdf, doc.title, html, page, bg, resolve)
    return _download(pdf, doc.title, "pdf", "application/pdf")


@router.get("/{doc_id}/export/docx")
async def export_docx(doc_id: str, session: SessionDep, actor: CurrentActor) -> Response:
    doc, html, page = _text_doc(session, actor, doc_id)
    resolve = assets.resolver(session, html)
    data = await run_in_threadpool(export.to_docx, doc.title, html, page, resolve)
    return _download(data, doc.title, "docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")


def _kind_doc(session: SessionDep, actor: Actor, doc_id: str, kind: DocKind, what: str):
    doc = documents.get_document(session, actor, doc_id)
    if doc.kind is not kind:
        raise DocumentError(400, f"{what} export is available for {'sheets' if kind is DocKind.sheet else 'slide decks'} only")
    return doc, documents.content_of(doc)


@router.get("/{doc_id}/export/xlsx")
async def export_xlsx(doc_id: str, session: SessionDep, actor: CurrentActor) -> Response:
    doc, content = _kind_doc(session, actor, doc_id, DocKind.sheet, "Excel")
    data = await run_in_threadpool(export.to_xlsx, doc.title, content["columns"], content["rows"])
    return _download(data, doc.title, "xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")


@router.get("/{doc_id}/export/pptx")
async def export_pptx(doc_id: str, session: SessionDep, actor: CurrentActor) -> Response:
    doc, content = _kind_doc(session, actor, doc_id, DocKind.slides, "PowerPoint")
    data = await run_in_threadpool(export.to_pptx, doc.title, content["slides"])
    return _download(data, doc.title, "pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation")


class GoogleExport(BaseModel):
    url: str


@router.post("/{doc_id}/export/google")
async def export_google(doc_id: str, session: SessionDep, actor: CurrentActor) -> GoogleExport:
    """Sync the Drive mirror (it lives in the creator's Drive) right now and return its URL."""
    doc = documents.get_document(session, actor, doc_id, Role.editor)
    if not oauth.has_google(session, doc.owner_id):
        raise DocumentError(409, "Connect Google to export to Google Drive")
    synced = await run_in_threadpool(backup.backup_now, doc.id)
    summary = DocumentSummary.of(synced) if synced else None
    if summary is None or summary.drive_url is None:
        raise DocumentError(502, (synced.backup_error if synced else None) or "Google export failed")
    return GoogleExport(url=summary.drive_url)
