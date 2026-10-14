import hashlib
import secrets
from datetime import datetime

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel
from sqlmodel import Session, select

from app.config import get_settings
from app.db import SessionDep, get_root_user
from app.deps import CurrentUser
from app.models import ApiKey, utcnow

router = APIRouter(prefix="/keys", tags=["mcp keys"])

KEY_PREFIX = "chia_"


def hash_key(key: str) -> str:
    # Keys are 256-bit random, so a fast unsalted hash is sufficient for lookup.
    return hashlib.sha256(key.encode()).hexdigest()


def user_for_key(session: Session, key: str) -> int | None:
    """Resolve an MCP bearer key to a user id, or None if it is not valid."""
    if secrets.compare_digest(key.encode(), get_settings().mcp_api_key.encode()):
        return get_root_user(session).id
    row = session.exec(select(ApiKey).where(ApiKey.key_hash == hash_key(key))).first()
    if row is None:
        return None
    row.last_used_at = utcnow()
    session.add(row)
    session.commit()
    return row.user_id


class KeyCreate(BaseModel):
    name: str


class KeyInfo(BaseModel):
    id: int
    name: str
    prefix: str
    created_at: datetime
    last_used_at: datetime | None


class KeyCreated(KeyInfo):
    key: str  # shown once


@router.get("")
def list_keys(session: SessionDep, user: CurrentUser) -> list[KeyInfo]:
    rows = session.exec(select(ApiKey).where(ApiKey.user_id == user.id)).all()
    return [KeyInfo(**r.model_dump()) for r in rows]


@router.post("", status_code=status.HTTP_201_CREATED)
def create_key(body: KeyCreate, session: SessionDep, user: CurrentUser) -> KeyCreated:
    """Issue an MCP key that acts as the current user. The full key is returned only once."""
    assert user.id is not None
    key = KEY_PREFIX + secrets.token_urlsafe(32)
    row = ApiKey(user_id=user.id, name=body.name.strip() or "MCP client", prefix=key[:12], key_hash=hash_key(key))
    session.add(row)
    session.commit()
    session.refresh(row)
    return KeyCreated(**row.model_dump(), key=key)


@router.delete("/{key_id}", status_code=status.HTTP_204_NO_CONTENT)
def revoke_key(key_id: int, session: SessionDep, user: CurrentUser) -> None:
    row = session.get(ApiKey, key_id)
    if row is None or row.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Key not found")
    session.delete(row)
    session.commit()
