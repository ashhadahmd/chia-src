import logging
from collections.abc import Iterator
from pathlib import Path
from typing import Annotated

from fastapi import Depends
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, create_engine, or_, select

from app.config import get_settings
from app.models import User
from app.security import hash_password

settings = get_settings()
_sqlite = settings.database_url.startswith("sqlite")
engine = create_engine(
    settings.database_url,
    connect_args={"check_same_thread": False} if _sqlite else {},
    pool_pre_ping=not _sqlite,  # Lambda containers thaw with connections the server already closed
)

API_DIR = Path(__file__).resolve().parent.parent


def get_session() -> Iterator[Session]:
    with Session(engine) as session:
        yield session


SessionDep = Annotated[Session, Depends(get_session)]


def migrate() -> None:
    """Bring the schema to the latest Alembic revision (same as `alembic upgrade head`)."""
    logging.getLogger("alembic.runtime.plugins").setLevel(logging.WARNING)  # import-time chatter
    from alembic import command
    from alembic.config import Config

    config = Config(str(API_DIR / "alembic.ini"))
    config.set_main_option("script_location", str(API_DIR / "migrations"))
    config.attributes["configure_logging"] = False  # keep the server's logging as it is
    command.upgrade(config, "head")


def init_db() -> None:
    """Startup: migrate when AUTO_MIGRATE is on, then make sure the root account exists.
    Safe when several instances start at once."""
    from app.workspaces import personal_workspace

    if settings.auto_migrate:
        migrate()
    with Session(engine) as session:
        root = session.exec(
            select(User).where(or_(User.email == settings.root_email, User.username == settings.root_username))
        ).first()
        if root is None:
            root = User(
                email=settings.root_email,
                username=settings.root_username,
                hashed_password=hash_password(settings.root_password),
                is_root=True,
            )
            session.add(root)
            try:
                session.commit()
            except IntegrityError:  # another instance seeded it first
                session.rollback()
                return
            session.refresh(root)
        assert root.id is not None
        personal_workspace(session, root.id, root.username)


def get_root_user(session: Session) -> User:
    user = session.exec(select(User).where(User.is_root)).first()
    if user is None:
        raise RuntimeError("Root user missing; init_db() has not run")
    return user
