from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordRequestForm
from sqlmodel import func, or_, select

from app.db import SessionDep
from app.deps import CurrentUser
from app.models import Token, User, UserPublic
from app.security import DUMMY_HASH, create_access_token, verify_password

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/token")
def login(form: Annotated[OAuth2PasswordRequestForm, Depends()], session: SessionDep) -> Token:
    """Accepts either a username or an email in the `username` field."""
    identifier = form.username.strip().lower()
    user = session.exec(
        select(User).where(or_(func.lower(User.email) == identifier, func.lower(User.username) == identifier))
    ).first()
    if not verify_password(form.password, user.hashed_password if user else DUMMY_HASH) or user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect username, email or password",
            headers={"WWW-Authenticate": "Bearer"},
        )
    assert user.id is not None
    return Token(access_token=create_access_token(user.id))


@router.get("/me", response_model=UserPublic)
def me(user: CurrentUser) -> User:
    return user
