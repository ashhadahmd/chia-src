from datetime import UTC, datetime
from enum import StrEnum
from secrets import token_urlsafe
from typing import Any
from uuid import uuid4

from sqlalchemy import Enum, Index, LargeBinary, Text, UniqueConstraint, text
from sqlmodel import JSON, Column, Field, SQLModel


def utcnow() -> datetime:
    return datetime.now(UTC)


def _enum(enum: type[StrEnum]) -> Enum:
    """A VARCHAR on every database (no Postgres ENUM types to migrate), loaded as the enum."""
    return Enum(enum, native_enum=False, length=20)


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
#   sheet  -> {"columns": [str], "rows": [[str | number | bool | null]], "row_ids": [str]}
#             (strings starting with "=" are formulas, evaluated in the browser; row_ids are
#             stable per row so concurrent row inserts/deletes merge, see app.merge)
#   slides -> {"slides": [{"id": str, "title": str, "body": str}]}
# Bodies over INLINE_CONTENT_MAX_BYTES are kept in blob storage (see app.offload).
EMPTY_CONTENT: dict[DocKind, dict[str, Any]] = {
    DocKind.doc: {"html": "", "page": "letter"},
    DocKind.sheet: {"columns": ["A", "B", "C", "D"], "rows": [["", "", "", ""] for _ in range(8)]},
    DocKind.slides: {"slides": [{"title": "", "body": ""}]},
}


class WorkspaceKind(StrEnum):
    personal = "personal"  # one per user, made automatically; solo users never see anything else
    team = "team"
    enterprise = "enterprise"


class PlanTier(StrEnum):
    free = "free"
    pro = "pro"
    enterprise = "enterprise"


class Role(StrEnum):
    owner = "owner"
    admin = "admin"
    editor = "editor"
    viewer = "viewer"

    @property
    def rank(self) -> int:
        return _ROLE_RANK[self]


_ROLE_RANK = {Role.viewer: 1, Role.editor: 2, Role.admin: 3, Role.owner: 4}


class PrincipalType(StrEnum):
    user = "user"
    apikey = "apikey"
    public_link = "public_link"


class DriveSyncStatus(StrEnum):
    clean = "clean"  # the Drive mirror matches, or there is no mirror to keep
    pending = "pending"  # changed; a sync is due once edits settle
    syncing = "syncing"  # claimed by a runner (see drive_sync_claimed_at)
    failed = "failed"  # last attempt failed; backup_error says why


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


class Workspace(SQLModel, table=True):
    """Where documents live. Every user has one `personal` workspace; teams share `team` or
    `enterprise` ones through WorkspaceMember."""

    __table_args__ = (
        # At most one personal workspace per user, even when two requests provision it at once.
        Index(
            "uq_workspace_personal_owner",
            "owner_id",
            unique=True,
            sqlite_where=text("kind = 'personal'"),
            postgresql_where=text("kind = 'personal'"),
        ),
    )

    id: str = Field(default_factory=lambda: uuid4().hex, primary_key=True)
    name: str
    slug: str = Field(unique=True, index=True)
    kind: WorkspaceKind = Field(sa_type=_enum(WorkspaceKind), index=True)
    owner_id: int = Field(foreign_key="user.id", index=True)
    plan_tier: PlanTier = Field(default=PlanTier.free, sa_type=_enum(PlanTier))
    created_at: datetime = Field(default_factory=utcnow)


class WorkspaceMember(SQLModel, table=True):
    workspace_id: str = Field(foreign_key="workspace.id", primary_key=True)
    user_id: int = Field(foreign_key="user.id", primary_key=True, index=True)
    role: Role = Field(sa_type=_enum(Role))
    created_at: datetime = Field(default_factory=utcnow)


class OAuthState(SQLModel, table=True):
    """Pending Google consent. `user_id` set = linking an existing user; None = signing in.
    Rows past `expires_at` are ignored and cleared when a new consent starts."""

    state: str = Field(primary_key=True)
    user_id: int | None = Field(default=None, foreign_key="user.id")
    code_verifier: str
    created_at: datetime = Field(default_factory=utcnow)
    expires_at: datetime = Field(index=True)


class ApiKey(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    name: str
    prefix: str
    key_hash: str = Field(unique=True, index=True)
    # None: acts in the user's personal workspace (or the one named by X-Workspace-Id).
    # Set: the agent is locked to that workspace.
    workspace_id: str | None = Field(default=None, foreign_key="workspace.id", index=True)
    role: Role = Field(default=Role.editor, sa_type=_enum(Role))  # editor or viewer; caps what the agent may do
    created_at: datetime = Field(default_factory=utcnow)
    last_used_at: datetime | None = None  # refreshed at most hourly


class Document(SQLModel, table=True):
    __table_args__ = (Index("ix_document_workspace_updated", "workspace_id", "updated_at"),)

    id: str = Field(default_factory=lambda: uuid4().hex, primary_key=True)
    kind: DocKind = Field(sa_type=_enum(DocKind), index=True)
    title: str = "Untitled"
    content: dict[str, Any] | None = Field(default=None, sa_column=Column(JSON))
    # Set when the body is too big to keep inline: `content` is then a stub and the body is in
    # blob storage under this key (see app.offload). Read bodies through documents.content_of.
    s3_content_key: str | None = None
    source: str = "ui"  # "ui" or "mcp"
    # Bumped on every change; the editor sends the revision it last saw so a save can't
    # silently overwrite an AI agent's edit (and notices those edits while the doc is open).
    revision: int = 0
    edited_by: str | None = None  # name of the AI agent that made the latest change; None: the user
    created_by: str | None = None  # name of the AI agent that created it; None: the user
    workspace_id: str = Field(foreign_key="workspace.id", index=True)
    owner_id: int = Field(foreign_key="user.id", index=True)  # the user who created it
    # Words in the document (tags stripped), kept in step with `content` for SQL search.
    search_text: str = Field(default="", sa_column=Column(Text, nullable=False, server_default=""))
    # Google Drive backup mirror (a native Google Doc/Sheet/Slides file) in the creator's Drive.
    google_file_id: str | None = Field(default=None, index=True)
    backed_up_at: datetime | None = None
    backup_error: str | None = None
    drive_sync_status: DriveSyncStatus = Field(default=DriveSyncStatus.clean, sa_type=_enum(DriveSyncStatus), index=True)
    drive_sync_requested_at: datetime | None = None  # latest change waiting for the mirror
    drive_sync_claimed_at: datetime | None = None  # when a runner took it; stale claims expire
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow, index=True)


class DocumentSnapshot(SQLModel, table=True):
    """Content as of one revision, kept for the last few revisions of each document so a save
    built on an older revision can be merged three ways (see app.merge). zlib-compressed JSON,
    or empty with `s3_content_key` naming the offloaded body (shared with the document row)."""

    document_id: str = Field(foreign_key="document.id", primary_key=True)
    revision: int = Field(primary_key=True)
    title: str
    content_z: bytes = Field(sa_column=Column(LargeBinary, nullable=False))
    s3_content_key: str | None = None
    created_at: datetime = Field(default_factory=utcnow)


class DocumentShare(SQLModel, table=True):
    """A grant on one document outside its workspace: a friend or client (user), one AI agent
    (apikey), or anyone holding a link (public_link, principal_id is the link token)."""

    __table_args__ = (UniqueConstraint("document_id", "principal_type", "principal_id", name="uq_documentshare_principal"),)

    id: int | None = Field(default=None, primary_key=True)
    document_id: str = Field(foreign_key="document.id", index=True)
    principal_type: PrincipalType = Field(sa_type=_enum(PrincipalType))
    principal_id: str = Field(index=True)
    role: Role = Field(sa_type=_enum(Role))  # editor or viewer
    created_at: datetime = Field(default_factory=utcnow)


class Asset(SQLModel, table=True):
    """An image used in a doc. Served at /api/assets/{id}; the long random id is the access
    key, because <img> requests can't carry the bearer token. The bytes live in app.storage."""

    id: str = Field(default_factory=lambda: token_urlsafe(24), primary_key=True)
    owner_id: int = Field(foreign_key="user.id", index=True)
    media_type: str
    sha256: str = Field(index=True)
    storage_key: str
    size: int
    created_at: datetime = Field(default_factory=utcnow)


class AssetReference(SQLModel, table=True):
    """Which docs use which images, kept in step on save, so deleting a doc can tell which
    images nothing else uses."""

    document_id: str = Field(foreign_key="document.id", primary_key=True)
    asset_id: str = Field(foreign_key="asset.id", primary_key=True, index=True)


GOOGLE_URLS = {
    DocKind.doc: "https://docs.google.com/document/d/{}/edit",
    DocKind.sheet: "https://docs.google.com/spreadsheets/d/{}/edit",
    DocKind.slides: "https://docs.google.com/presentation/d/{}/edit",
}


class DocumentSummary(SQLModel):
    id: str
    kind: DocKind
    workspace_id: str
    title: str
    source: str
    revision: int
    edited_by: str | None
    created_by: str | None
    drive_url: str | None
    backed_up_at: datetime | None
    backup_error: str | None
    drive_sync_status: DriveSyncStatus
    created_at: datetime
    updated_at: datetime

    @classmethod
    def of(cls, doc: Document) -> DocumentSummary:
        url = GOOGLE_URLS[doc.kind].format(doc.google_file_id) if doc.google_file_id else None
        return cls(**doc.model_dump(exclude={"content", "search_text", "s3_content_key"}), drive_url=url)


class DocumentRead(DocumentSummary):
    content: dict[str, Any]
    role: Role | None = None  # the reader's role on this document (REST reads fill it in)


class DocumentCreate(SQLModel):
    kind: DocKind
    title: str = "Untitled"
    content: dict[str, Any] | None = None


class DocumentUpdate(SQLModel):
    title: str | None = None
    content: dict[str, Any] | None = None
    base_revision: int | None = None  # refuse the change if the doc moved on since this revision


class DocumentSaved(DocumentSummary):
    """A save's result. `merged`: the save was built on an older revision and was combined with
    the changes made since; `content` is then the combined version for the editor to adopt."""

    merged: bool = False
    conflicts: list[str] = []
    content: dict[str, Any] | None = None


class DocumentRevision(SQLModel):
    revision: int
    edited_by: str | None
    updated_at: datetime


class UserPublic(SQLModel):
    id: int
    email: str
    username: str
    is_root: bool


class Token(SQLModel):
    access_token: str
    token_type: str = "bearer"
