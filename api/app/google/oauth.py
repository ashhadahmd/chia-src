"""Linking a Chia user to their Google account (OAuth 2.0 web flow with PKCE)."""

import os
import re
import secrets
import threading
from datetime import UTC, timedelta
from typing import Any

import httpx
from google.auth.exceptions import RefreshError
from google.auth.transport.requests import Request as GoogleRequest
from google.oauth2 import id_token
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow
from sqlalchemy import delete
from sqlmodel import Session, col, func, select

from app.config import get_settings
from app.crypto import decrypt, encrypt
from app.models import GoogleAccount, OAuthState, User, utcnow
from app.security import hash_password
from app.workspaces import personal_workspace

# drive.file only reaches files Chia itself created or the user opened with Chia. It is a
# non-sensitive scope, so the OAuth app needs no Google security review.
SCOPES = [
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/drive.file",
]
TOKEN_URI = "https://oauth2.googleapis.com/token"
STATE_TTL = timedelta(minutes=10)

# Google may return previously granted scopes alongside ours; that is not an error.
os.environ.setdefault("OAUTHLIB_RELAX_TOKEN_SCOPE", "1")


class GoogleNotConfigured(Exception):
    pass


class GoogleReconnectRequired(Exception):
    """The stored grant was revoked or expired; the user must link Google again."""


def _client_config() -> dict[str, Any]:
    s = get_settings()
    if not s.google_enabled:
        raise GoogleNotConfigured("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set")
    return {
        "web": {
            "client_id": s.google_client_id,
            "client_secret": s.google_client_secret,
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": TOKEN_URI,
            "redirect_uris": [s.google_redirect_uri],
        }
    }


def start(session: Session, user_id: int | None) -> str:
    """Return the Google consent URL: links Drive to `user_id`, or signs in when None."""
    flow = Flow.from_client_config(_client_config(), scopes=SCOPES, redirect_uri=get_settings().google_redirect_uri)
    state = secrets.token_urlsafe(32)
    url, _ = flow.authorization_url(access_type="offline", prompt="consent", include_granted_scopes="true", state=state)
    assert flow.code_verifier is not None
    now = utcnow()
    # Abandoned consents are cleared here, a cheap indexed delete, instead of on every boot.
    session.execute(delete(OAuthState).where(col(OAuthState.expires_at) < now))
    session.add(OAuthState(state=state, user_id=user_id, code_verifier=flow.code_verifier, created_at=now, expires_at=now + STATE_TTL))
    session.commit()
    return url


def _unique_username(session: Session, email: str) -> str:
    base = re.sub(r"[^a-z0-9._-]", "", email.split("@")[0].lower()) or "user"
    name, n = base, 1
    while session.exec(select(User).where(User.username == name)).first() is not None:
        n += 1
        name = f"{base}{n}"
    return name


def finish(session: Session, code: str, state: str) -> tuple[User, bool]:
    """Complete the consent. Returns the user and whether this was a sign-in (vs. a link)."""
    pending = session.get(OAuthState, state)
    if pending is None:
        raise ValueError("Unknown or already used sign-in link")
    session.delete(pending)
    session.commit()
    if pending.expires_at.replace(tzinfo=UTC) < utcnow():
        raise ValueError("Sign-in link expired, start again")

    flow = Flow.from_client_config(
        _client_config(),
        scopes=SCOPES,
        redirect_uri=get_settings().google_redirect_uri,
        state=state,
        code_verifier=pending.code_verifier,
        autogenerate_code_verifier=False,
    )
    flow.fetch_token(code=code)
    creds = flow.credentials
    if not creds.refresh_token:
        raise ValueError("Google did not return a refresh token")
    claims = id_token.verify_oauth2_token(creds.id_token, GoogleRequest(), audience=get_settings().google_client_id)
    sub, email = claims["sub"], claims.get("email", "").lower()
    if not claims.get("email_verified", False):
        raise ValueError("Your Google email address is not verified")

    linked = session.exec(select(GoogleAccount).where(GoogleAccount.google_sub == sub)).first()
    signing_in = pending.user_id is None
    if signing_in:
        # Existing link, then matching Chia email, then a brand-new account.
        user = session.get(User, linked.user_id) if linked else None
        user = user or session.exec(select(User).where(func.lower(User.email) == email)).first()
        if user is None:
            user = User(
                email=email,
                username=_unique_username(session, email),
                # Unusable password: Google-created accounts sign in with Google only.
                hashed_password=hash_password(secrets.token_urlsafe(32)),
            )
            session.add(user)
            session.commit()
            session.refresh(user)
            assert user.id is not None
            personal_workspace(session, user.id, user.username)
    else:
        user = session.get(User, pending.user_id)
        if user is None:
            raise ValueError("Chia account no longer exists")
        if linked and linked.user_id != user.id:
            raise ValueError("That Google account is already linked to another Chia user")
    assert user.id is not None

    account = session.get(GoogleAccount, user.id) or GoogleAccount(user_id=user.id, google_sub=sub, email=email, refresh_token_enc="", scopes="")
    if account.google_sub != sub:
        account.backup_folder_id = None  # different Drive; start a fresh backup folder
    account.google_sub = sub
    account.email = email
    account.refresh_token_enc = encrypt(creds.refresh_token)
    account.scopes = " ".join(creds.granted_scopes or SCOPES)
    account.connected_at = utcnow()
    session.add(account)
    session.commit()
    _cache.pop(user.id, None)
    return user, signing_in


def disconnect(session: Session, user_id: int) -> None:
    account = session.get(GoogleAccount, user_id)
    if account is None:
        return
    try:
        httpx.post("https://oauth2.googleapis.com/revoke", data={"token": decrypt(account.refresh_token_enc)}, timeout=10)
    except httpx.HTTPError:
        pass  # local unlink still proceeds; the user can revoke at myaccount.google.com
    session.delete(account)
    session.commit()
    _cache.pop(user_id, None)


# Credentials are cached per user so access tokens are reused until they expire.
_cache: dict[int, Credentials] = {}
_lock = threading.Lock()


def credentials_for(session: Session, user_id: int) -> Credentials | None:
    with _lock:
        if user_id in _cache:
            return _cache[user_id]
    account = session.get(GoogleAccount, user_id)
    if account is None:
        return None
    s = get_settings()
    creds = Credentials(
        token=None,
        refresh_token=decrypt(account.refresh_token_enc),
        token_uri=TOKEN_URI,
        client_id=s.google_client_id,
        client_secret=s.google_client_secret,
        scopes=account.scopes.split(),
    )
    try:
        creds.refresh(GoogleRequest())
    except RefreshError as exc:
        raise GoogleReconnectRequired("Google access was revoked or expired; reconnect Google") from exc
    with _lock:
        _cache[user_id] = creds
    return creds


def access_token(session: Session, user_id: int) -> str | None:
    """A current access token for browser-side Google APIs (the Drive Picker)."""
    creds = credentials_for(session, user_id)
    if creds is None:
        return None
    if not creds.valid:
        try:
            creds.refresh(GoogleRequest())
        except RefreshError as exc:
            raise GoogleReconnectRequired("Google access was revoked or expired; reconnect Google") from exc
    return creds.token


def has_google(session: Session, user_id: int) -> bool:
    return session.get(GoogleAccount, user_id) is not None
