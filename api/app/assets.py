"""Images used in docs (uploads, pasted images, rendered diagrams, images from imports).

Docs reference them as <img src="/api/assets/{id}">. Exports resolve those references from
the DB so PDF, Word and Google copies carry the pictures themselves.
"""

import base64
import hashlib
import re
from collections.abc import Callable, Iterable

from sqlmodel import Session, col, select

from app.models import Asset

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

Resolver = Callable[[str], Asset | None]


def sniff(data: bytes) -> str | None:
    return next((mime for sig, mime in _SIGNATURES.items() if data.startswith(sig)), None)


def url(asset: Asset) -> str:
    return f"/api/assets/{asset.id}"


def store(session: Session, owner_id: int, data: bytes) -> Asset:
    """Save an image (deduplicated per owner) and return it."""
    from app.documents import DocumentError  # app.documents imports this module indirectly

    if len(data) > MAX_IMAGE:
        raise DocumentError(413, "Images can be up to 10 MB")
    media_type = sniff(data)
    if media_type is None:
        raise DocumentError(415, "Use a PNG, JPEG or GIF image")
    digest = hashlib.sha256(data).hexdigest()
    existing = session.exec(select(Asset).where(Asset.owner_id == owner_id, Asset.sha256 == digest)).first()
    if existing is not None:
        return existing
    asset = Asset(owner_id=owner_id, media_type=media_type, sha256=digest, data=data)
    session.add(asset)
    session.commit()
    session.refresh(asset)
    return asset


def resolver(session: Session, owner_id: int, html: str) -> Resolver:
    """Look up the owner's images that `html` refers to, in one query."""
    ids = set(ASSET_SRC.findall(html))
    found: dict[str, Asset] = {}
    if ids:
        rows = session.exec(select(Asset).where(Asset.owner_id == owner_id, col(Asset.id).in_(ids))).all()
        found = {a.id: a for a in rows}
    return found.get


def data_uri(asset: Asset) -> str:
    return f"data:{asset.media_type};base64,{base64.b64encode(asset.data).decode()}"


def inline(html: str, resolve: Resolver) -> str:
    """Swap asset URLs for data: URIs (for PDF rendering and Google Docs uploads)."""

    def swap(m: re.Match[str]) -> str:
        asset = resolve(m.group(1))
        return data_uri(asset) if asset else m.group(0)

    return ASSET_SRC.sub(swap, html)


def ids_in(htmls: Iterable[str]) -> set[str]:
    return {i for h in htmls for i in ASSET_SRC.findall(h)}
