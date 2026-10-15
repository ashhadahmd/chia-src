"""End-to-end tests run the real app against a throwaway SQLite database and storage folder.

Settings and the engine are read at import, so the environment is set before `app` loads.
Run: `uv run pytest` (add -x to stop at the first failure). Set TEST_DATABASE_URL to run against
an empty Postgres database instead, e.g. postgresql+psycopg://postgres:pw@localhost:5432/chia_test.
"""

import os
import tempfile
from pathlib import Path

import pytest

_tmp = Path(tempfile.mkdtemp(prefix="chia-test-"))
os.environ.update(
    DATABASE_URL=os.environ.get("TEST_DATABASE_URL") or f"sqlite:///{_tmp / 'test.db'}",
    LOCAL_STORAGE_DIR=str(_tmp / "storage"),
    STORAGE_BACKEND="local",
    DRIVE_SYNC_RUNNER="external",
    AUTO_MIGRATE="true",
    SECRET_KEY="test-secret-key-that-is-at-least-32-bytes",
    MCP_API_KEY="test-bootstrap-key",
    ROOT_EMAIL="root@test.chia",
    ROOT_USERNAME="root",
    ROOT_PASSWORD="test-password",
    TOKEN_ENCRYPTION_KEY="Zm9yLXRlc3RzLW9ubHktMzItYnl0ZXMtbG9uZy1rZXk=",
    GOOGLE_CLIENT_ID="",
    GOOGLE_CLIENT_SECRET="",
)

from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture(scope="session")
def client():
    # MCP's DNS-rebinding guard only accepts localhost hosts.
    with TestClient(app, base_url="http://localhost:8000") as c:
        yield c
