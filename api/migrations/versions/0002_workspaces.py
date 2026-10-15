"""Workspaces, sharing, scoped API keys, image bytes out of the DB, SQL search, Drive sync state.

- workspace / workspacemember / documentshare / assetreference tables.
- Every user gets a personal workspace; their documents move into it.
- apikey gains workspace_id (lock) and role (cap).
- asset bytes move to app.storage (local folder or S3, per STORAGE_BACKEND); the column goes.
- document gains search_text, filled from content, and drive_sync_* columns; docs with an
  out-of-date Drive mirror start as `pending` so the sync runner catches them up.
- oauthstate gains expires_at (rebuilt: its rows are minutes-lived consents).
- Postgres only: a GIN full-text index on title + search_text.

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-15
"""

import html as htmllib
import re
import secrets
from collections.abc import Sequence
from datetime import UTC, datetime
from uuid import uuid4

import sqlalchemy as sa
from alembic import context, op

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Must match app.documents.TSVECTOR_SQL so Postgres uses the index for searches.
TSVECTOR_SQL = "to_tsvector('simple'::regconfig, coalesce(document.title, '') || ' ' || document.search_text)"
ASSET_SRC = re.compile(r"(?:https?://[^\"'\s>]*?)?/api/assets/([A-Za-z0-9_-]{16,64})")
ENUM = sa.String(20)

user_t = sa.table("user", sa.column("id", sa.Integer), sa.column("username", sa.String))
workspace_t = sa.table(
    "workspace",
    sa.column("id", sa.String),
    sa.column("name", sa.String),
    sa.column("slug", sa.String),
    sa.column("kind", sa.String),
    sa.column("owner_id", sa.Integer),
    sa.column("plan_tier", sa.String),
    sa.column("created_at", sa.DateTime(timezone=True)),
)
member_t = sa.table(
    "workspacemember",
    sa.column("workspace_id", sa.String),
    sa.column("user_id", sa.Integer),
    sa.column("role", sa.String),
    sa.column("created_at", sa.DateTime(timezone=True)),
)
document_t = sa.table(
    "document",
    sa.column("id", sa.String),
    sa.column("kind", sa.String),
    sa.column("content", sa.JSON),
    sa.column("owner_id", sa.Integer),
    sa.column("workspace_id", sa.String),
    sa.column("search_text", sa.Text),
    sa.column("updated_at", sa.DateTime(timezone=True)),
    sa.column("backed_up_at", sa.DateTime(timezone=True)),
    sa.column("drive_sync_status", sa.String),
    sa.column("drive_sync_requested_at", sa.DateTime(timezone=True)),
)
google_t = sa.table("googleaccount", sa.column("user_id", sa.Integer))
asset_t = sa.table(
    "asset",
    sa.column("id", sa.String),
    sa.column("media_type", sa.String),
    sa.column("data", sa.LargeBinary),
    sa.column("storage_key", sa.String),
    sa.column("size", sa.Integer),
)
assetref_t = sa.table("assetreference", sa.column("document_id", sa.String), sa.column("asset_id", sa.String))


def _text(kind: str, content: dict | None) -> str:
    """Same as app.documents.extract_text, frozen here so later code changes can't alter it."""
    content = content or {}
    if kind == "doc":
        raw = htmllib.unescape(re.sub(r"<[^>]+>", " ", content.get("html") or content.get("markdown") or ""))
    elif kind == "sheet":
        raw = " ".join(str(v) for row in [content.get("columns", []), *content.get("rows", [])] for v in row if v is not None)
    else:
        raw = " ".join(f"{s.get('title', '')} {s.get('body', '')}" for s in content.get("slides", []))
    return " ".join(raw.split())


def _slug(name: str) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")[:40] or "workspace"
    return f"{base}-{secrets.token_hex(3)}"


def _backfill() -> None:
    bind = op.get_bind()
    now = datetime.now(UTC)

    personal: dict[int, str] = {}
    for user_id, username in bind.execute(sa.select(user_t.c.id, user_t.c.username)).all():
        ws_id = uuid4().hex
        personal[user_id] = ws_id
        bind.execute(
            workspace_t.insert().values(
                id=ws_id, name="Personal", slug=_slug(username), kind="personal", owner_id=user_id, plan_tier="free", created_at=now
            )
        )
        bind.execute(member_t.insert().values(workspace_id=ws_id, user_id=user_id, role="owner", created_at=now))
        bind.execute(document_t.update().where(document_t.c.owner_id == user_id).values(workspace_id=ws_id))

    linked = set(bind.execute(sa.select(google_t.c.user_id)).scalars().all())
    asset_ids = set(bind.execute(sa.select(asset_t.c.id)).scalars().all())
    rows = bind.execute(
        sa.select(
            document_t.c.id, document_t.c.kind, document_t.c.content, document_t.c.owner_id,
            document_t.c.updated_at, document_t.c.backed_up_at,
        )
    ).all()
    for doc_id, kind, content, owner_id, updated_at, backed_up_at in rows:
        # The old in-memory queue re-sent these on restart; now the sync runner does.
        stale = owner_id in linked and (backed_up_at is None or backed_up_at < updated_at)
        bind.execute(
            document_t.update()
            .where(document_t.c.id == doc_id)
            .values(
                search_text=_text(kind, content),
                drive_sync_status="pending" if stale else "clean",
                drive_sync_requested_at=now if stale else None,
            )
        )
        if kind == "doc":
            used = set(ASSET_SRC.findall((content or {}).get("html", ""))) & asset_ids
            for asset_id in used:
                bind.execute(assetref_t.insert().values(document_id=doc_id, asset_id=asset_id))

    if asset_ids:
        from app.storage import (
            get_storage,  # the configured backend (local folder or S3)
        )

        storage = get_storage()
        for asset_id in asset_ids:
            media_type, data = bind.execute(
                sa.select(asset_t.c.media_type, asset_t.c.data).where(asset_t.c.id == asset_id)
            ).one()
            key = f"assets/{asset_id}"
            storage.put(key, data, media_type)
            bind.execute(asset_t.update().where(asset_t.c.id == asset_id).values(storage_key=key, size=len(data)))


def upgrade() -> None:
    op.create_table(
        "workspace",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("slug", sa.String(), nullable=False),
        sa.Column("kind", ENUM, nullable=False),
        sa.Column("owner_id", sa.Integer(), sa.ForeignKey("user.id"), nullable=False),
        sa.Column("plan_tier", ENUM, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_workspace_slug", "workspace", ["slug"], unique=True)
    op.create_index("ix_workspace_kind", "workspace", ["kind"])
    op.create_index("ix_workspace_owner_id", "workspace", ["owner_id"])
    op.create_index(
        "uq_workspace_personal_owner",
        "workspace",
        ["owner_id"],
        unique=True,
        sqlite_where=sa.text("kind = 'personal'"),
        postgresql_where=sa.text("kind = 'personal'"),
    )
    op.create_table(
        "workspacemember",
        sa.Column("workspace_id", sa.String(), sa.ForeignKey("workspace.id"), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("user.id"), primary_key=True),
        sa.Column("role", ENUM, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_workspacemember_user_id", "workspacemember", ["user_id"])
    op.create_table(
        "documentshare",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("document_id", sa.String(), sa.ForeignKey("document.id"), nullable=False),
        sa.Column("principal_type", ENUM, nullable=False),
        sa.Column("principal_id", sa.String(), nullable=False),
        sa.Column("role", ENUM, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("document_id", "principal_type", "principal_id", name="uq_documentshare_principal"),
    )
    op.create_index("ix_documentshare_document_id", "documentshare", ["document_id"])
    op.create_index("ix_documentshare_principal_id", "documentshare", ["principal_id"])
    op.create_table(
        "assetreference",
        sa.Column("document_id", sa.String(), sa.ForeignKey("document.id"), primary_key=True),
        sa.Column("asset_id", sa.String(), sa.ForeignKey("asset.id"), primary_key=True),
    )
    op.create_index("ix_assetreference_asset_id", "assetreference", ["asset_id"])

    # Pending Google consents last minutes; rebuilding the table once is simpler than altering it.
    op.drop_table("oauthstate")
    op.create_table(
        "oauthstate",
        sa.Column("state", sa.String(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("user.id"), nullable=True),
        sa.Column("code_verifier", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_oauthstate_expires_at", "oauthstate", ["expires_at"])

    with op.batch_alter_table("document") as batch:
        batch.add_column(sa.Column("workspace_id", sa.String(), sa.ForeignKey("workspace.id", name="fk_document_workspace_id"), nullable=True))
        batch.add_column(sa.Column("search_text", sa.Text(), nullable=False, server_default=""))
        batch.add_column(sa.Column("drive_sync_status", ENUM, nullable=False, server_default="clean"))
        batch.add_column(sa.Column("drive_sync_requested_at", sa.DateTime(timezone=True), nullable=True))
        batch.add_column(sa.Column("drive_sync_claimed_at", sa.DateTime(timezone=True), nullable=True))
    with op.batch_alter_table("apikey") as batch:
        batch.add_column(sa.Column("workspace_id", sa.String(), sa.ForeignKey("workspace.id", name="fk_apikey_workspace_id"), nullable=True))
        batch.add_column(sa.Column("role", ENUM, nullable=False, server_default="editor"))
        batch.create_index("ix_apikey_workspace_id", ["workspace_id"])
    with op.batch_alter_table("asset") as batch:
        batch.add_column(sa.Column("storage_key", sa.String(), nullable=True))
        batch.add_column(sa.Column("size", sa.Integer(), nullable=True))

    if not context.is_offline_mode():
        _backfill()

    # A `storage` column from an early prototype lingers in some dev databases; nothing reads it.
    legacy_storage = not context.is_offline_mode() and "storage" in {c["name"] for c in sa.inspect(op.get_bind()).get_columns("document")}
    with op.batch_alter_table("document") as batch:
        if legacy_storage:
            batch.drop_column("storage")
        batch.alter_column("workspace_id", existing_type=sa.String(), nullable=False)
        batch.create_index("ix_document_workspace_id", ["workspace_id"])
        batch.create_index("ix_document_workspace_updated", ["workspace_id", "updated_at"])
        batch.create_index("ix_document_drive_sync_status", ["drive_sync_status"])
        batch.create_index("ix_document_google_file_id", ["google_file_id"])
    with op.batch_alter_table("asset") as batch:
        batch.drop_column("data")
        batch.alter_column("storage_key", existing_type=sa.String(), nullable=False)
        batch.alter_column("size", existing_type=sa.Integer(), nullable=False)

    if op.get_context().dialect.name == "postgresql":
        op.execute(f"CREATE INDEX ix_document_search ON document USING gin (({TSVECTOR_SQL}))")


def downgrade() -> None:
    """Back to one-owner documents. Image bytes are copied back into the DB from storage
    (storage files are left in place); workspaces, members, shares and key scopes are dropped."""
    if op.get_context().dialect.name == "postgresql":
        op.execute("DROP INDEX IF EXISTS ix_document_search")
    with op.batch_alter_table("asset") as batch:
        batch.add_column(sa.Column("data", sa.LargeBinary(), nullable=True))
    if not context.is_offline_mode():
        from app.storage import get_storage

        bind, storage = op.get_bind(), get_storage()
        for asset_id, key in bind.execute(sa.select(asset_t.c.id, asset_t.c.storage_key)).all():
            bind.execute(asset_t.update().where(asset_t.c.id == asset_id).values(data=storage.get(key) or b""))
    with op.batch_alter_table("asset") as batch:
        batch.alter_column("data", existing_type=sa.LargeBinary(), nullable=False)
        batch.drop_column("size")
        batch.drop_column("storage_key")

    with op.batch_alter_table("document") as batch:
        for index in ("ix_document_google_file_id", "ix_document_drive_sync_status", "ix_document_workspace_updated", "ix_document_workspace_id"):
            batch.drop_index(index)
        for column in ("drive_sync_claimed_at", "drive_sync_requested_at", "drive_sync_status", "search_text", "workspace_id"):
            batch.drop_column(column)
    with op.batch_alter_table("apikey") as batch:
        batch.drop_index("ix_apikey_workspace_id")
        batch.drop_column("role")
        batch.drop_column("workspace_id")

    op.drop_table("oauthstate")
    op.create_table(
        "oauthstate",
        sa.Column("state", sa.String(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("user.id"), nullable=True),
        sa.Column("code_verifier", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.drop_table("assetreference")
    op.drop_table("documentshare")
    op.drop_table("workspacemember")
    op.drop_table("workspace")
