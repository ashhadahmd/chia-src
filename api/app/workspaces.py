"""Workspaces and who may do what.

Every user has a `personal` workspace, made on first need, so solo users never set anything
up: requests without `X-Workspace-Id` land there. Teams use `team`/`enterprise` workspaces
with WorkspaceMember roles, and DocumentShare grants reach single documents across workspaces.

An Actor is whoever is acting: a signed-in user, or an AI agent holding an API key that acts as
that user, possibly locked to one workspace and capped at a role.
"""

import re
import secrets
from dataclasses import dataclass

from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, col, select

from app.models import (
    Document,
    DocumentShare,
    PlanTier,
    PrincipalType,
    Role,
    Workspace,
    WorkspaceKind,
    WorkspaceMember,
)


class AccessError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


@dataclass(frozen=True)
class Actor:
    user_id: int
    workspace_id: str  # the workspace this request works in (new documents go here)
    workspace_role: Role  # the actor's role there, already capped by the key's role
    agent: str | None = None  # AI agent name when acting through an API key; None: the user
    key_id: int | None = None
    key_role: Role | None = None  # an API key's cap (editor or viewer)
    key_workspace_id: str | None = None  # set when the key is locked to one workspace


def _cap(role: Role, cap: Role | None) -> Role:
    return cap if cap is not None and cap.rank < role.rank else role


def _slug(name: str) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:40] or "workspace"
    return f"{base}-{secrets.token_hex(3)}"


def personal_workspace(session: Session, user_id: int, username: str | None = None) -> Workspace:
    """The user's personal workspace, made on first use. Safe when two requests race to make it."""
    found = session.exec(
        select(Workspace).where(Workspace.owner_id == user_id, Workspace.kind == WorkspaceKind.personal)
    ).first()
    if found is not None:
        return found
    if username is None:
        from app.models import User

        user = session.get(User, user_id)
        username = user.username if user else "me"
    ws = Workspace(name="Personal", slug=_slug(username), kind=WorkspaceKind.personal, owner_id=user_id)
    session.add(ws)
    session.add(WorkspaceMember(workspace_id=ws.id, user_id=user_id, role=Role.owner))
    try:
        session.commit()
    except IntegrityError:  # another request made it first
        session.rollback()
        return session.exec(
            select(Workspace).where(Workspace.owner_id == user_id, Workspace.kind == WorkspaceKind.personal)
        ).one()
    session.refresh(ws)
    return ws


def create_workspace(session: Session, user_id: int, name: str, kind: WorkspaceKind) -> Workspace:
    if kind is WorkspaceKind.personal:
        raise AccessError(422, "Every user already has a personal workspace")
    ws = Workspace(
        name=name.strip() or "Team",
        slug=_slug(name),
        kind=kind,
        owner_id=user_id,
        plan_tier=PlanTier.enterprise if kind is WorkspaceKind.enterprise else PlanTier.free,
    )
    session.add(ws)
    session.add(WorkspaceMember(workspace_id=ws.id, user_id=user_id, role=Role.owner))
    session.commit()
    session.refresh(ws)
    return ws


def member_role(session: Session, workspace_id: str, user_id: int) -> Role | None:
    member = session.get(WorkspaceMember, (workspace_id, user_id))
    if member is not None:
        return member.role
    ws = session.get(Workspace, workspace_id)
    # A personal workspace always belongs to its owner, member row or not.
    if ws is not None and ws.kind is WorkspaceKind.personal and ws.owner_id == user_id:
        return Role.owner
    return None


def resolve_actor(
    session: Session,
    user_id: int,
    requested_workspace: str | None,
    *,
    agent: str | None = None,
    key_id: int | None = None,
    key_role: Role | None = None,
    key_workspace_id: str | None = None,
) -> Actor:
    """Pick the workspace a request works in: the key's locked workspace, else the
    X-Workspace-Id header, else the user's personal workspace."""
    requested = (requested_workspace or "").strip() or None
    if key_workspace_id is not None:
        if requested is not None and requested != key_workspace_id:
            raise AccessError(403, "This API key is locked to another workspace")
        workspace_id = key_workspace_id
    elif requested is not None:
        workspace_id = requested
    else:
        workspace_id = personal_workspace(session, user_id).id
    role = member_role(session, workspace_id, user_id)
    if role is None:
        raise AccessError(403, "You are not a member of that workspace")
    return Actor(
        user_id=user_id,
        workspace_id=workspace_id,
        workspace_role=_cap(role, key_role),
        agent=agent,
        key_id=key_id,
        key_role=key_role,
        key_workspace_id=key_workspace_id,
    )


def require_workspace_role(actor: Actor, min_role: Role) -> None:
    if actor.workspace_role.rank < min_role.rank:
        raise AccessError(403, f"This needs the {min_role} role in the workspace")


def doc_role(session: Session, actor: Actor, doc: Document) -> Role | None:
    """The actor's role on `doc`, or None when they can't see it. Checked in order: personal
    ownership, workspace membership, then direct shares; an API key's lock and cap apply last."""
    role: Role | None = None
    if actor.key_workspace_id is None or actor.key_workspace_id == doc.workspace_id:
        role = member_role(session, doc.workspace_id, actor.user_id)
    principals = [(PrincipalType.user, str(actor.user_id))]
    if actor.key_id is not None:
        principals.append((PrincipalType.apikey, str(actor.key_id)))
    if role is None or role.rank < Role.editor.rank:
        shares = session.exec(
            select(DocumentShare).where(
                DocumentShare.document_id == doc.id,
                col(DocumentShare.principal_type).in_([p for p, _ in principals]),
                col(DocumentShare.principal_id).in_([i for _, i in principals]),
            )
        ).all()
        for share in shares:
            if (share.principal_type, share.principal_id) not in principals:
                continue
            # A locked key reaches outside its workspace only through a grant to the key itself.
            locked_out = actor.key_workspace_id is not None and doc.workspace_id != actor.key_workspace_id
            if locked_out and share.principal_type is not PrincipalType.apikey:
                continue
            if role is None or share.role.rank > role.rank:
                role = share.role
    return _cap(role, actor.key_role) if role is not None else None


def check_doc_access(session: Session, actor: Actor, doc: Document, min_role: Role = Role.viewer) -> Role:
    """Raise unless the actor holds at least `min_role` on `doc`. Documents the actor can't see
    at all answer 404, so their existence isn't revealed."""
    role = doc_role(session, actor, doc)
    if role is None:
        raise AccessError(404, f"No document with id {doc.id}")
    if role.rank < min_role.rank:
        raise AccessError(403, f"You have {role} access to this document; this needs {min_role}")
    return role
