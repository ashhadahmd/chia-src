"""Workspaces for teams. Solo users never need these routes: their personal workspace is made
automatically and used whenever a request carries no X-Workspace-Id."""

from datetime import datetime

from fastapi import APIRouter, status
from pydantic import BaseModel
from sqlmodel import func, or_, select

from app.db import SessionDep
from app.deps import CurrentUser
from app.models import PlanTier, Role, User, Workspace, WorkspaceKind, WorkspaceMember
from app.workspaces import (
    AccessError,
    create_workspace,
    member_role,
    personal_workspace,
)

router = APIRouter(prefix="/workspaces", tags=["workspaces"])


class WorkspaceRead(BaseModel):
    id: str
    name: str
    slug: str
    kind: WorkspaceKind
    plan_tier: PlanTier
    role: Role  # yours
    created_at: datetime


class WorkspaceCreate(BaseModel):
    name: str
    kind: WorkspaceKind = WorkspaceKind.team


class MemberRead(BaseModel):
    user_id: int
    username: str
    email: str
    role: Role


class MemberSet(BaseModel):
    user: str  # email or username
    role: Role = Role.editor


def _read(ws: Workspace, role: Role) -> WorkspaceRead:
    return WorkspaceRead(**ws.model_dump(), role=role)


def _require(session: SessionDep, workspace_id: str, user_id: int, min_role: Role) -> Workspace:
    ws = session.get(Workspace, workspace_id)
    role = member_role(session, workspace_id, user_id) if ws else None
    if ws is None or role is None:
        raise AccessError(404, "No such workspace")
    if role.rank < min_role.rank:
        raise AccessError(403, f"This needs the {min_role} role in the workspace")
    return ws


@router.get("")
def list_workspaces(session: SessionDep, user: CurrentUser) -> list[WorkspaceRead]:
    """Your workspaces, personal first."""
    assert user.id is not None
    personal_workspace(session, user.id, user.username)  # made on first use
    rows = session.exec(
        select(Workspace, WorkspaceMember.role)
        .join(WorkspaceMember, WorkspaceMember.workspace_id == Workspace.id)
        .where(WorkspaceMember.user_id == user.id)
        .order_by(Workspace.kind != WorkspaceKind.personal, Workspace.created_at)
    ).all()
    return [_read(ws, role) for ws, role in rows]


@router.post("", status_code=status.HTTP_201_CREATED)
def create(body: WorkspaceCreate, session: SessionDep, user: CurrentUser) -> WorkspaceRead:
    assert user.id is not None
    return _read(create_workspace(session, user.id, body.name, body.kind), Role.owner)


@router.get("/{workspace_id}/members")
def list_members(workspace_id: str, session: SessionDep, user: CurrentUser) -> list[MemberRead]:
    assert user.id is not None
    _require(session, workspace_id, user.id, Role.viewer)
    rows = session.exec(
        select(User, WorkspaceMember.role)
        .join(WorkspaceMember, WorkspaceMember.user_id == User.id)
        .where(WorkspaceMember.workspace_id == workspace_id)
    ).all()
    return [MemberRead(user_id=u.id, username=u.username, email=u.email, role=role) for u, role in rows]


@router.put("/{workspace_id}/members")
def set_member(workspace_id: str, body: MemberSet, session: SessionDep, user: CurrentUser) -> MemberRead:
    """Add someone with a Chia account, or change their role. Admins and the owner only."""
    assert user.id is not None
    ws = _require(session, workspace_id, user.id, Role.admin)
    if ws.kind is WorkspaceKind.personal:
        raise AccessError(422, "Personal workspaces are just you; create a team workspace to invite people")
    if body.role is Role.owner:
        raise AccessError(422, "A workspace has one owner")
    who = body.user.strip().lower()
    target = session.exec(select(User).where(or_(func.lower(User.email) == who, func.lower(User.username) == who))).first()
    if target is None or target.id is None:
        raise AccessError(404, "No Chia user with that email or username")
    if target.id == ws.owner_id:
        raise AccessError(422, "The owner's role can't change")
    member = session.get(WorkspaceMember, (workspace_id, target.id)) or WorkspaceMember(
        workspace_id=workspace_id, user_id=target.id, role=body.role
    )
    member.role = body.role
    session.add(member)
    session.commit()
    return MemberRead(user_id=target.id, username=target.username, email=target.email, role=body.role)


@router.delete("/{workspace_id}/members/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_member(workspace_id: str, user_id: int, session: SessionDep, user: CurrentUser) -> None:
    """Admins remove anyone but the owner; anyone may leave."""
    assert user.id is not None
    ws = _require(session, workspace_id, user.id, Role.viewer if user_id == user.id else Role.admin)
    if user_id == ws.owner_id:
        raise AccessError(422, "The owner can't leave or be removed")
    member = session.get(WorkspaceMember, (workspace_id, user_id))
    if member is None:
        raise AccessError(404, "Not a member")
    session.delete(member)
    session.commit()
