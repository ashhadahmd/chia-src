from fastapi import APIRouter, HTTPException, Response, UploadFile, status
from pydantic import BaseModel

from app import assets
from app.db import SessionDep
from app.deps import CurrentUser
from app.models import Asset

router = APIRouter(prefix="/assets", tags=["assets"])


class AssetRead(BaseModel):
    id: str
    url: str  # relative to the API origin, e.g. /api/assets/{id}
    media_type: str


@router.post("", status_code=status.HTTP_201_CREATED)
def upload(file: UploadFile, session: SessionDep, user: CurrentUser) -> AssetRead:
    """Store a PNG, JPEG or GIF for use in a doc."""
    assert user.id is not None
    asset = assets.store(session, user.id, file.file.read(assets.MAX_IMAGE + 1))
    return AssetRead(id=asset.id, url=assets.url(asset), media_type=asset.media_type)


@router.get("/{asset_id}", response_class=Response)
def get(asset_id: str, session: SessionDep) -> Response:
    """Public by design: the unguessable id is the key, since <img> can't send a bearer token."""
    asset = session.get(Asset, asset_id)
    if asset is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such image")
    return Response(
        asset.data,
        media_type=asset.media_type,
        headers={
            "Cache-Control": "private, max-age=31536000, immutable",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; sandbox",
            "Cross-Origin-Resource-Policy": "cross-origin",
        },
    )
