from functools import lru_cache
from typing import Literal

from pydantic import EmailStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    secret_key: str
    # Bootstrap MCP key, mapped to the root user. Per-user keys are issued via /api/keys.
    mcp_api_key: str
    access_token_minutes: int = 60 * 12

    root_email: EmailStr
    root_username: str
    root_password: str

    database_url: str = "sqlite:///./chia.db"
    # Run `alembic upgrade head` on startup. Handy locally; turn off where many instances start
    # at once (AWS Lambda) and migrate from the deploy pipeline instead.
    auto_migrate: bool = True
    cors_origins: list[str] = ["http://localhost:5173"]
    # Host names MCP clients reach this API by, besides localhost (e.g. the API Gateway or
    # custom domain). MCP's DNS-rebinding guard answers 421 to any other Host header.
    mcp_allowed_hosts: list[str] = []

    # Where image bytes live. "local" needs no AWS setup; "s3" serves them through presigned URLs.
    storage_backend: Literal["local", "s3"] = "local"
    local_storage_dir: str = ".local_storage"
    s3_bucket: str = ""
    s3_prefix: str = ""
    s3_region: str | None = None
    s3_endpoint_url: str | None = None  # MinIO / LocalStack
    presigned_url_seconds: int = 3600
    # Document bodies (and their revision snapshots) larger than this, as JSON, are gzipped into
    # the blob storage above; the row keeps a small stub. Keeps Postgres rows and Lambda payloads small.
    inline_content_max_bytes: int = 65536

    # Where change notices go besides this process's own WebSockets (/api/ws).
    # "aws_appsync": also publish to AWS AppSync Events, which browsers subscribe to directly
    # (Lambda has no long-lived sockets). Publishing signs with IAM (SigV4) unless an API key is set.
    realtime_backend: Literal["local", "aws_appsync"] = "local"
    appsync_http_endpoint: str = ""  # e.g. https://xxxx.appsync-api.us-east-1.amazonaws.com
    appsync_realtime_endpoint: str = ""  # e.g. wss://xxxx.appsync-realtime-api.us-east-1.amazonaws.com
    appsync_namespace: str = "chia"
    appsync_region: str | None = None
    # Dev only: browsers also receive this key and could subscribe to any channel. In production
    # leave it empty: the server publishes with IAM and browsers subscribe through the Lambda
    # authorizer in app.lambda_handler, which checks each channel against the user's access.
    appsync_api_key: str = ""

    # Who runs Google Drive backups. "local": a loop inside the API process (dev).
    # "external": a separate worker calls app.worker (SQS/EventBridge-triggered Lambda in AWS).
    drive_sync_runner: Literal["local", "external"] = "local"

    # Google Workspace bridge. Leave the client id/secret empty to run local-only.
    google_client_id: str = ""
    google_client_secret: str = ""
    # Optional, for "Pick from Google Drive" (Google Picker): a browser API key restricted to the
    # Picker API, and the Cloud project number. Without them, Google files import by link only.
    google_api_key: str = ""
    google_app_id: str = ""
    google_redirect_uri: str = "http://localhost:8000/api/google/callback"
    # Where the browser lands after Google sign-in / linking.
    frontend_url: str = "http://localhost:5173"
    # Fernet key used to encrypt Google refresh tokens at rest.
    token_encryption_key: str

    @property
    def google_enabled(self) -> bool:
        return bool(self.google_client_id and self.google_client_secret)

    @property
    def google_picker_enabled(self) -> bool:
        return self.google_enabled and bool(self.google_api_key and self.google_app_id)


@lru_cache
def get_settings() -> Settings:
    return Settings()
