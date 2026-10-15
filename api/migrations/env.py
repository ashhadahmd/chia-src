"""Alembic environment. The URL comes from app settings (DATABASE_URL); offline SQL rendering
(`alembic upgrade head --sql`) accepts `-x url=postgresql://...` to pick a dialect."""

import logging.config

from alembic import context
from sqlalchemy import text
from sqlmodel import SQLModel

import app.models  # noqa: F401  (registers the tables on SQLModel.metadata)
from app.config import get_settings

config = context.config
if config.config_file_name is not None and config.attributes.get("configure_logging", True):
    # Keep the API's own loggers when migrations run at startup.
    logging.config.fileConfig(config.config_file_name, disable_existing_loggers=False)

target_metadata = SQLModel.metadata

# Indexes the models can't declare (Postgres-only expressions); autogenerate must leave them be.
MIGRATION_ONLY_INDEXES = {"ix_document_search"}


def include_object(obj, name, type_, reflected, compare_to) -> bool:
    return not (type_ == "index" and name in MIGRATION_ONLY_INDEXES)


# Held for the length of a Postgres migration so instances starting together migrate one at a time.
ADVISORY_LOCK_ID = 7_243_001


def run_offline() -> None:
    url = context.get_x_argument(as_dictionary=True).get("url") or get_settings().database_url
    context.configure(
        url=url,
        target_metadata=target_metadata,
        include_object=include_object,
        literal_binds=True,
        render_as_batch=url.startswith("sqlite"),
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def run_online() -> None:
    from app.db import engine

    with engine.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            include_object=include_object,
            render_as_batch=connection.dialect.name == "sqlite",
        )
        with context.begin_transaction():
            if connection.dialect.name == "postgresql":
                connection.execute(text(f"SELECT pg_advisory_xact_lock({ADVISORY_LOCK_ID})"))
            context.run_migrations()


if context.is_offline_mode():
    run_offline()
else:
    run_online()
