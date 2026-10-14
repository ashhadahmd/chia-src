from functools import lru_cache

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
    cors_origins: list[str] = ["http://localhost:5173"]

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
