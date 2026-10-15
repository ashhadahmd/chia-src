import hashlib
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel
from sqlmodel import Session, select

from app.config import get_settings
from app.db import SessionDep, get_root_user
from app.deps import CurrentUser
from app.models import ApiKey, Role, utcnow
from app.workspaces import AccessError, member_role

router = APIRouter(prefix="/keys", tags=["mcp keys"])

KEY_PREFIX = "chia_"


def hash_key(key: str) -> str:
    # Keys are 256-bit random, so a fast unsalted hash is sufficient for lookup.
    return hashlib.sha256(key.encode()).hexdigest()


BOOTSTRAP_AGENT = "AI agent"
# last_used_at is a "recently active" hint, so it is written at most this often per key
# instead of on every MCP call.
LAST_USED_GRANULARITY = timedelta(hours=1)


@dataclass(frozen=True)
class KeyGrant:
    user_id: int
    agent: str  # the key's name (e.g. "Codex"), shown on documents the agent changes
    key_id: int | None  # None for the bootstrap key
    workspace_id: str | None  # set when the key is locked to one workspace
    role: Role  # editor or viewer


def agent_for_key(session: Session, key: str) -> KeyGrant | None:
    """Resolve an MCP bearer key to what it grants, or None if it is not valid."""
    if secrets.compare_digest(key.encode(), get_settings().mcp_api_key.encode()):
        root = get_root_user(session)
        assert root.id is not None
        return KeyGrant(root.id, BOOTSTRAP_AGENT, None, None, Role.editor)
    row = session.exec(select(ApiKey).where(ApiKey.key_hash == hash_key(key))).first()
    if row is None:
        return None
    now = utcnow()
    if row.last_used_at is None or row.last_used_at.replace(tzinfo=UTC) < now - LAST_USED_GRANULARITY:
        row.last_used_at = now
        session.add(row)
        session.commit()
    assert row.id is not None
    return KeyGrant(row.user_id, row.name, row.id, row.workspace_id, row.role)


class KeyCreate(BaseModel):
    name: str
    # Lock the agent to one workspace (you must be a member); None follows X-Workspace-Id and
    # falls back to your personal workspace.
    workspace_id: str | None = None
    role: Role = Role.editor  # editor, or viewer for a read-only agent


class KeyInfo(BaseModel):
    id: int
    name: str
    prefix: str
    workspace_id: str | None
    role: Role
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
    if body.role not in (Role.editor, Role.viewer):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "An agent key's role is editor or viewer")
    if body.workspace_id is not None and member_role(session, body.workspace_id, user.id) is None:
        raise AccessError(403, "You are not a member of that workspace")
    key = KEY_PREFIX + secrets.token_urlsafe(32)
    row = ApiKey(
        user_id=user.id,
        name=body.name.strip() or "MCP client",
        prefix=key[:12],
        key_hash=hash_key(key),
        workspace_id=body.workspace_id,
        role=body.role,
    )
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
