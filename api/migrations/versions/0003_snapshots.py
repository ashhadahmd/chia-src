"""Revision snapshots for three-way merges; stable ids on slides.

- documentsnapshot keeps the last few revisions of each document (zlib-compressed JSON).
  Each document starts with a snapshot of its current revision.
- Every slide gets an `id`, so concurrent edits can be matched slide by slide.

Revision ID: 0003
Revises: 0002
Create Date: 2026-10-15
"""

import json
import secrets
import zlib
from collections.abc import Sequence
from datetime import UTC, datetime

import sqlalchemy as sa
from alembic import context, op

revision: str = "0003"
down_revision: str | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

document_t = sa.table(
    "document",
    sa.column("id", sa.String),
    sa.column("kind", sa.String),
    sa.column("title", sa.String),
    sa.column("content", sa.JSON),
    sa.column("revision", sa.Integer),
)
snapshot_t = sa.table(
    "documentsnapshot",
    sa.column("document_id", sa.String),
    sa.column("revision", sa.Integer),
    sa.column("title", sa.String),
    sa.column("content_z", sa.LargeBinary),
    sa.column("created_at", sa.DateTime(timezone=True)),
)


def upgrade() -> None:
    op.create_table(
        "documentsnapshot",
        sa.Column("document_id", sa.String(), sa.ForeignKey("document.id"), primary_key=True),
        sa.Column("revision", sa.Integer(), primary_key=True),
        sa.Column("title", sa.String(), nullable=False),
        sa.Column("content_z", sa.LargeBinary(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    if context.is_offline_mode():
        return
    bind = op.get_bind()
    now = datetime.now(UTC)
    rows = bind.execute(
        sa.select(document_t.c.id, document_t.c.kind, document_t.c.title, document_t.c.content, document_t.c.revision)
    ).all()
    for doc_id, kind, title, content, rev in rows:
        if kind == "slides" and content:
            seen: set[str] = set()
            slides = []
            for s in content.get("slides", []):
                sid = s.get("id")
                if not sid or sid in seen:
                    sid = secrets.token_hex(4)
                seen.add(sid)
                slides.append({**s, "id": sid})
            content = {**content, "slides": slides}
            bind.execute(document_t.update().where(document_t.c.id == doc_id).values(content=content))
        bind.execute(
            snapshot_t.insert().values(
                document_id=doc_id,
                revision=rev,
                title=title,
                content_z=zlib.compress(json.dumps(content or {}).encode()),
                created_at=now,
            )
        )


def downgrade() -> None:
    op.drop_table("documentsnapshot")
