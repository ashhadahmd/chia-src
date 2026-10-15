"""Read-only public links: `/api/public/{token}` serves a document to anyone holding the token,
with no sign-in. Owners and admins turn a link on or off in the share dialog (a DocumentShare
row with principal_type "public_link"); deleting that row revokes the link at once."""

from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, Header, Response, status
from pydantic import BaseModel
from sqlmodel import select

from app import documents
from app.db import SessionDep
from app.documents import DocumentError
from app.models import DocKind, Document, DocumentShare, PrincipalType

router = APIRouter(prefix="/public", tags=["public"])


class PublicDocument(BaseModel):
    """Only what a reader needs: no ids, workspace, owner or agent names."""

    kind: DocKind
    title: str
    revision: int
    updated_at: datetime
    content: dict[str, Any]


@router.get("/{token}", response_model=PublicDocument)
def read_public(token: str, session: SessionDep, response: Response, if_none_match: Annotated[str | None, Header()] = None):
    share = session.exec(
        select(DocumentShare).where(DocumentShare.principal_type == PrincipalType.public_link, DocumentShare.principal_id == token)
    ).first()
    doc = session.get(Document, share.document_id) if share else None
    if doc is None:
        raise DocumentError(404, "This link was turned off, or never existed")
    etag = f'W/"{doc.revision}"'
    # Revalidate every time, so a revoked link stops working even for a cached copy.
    headers = {"ETag": etag, "Cache-Control": "no-cache", "X-Robots-Tag": "noindex"}
    if if_none_match == etag:
        return Response(status_code=status.HTTP_304_NOT_MODIFIED, headers=headers)
    response.headers.update(headers)
    return PublicDocument(kind=doc.kind, title=doc.title, revision=doc.revision, updated_at=doc.updated_at, content=documents.content_of(doc))
