"""Offloaded document bodies.

- document.s3_content_key / documentsnapshot.s3_content_key: set when a body larger than
  INLINE_CONTENT_MAX_BYTES lives in blob storage (see app.offload). Existing rows stay inline.

Revision ID: 0004
Revises: 0003
Create Date: 2026-10-15
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0004"
down_revision: str | None = "0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("document") as batch:
        batch.add_column(sa.Column("s3_content_key", sa.String(), nullable=True))
    with op.batch_alter_table("documentsnapshot") as batch:
        batch.add_column(sa.Column("s3_content_key", sa.String(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("documentsnapshot") as batch:
        batch.drop_column("s3_content_key")
    with op.batch_alter_table("document") as batch:
        batch.drop_column("s3_content_key")
