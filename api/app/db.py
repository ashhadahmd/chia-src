from collections.abc import Iterator
from typing import Annotated

from fastapi import Depends
from sqlalchemy import inspect, text
from sqlmodel import Session, SQLModel, create_engine, or_, select

from app.config import get_settings
from app.models import User
from app.security import hash_password

settings = get_settings()
engine = create_engine(settings.database_url, connect_args={"check_same_thread": False})


def get_session() -> Iterator[Session]:
    with Session(engine) as session:
        yield session


SessionDep = Annotated[Session, Depends(get_session)]

# Columns added after the first release; create_all() never alters existing tables.
_ADDED_COLUMNS = {
    "document": {
        "google_file_id": "VARCHAR",
        "backed_up_at": "DATETIME",
        "backup_error": "VARCHAR",
    },
    "googleaccount": {"backup_folder_id": "VARCHAR"},
}


def _add_missing_columns() -> None:
    inspector = inspect(engine)
    with engine.begin() as conn:
        for table, columns in _ADDED_COLUMNS.items():
            if not inspector.has_table(table):
                continue
            existing = {c["name"] for c in inspector.get_columns(table)}
            for name, ddl in columns.items():
                if name not in existing:
                    conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}"))


def init_db() -> None:
    _add_missing_columns()
    # Pending OAuth handshakes are short-lived; rebuilding the table keeps its schema current.
    with engine.begin() as conn:
        conn.execute(text("DROP TABLE IF EXISTS oauthstate"))
    SQLModel.metadata.create_all(engine)
    with Session(engine) as session:
        existing = session.exec(
            select(User).where(or_(User.email == settings.root_email, User.username == settings.root_username))
        ).first()
        if existing is None:
            session.add(
                User(
                    email=settings.root_email,
                    username=settings.root_username,
                    hashed_password=hash_password(settings.root_password),
                    is_root=True,
                )
            )
            session.commit()


def get_root_user(session: Session) -> User:
    user = session.exec(select(User).where(User.is_root)).first()
    if user is None:
        raise RuntimeError("Root user missing; init_db() has not run")
    return user
