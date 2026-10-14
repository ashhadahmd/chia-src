from datetime import UTC, datetime
from enum import StrEnum
from typing import Any
from secrets import token_urlsafe
from uuid import uuid4

from sqlmodel import JSON, Column, Field, LargeBinary, SQLModel


def utcnow() -> datetime:
    return datetime.now(UTC)


class DocKind(StrEnum):
    doc = "doc"
    sheet = "sheet"
    slides = "slides"


class PageSize(StrEnum):
    letter = "letter"
    a4 = "a4"


# Content shapes. Chia's DB is the source of truth; Google Drive holds a backup mirror.
#   doc    -> {"html": str, "page": "letter" | "a4"}   (html from the editor: p, h1-h3,
#             lists, strong/em/u, <span style="font-size">, text-align, tables, images
#             <img src="/api/assets/{id}"> and diagrams <figure data-type="diagram">)
#   sheet  -> {"columns": [str], "rows": [[str | number | bool | null]]}
#   slides -> {"slides": [{"title": str, "body": str}]}
EMPTY_CONTENT: dict[DocKind, dict[str, Any]] = {
    DocKind.doc: {"html": "", "page": "letter"},
    DocKind.sheet: {"columns": ["A", "B", "C", "D"], "rows": [["", "", "", ""] for _ in range(8)]},
    DocKind.slides: {"slides": [{"title": "", "body": ""}]},
}


class User(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    email: str = Field(unique=True, index=True)
    username: str = Field(unique=True, index=True)
    hashed_password: str
    is_root: bool = False
    created_at: datetime = Field(default_factory=utcnow)


class GoogleAccount(SQLModel, table=True):
    user_id: int = Field(foreign_key="user.id", primary_key=True)
    google_sub: str = Field(index=True)
    email: str
    refresh_token_enc: str
    scopes: str
    backup_folder_id: str | None = None
    connected_at: datetime = Field(default_factory=utcnow)


class OAuthState(SQLModel, table=True):
    """Pending Google consent. `user_id` set = linking an existing user; None = signing in."""

    state: str = Field(primary_key=True)
    user_id: int | None = Field(default=None, foreign_key="user.id")
    code_verifier: str
    created_at: datetime = Field(default_factory=utcnow)


class ApiKey(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    name: str
    prefix: str
    key_hash: str = Field(unique=True, index=True)
    created_at: datetime = Field(default_factory=utcnow)
    last_used_at: datetime | None = None


class Document(SQLModel, table=True):
    id: str = Field(default_factory=lambda: uuid4().hex, primary_key=True)
    kind: DocKind = Field(index=True)
    title: str = "Untitled"
    content: dict[str, Any] | None = Field(default=None, sa_column=Column(JSON))
    source: str = "ui"  # "ui" or "mcp"
    owner_id: int = Field(foreign_key="user.id", index=True)
    # Google Drive backup mirror (a native Google Doc/Sheet/Slides file).
    google_file_id: str | None = Field(default=None, index=True)
    backed_up_at: datetime | None = None
    backup_error: str | None = None
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow, index=True)


class Asset(SQLModel, table=True):
    """An image used in a doc. Served at /api/assets/{id}; the long random id is the access
    key, because <img> requests can't carry the bearer token."""

    id: str = Field(default_factory=lambda: token_urlsafe(24), primary_key=True)
    owner_id: int = Field(foreign_key="user.id", index=True)
    media_type: str
    sha256: str = Field(index=True)
    data: bytes = Field(sa_column=Column(LargeBinary, nullable=False))
    created_at: datetime = Field(default_factory=utcnow)


GOOGLE_URLS = {
    DocKind.doc: "https://docs.google.com/document/d/{}/edit",
    DocKind.sheet: "https://docs.google.com/spreadsheets/d/{}/edit",
    DocKind.slides: "https://docs.google.com/presentation/d/{}/edit",
}


class DocumentSummary(SQLModel):
    id: str
    kind: DocKind
    title: str
    source: str
    drive_url: str | None
    backed_up_at: datetime | None
    backup_error: str | None
    created_at: datetime
    updated_at: datetime

    @classmethod
    def of(cls, doc: Document) -> "DocumentSummary":
        url = GOOGLE_URLS[doc.kind].format(doc.google_file_id) if doc.google_file_id else None
        return cls(**doc.model_dump(exclude={"content"}), drive_url=url)


class DocumentRead(DocumentSummary):
    content: dict[str, Any]


class DocumentCreate(SQLModel):
    kind: DocKind
    title: str = "Untitled"
    content: dict[str, Any] | None = None


class DocumentUpdate(SQLModel):
    title: str | None = None
    content: dict[str, Any] | None = None


class UserPublic(SQLModel):
    id: int
    email: str
    username: str
    is_root: bool


class Token(SQLModel):
    access_token: str
    token_type: str = "bearer"
