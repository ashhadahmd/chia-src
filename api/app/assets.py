"""Images used in docs (uploads, pasted images, rendered diagrams, images from imports).

Docs reference them as <img src="/api/assets/{id}">. The DB holds each image's metadata and
the bytes live in app.storage (a local folder or S3). Exports resolve the references so PDF,
Word and Google copies carry the pictures themselves. AssetReference records which docs use
which images, so deleting a doc finds orphaned images without reading other docs.
"""

import base64
import hashlib
import re
from collections.abc import Callable, Iterable
from dataclasses import dataclass

from sqlalchemy import delete
from sqlmodel import Session, col, select

from app.models import Asset, AssetReference
from app.storage import get_storage

MAX_IMAGE = 10 * 1024 * 1024

# Raster formats every export target understands (Word can't embed WebP or SVG; the editor
# converts those to PNG/JPEG before uploading).
_SIGNATURES = {
    b"\x89PNG\r\n\x1a\n": "image/png",
    b"\xff\xd8\xff": "image/jpeg",
    b"GIF87a": "image/gif",
    b"GIF89a": "image/gif",
}

ASSET_SRC = re.compile(r"(?:https?://[^\"'\s>]*?)?/api/assets/([A-Za-z0-9_-]{16,64})")


@dataclass(frozen=True)
class Blob:
    media_type: str
    data: bytes


Resolver = Callable[[str], Blob | None]


def sniff(data: bytes) -> str | None:
    return next((mime for sig, mime in _SIGNATURES.items() if data.startswith(sig)), None)


def url(asset: Asset) -> str:
    return f"/api/assets/{asset.id}"


def storage_key(asset_id: str) -> str:
    return f"assets/{asset_id}"


def store(session: Session, owner_id: int, data: bytes) -> Asset:
    """Save an image (deduplicated per owner) and return it."""
    from app.documents import (
        DocumentError,  # app.documents imports this module indirectly
    )

    if len(data) > MAX_IMAGE:
        raise DocumentError(413, "Images can be up to 10 MB")
    media_type = sniff(data)
    if media_type is None:
        raise DocumentError(415, "Use a PNG, JPEG or GIF image")
    digest = hashlib.sha256(data).hexdigest()
    existing = session.exec(select(Asset).where(Asset.owner_id == owner_id, Asset.sha256 == digest)).first()
    if existing is not None:
        return existing
    asset = Asset(owner_id=owner_id, media_type=media_type, sha256=digest, storage_key="", size=len(data))
    asset.storage_key = storage_key(asset.id)
    get_storage().put(asset.storage_key, data, media_type)  # bytes first: a row never points at nothing
    session.add(asset)
    session.commit()
    session.refresh(asset)
    return asset


def resolver(session: Session, html: str) -> Resolver:
    """Load the images `html` refers to (one query, then their bytes). Asset ids are the access
    keys (their URLs are public), so any doc may embed any image it knows the id of."""
    ids = set(ASSET_SRC.findall(html))
    found: dict[str, Blob] = {}
    if ids:
        storage = get_storage()
        for asset in session.exec(select(Asset).where(col(Asset.id).in_(ids))).all():
            data = storage.get(asset.storage_key)
            if data is not None:
                found[asset.id] = Blob(asset.media_type, data)
    return found.get


def data_uri(asset: Blob) -> str:
    return f"data:{asset.media_type};base64,{base64.b64encode(asset.data).decode()}"


def inline(html: str, resolve: Resolver) -> str:
    """Swap asset URLs for data: URIs (for PDF rendering and Google Docs uploads)."""

    def swap(m: re.Match[str]) -> str:
        asset = resolve(m.group(1))
        return data_uri(asset) if asset else m.group(0)

    return ASSET_SRC.sub(swap, html)


def ids_in(htmls: Iterable[str]) -> set[str]:
    return {i for h in htmls for i in ASSET_SRC.findall(h)}


def sync_references(session: Session, document_id: str, html: str) -> None:
    """Make AssetReference rows for `document_id` match the images in `html`. The caller commits."""
    wanted = ids_in([html])
    if wanted:
        wanted = set(session.exec(select(Asset.id).where(col(Asset.id).in_(wanted))).all())
    have = set(session.exec(select(AssetReference.asset_id).where(AssetReference.document_id == document_id)).all())
    if gone := have - wanted:
        session.execute(
            delete(AssetReference).where(
                col(AssetReference.document_id) == document_id, col(AssetReference.asset_id).in_(gone)
            )
        )
    session.add_all(AssetReference(document_id=document_id, asset_id=i) for i in wanted - have)


def release_document(session: Session, document_id: str) -> list[str]:
    """Drop a doc's references and the images nothing else uses. Returns the storage keys to
    delete once the transaction commits. The caller commits."""
    ids = list(session.exec(select(AssetReference.asset_id).where(AssetReference.document_id == document_id)).all())
    session.execute(delete(AssetReference).where(col(AssetReference.document_id) == document_id))
    if not ids:
        return []
    still_used = set(session.exec(select(AssetReference.asset_id).where(col(AssetReference.asset_id).in_(ids))).all())
    keys = []
    for asset in session.exec(select(Asset).where(col(Asset.id).in_(set(ids) - still_used))).all():
        keys.append(asset.storage_key)
        session.delete(asset)
    return keys


def delete_blobs(keys: Iterable[str]) -> None:
    storage = get_storage()
    for key in keys:
        storage.delete(key)
