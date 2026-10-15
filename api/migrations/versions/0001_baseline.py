"""Baseline: the schema before workspaces.

Databases made before Alembic (by `create_all` plus the old add-missing-columns step) already
have these tables. This revision adopts them as they are, adding any columns an older copy lacks,
and creates whatever is missing, so old and new databases reach the same starting point.

Revision ID: 0001
Revises:
Create Date: 2026-10-15
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _tables() -> list[tuple[str, list[sa.Column], list]]:
    """(name, columns, extra constraints) for each table, created fresh every call."""
    return [
        (
            "user",
            [
                sa.Column("id", sa.Integer(), primary_key=True),
                sa.Column("email", sa.String(), nullable=False),
                sa.Column("username", sa.String(), nullable=False),
                sa.Column("hashed_password", sa.String(), nullable=False),
                sa.Column("is_root", sa.Boolean(), nullable=False),
                sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            ],
            [],
        ),
        (
            "googleaccount",
            [
                sa.Column("user_id", sa.Integer(), sa.ForeignKey("user.id"), primary_key=True),
                sa.Column("google_sub", sa.String(), nullable=False),
                sa.Column("email", sa.String(), nullable=False),
                sa.Column("refresh_token_enc", sa.String(), nullable=False),
                sa.Column("scopes", sa.String(), nullable=False),
                sa.Column("connected_at", sa.DateTime(timezone=True), nullable=False),
                sa.Column("backup_folder_id", sa.String(), nullable=True),
            ],
            [],
        ),
        (
            "oauthstate",
            [
                sa.Column("state", sa.String(), primary_key=True),
                sa.Column("user_id", sa.Integer(), sa.ForeignKey("user.id"), nullable=True),
                sa.Column("code_verifier", sa.String(), nullable=False),
                sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            ],
            [],
        ),
        (
            "apikey",
            [
                sa.Column("id", sa.Integer(), primary_key=True),
                sa.Column("user_id", sa.Integer(), sa.ForeignKey("user.id"), nullable=False),
                sa.Column("name", sa.String(), nullable=False),
                sa.Column("prefix", sa.String(), nullable=False),
                sa.Column("key_hash", sa.String(), nullable=False),
                sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
                sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
            ],
            [],
        ),
        (
            "document",
            [
                sa.Column("id", sa.String(), primary_key=True),
                sa.Column("kind", sa.String(20), nullable=False),
                sa.Column("title", sa.String(), nullable=False),
                sa.Column("content", sa.JSON(), nullable=True),
                sa.Column("source", sa.String(), nullable=False),
                sa.Column("owner_id", sa.Integer(), sa.ForeignKey("user.id"), nullable=False),
                sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
                sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
                sa.Column("google_file_id", sa.String(), nullable=True),
                sa.Column("backed_up_at", sa.DateTime(timezone=True), nullable=True),
                sa.Column("backup_error", sa.String(), nullable=True),
                sa.Column("revision", sa.Integer(), nullable=False, server_default="0"),
                sa.Column("edited_by", sa.String(), nullable=True),
                sa.Column("created_by", sa.String(), nullable=True),
            ],
            [],
        ),
        (
            "asset",
            [
                sa.Column("id", sa.String(), primary_key=True),
                sa.Column("owner_id", sa.Integer(), sa.ForeignKey("user.id"), nullable=False),
                sa.Column("media_type", sa.String(), nullable=False),
                sa.Column("sha256", sa.String(), nullable=False),
                sa.Column("data", sa.LargeBinary(), nullable=False),
                sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            ],
            [],
        ),
    ]


# (table, name, columns, unique)
_INDEXES = [
    ("user", "ix_user_email", ["email"], True),
    ("user", "ix_user_username", ["username"], True),
    ("googleaccount", "ix_googleaccount_google_sub", ["google_sub"], False),
    ("apikey", "ix_apikey_key_hash", ["key_hash"], True),
    ("apikey", "ix_apikey_user_id", ["user_id"], False),
    ("document", "ix_document_kind", ["kind"], False),
    ("document", "ix_document_owner_id", ["owner_id"], False),
    ("document", "ix_document_updated_at", ["updated_at"], False),
    ("asset", "ix_asset_owner_id", ["owner_id"], False),
    ("asset", "ix_asset_sha256", ["sha256"], False),
]


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    for name, columns, extra in _tables():
        if not inspector.has_table(name):
            op.create_table(name, *columns, *extra)
            continue
        existing = {c["name"] for c in inspector.get_columns(name)}
        for column in columns:
            if column.name not in existing:
                # Columns the old add-missing-columns step added later; all nullable or defaulted.
                default = column.server_default.arg if column.server_default is not None else None
                op.add_column(name, sa.Column(column.name, column.type, nullable=True if default is None else column.nullable, server_default=default))
    inspector = sa.inspect(op.get_bind())
    for table, index, columns, unique in _INDEXES:
        if index not in {i["name"] for i in inspector.get_indexes(table)}:
            op.create_index(index, table, columns, unique=unique)


def downgrade() -> None:
    for name, _, _ in reversed(_tables()):
        op.drop_table(name)
