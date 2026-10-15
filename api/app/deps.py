from typing import Annotated

from fastapi import Depends, Header, HTTPException, status
from fastapi.security import OAuth2PasswordBearer

from app.db import SessionDep
from app.models import User
from app.security import decode_access_token
from app.workspaces import Actor, resolve_actor

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/token")


def get_current_user(token: Annotated[str, Depends(oauth2_scheme)], session: SessionDep) -> User:
    user_id = decode_access_token(token)
    user = session.get(User, user_id) if user_id is not None else None
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired session",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return user


CurrentUser = Annotated[User, Depends(get_current_user)]


def get_actor(
    user: CurrentUser,
    session: SessionDep,
    x_workspace_id: Annotated[str | None, Header(description="Workspace to work in; omit for your personal workspace")] = None,
) -> Actor:
    assert user.id is not None
    return resolve_actor(session, user.id, x_workspace_id)


CurrentActor = Annotated[Actor, Depends(get_actor)]
