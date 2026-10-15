from urllib.parse import urlencode

from fastapi import APIRouter, HTTPException, status
from fastapi.responses import RedirectResponse
from pydantic import BaseModel

from app.config import get_settings
from app.db import SessionDep
from app.deps import CurrentUser
from app.google import backup, oauth
from app.models import GoogleAccount
from app.security import create_access_token

router = APIRouter(tags=["google"])


class GoogleStatus(BaseModel):
    configured: bool
    connected: bool
    email: str | None = None
    picker: bool = False  # "Pick from Google Drive" is available


class PickerConfig(BaseModel):
    access_token: str
    api_key: str
    app_id: str


class ConnectLink(BaseModel):
    auth_url: str


class Providers(BaseModel):
    google: bool


@router.get("/auth/providers")
def providers() -> Providers:
    """Public: which sign-in methods the login screen should offer."""
    return Providers(google=get_settings().google_enabled)


@router.get("/auth/google", include_in_schema=False)
def google_sign_in(session: SessionDep) -> RedirectResponse:
    """Browser entry point for "Continue with Google"."""
    try:
        return RedirectResponse(oauth.start(session, None), status_code=status.HTTP_303_SEE_OTHER)
    except oauth.GoogleNotConfigured:
        return _to_frontend("/auth/google", fragment={"error": "Google sign-in is not configured on this server"})


@router.get("/google")
def google_status(session: SessionDep, user: CurrentUser) -> GoogleStatus:
    account = session.get(GoogleAccount, user.id)
    s = get_settings()
    return GoogleStatus(
        configured=s.google_enabled,
        connected=account is not None,
        email=account.email if account else None,
        picker=account is not None and s.google_picker_enabled,
    )


@router.get("/google/picker")
def picker_config(session: SessionDep, user: CurrentUser) -> PickerConfig:
    """Short-lived token + keys for the Google Picker. Picked files become readable by Chia."""
    assert user.id is not None
    s = get_settings()
    if not s.google_picker_enabled:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Google Drive picking is not configured on this server")
    try:
        token = oauth.access_token(session, user.id)
    except oauth.GoogleReconnectRequired as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    if token is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Connect Google first")
    return PickerConfig(access_token=token, api_key=s.google_api_key, app_id=s.google_app_id)


@router.post("/google/connect")
def connect(session: SessionDep, user: CurrentUser) -> ConnectLink:
    """Consent URL for linking Drive backup to the signed-in user."""
    assert user.id is not None
    try:
        return ConnectLink(auth_url=oauth.start(session, user.id))
    except oauth.GoogleNotConfigured as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc)) from exc


def _to_frontend(path: str, *, query: dict[str, str] | None = None, fragment: dict[str, str] | None = None) -> RedirectResponse:
    url = get_settings().frontend_url.rstrip("/") + path
    if query:
        url += "?" + urlencode(query)
    if fragment:
        # Fragments never reach servers or logs, so the session token travels there.
        url += "#" + urlencode(fragment)
    return RedirectResponse(url, status_code=status.HTTP_303_SEE_OTHER)


@router.get("/google/callback", include_in_schema=False)
def callback(session: SessionDep, state: str = "", code: str = "", error: str = "") -> RedirectResponse:
    pending_login = True
    try:
        if error:
            raise ValueError("Google sign-in was cancelled" if error == "access_denied" else f"Google returned: {error}")
        user, pending_login = oauth.finish(session, code, state)
    except (ValueError, oauth.GoogleNotConfigured) as exc:
        return _to_frontend("/auth/google", fragment={"error": str(exc)})
    except Exception:  # noqa: BLE001  (a browser redirect must land somewhere readable)
        return _to_frontend("/auth/google", fragment={"error": "Could not complete Google sign-in, try again"})

    assert user.id is not None
    backup.queue_user(session, user.id)
    if pending_login:
        return _to_frontend("/auth/google", fragment={"token": create_access_token(user.id)})
    return _to_frontend("/", query={"google": "connected"})


@router.delete("/google", status_code=status.HTTP_204_NO_CONTENT)
def disconnect(session: SessionDep, user: CurrentUser) -> None:
    """Stops Drive backup and revokes Chia's grant. Existing backups stay in Drive."""
    assert user.id is not None
    oauth.disconnect(session, user.id)
