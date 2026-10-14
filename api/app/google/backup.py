"""Google Drive backup: every document is mirrored as a native Google file in a "Chia" folder.

Edits are debounced so a burst of autosaves produces one Drive write. Pending backups are
re-queued at startup from `backed_up_at < updated_at`, so a restart loses nothing.
"""

import logging
import threading

from sqlmodel import Session, col, or_, select

from app.db import engine
from app import assets
from app.export import resolve_colors
from app.google import oauth, workspace
from app.models import DocKind, Document, GoogleAccount, utcnow

log = logging.getLogger("chia.backup")

DEBOUNCE_SECONDS = 4.0
FOLDER_NAME = "Chia"

_timers: dict[str, threading.Timer] = {}
_doc_locks: dict[str, threading.Lock] = {}
_guard = threading.Lock()


def schedule(doc_id: str, delay: float = DEBOUNCE_SECONDS) -> None:
    with _guard:
        if timer := _timers.pop(doc_id, None):
            timer.cancel()
        timer = threading.Timer(delay, _run, args=(doc_id,))
        timer.daemon = True
        _timers[doc_id] = timer
        timer.start()


def _run(doc_id: str) -> None:
    with _guard:
        _timers.pop(doc_id, None)
    try:
        backup_now(doc_id)
    except Exception:
        log.exception("Backup of %s failed", doc_id)


def _folder(session: Session, creds, account: GoogleAccount) -> str:
    if account.backup_folder_id and workspace.is_live(creds, account.backup_folder_id):
        return account.backup_folder_id
    account.backup_folder_id = workspace.create_folder(creds, FOLDER_NAME)
    session.add(account)
    session.commit()
    return account.backup_folder_id


def backup_now(doc_id: str) -> Document | None:
    """Mirror one document to Drive now. Returns it, or None if it is gone or Google is unlinked."""
    with _guard:
        lock = _doc_locks.setdefault(doc_id, threading.Lock())
    with lock, Session(engine) as session:
        doc = session.get(Document, doc_id)
        account = session.get(GoogleAccount, doc.owner_id) if doc else None
        if doc is None or account is None:
            return None
        try:
            creds = oauth.credentials_for(session, doc.owner_id)
            assert creds is not None
            folder = _folder(session, creds, account)
            content = doc.content or {}
            file_id = doc.google_file_id if doc.google_file_id and workspace.is_live(creds, doc.google_file_id) else None

            if doc.kind is DocKind.doc:
                html = resolve_colors(content.get("html", ""))
                html = assets.inline(html, assets.resolver(session, doc.owner_id, html))
                if file_id:
                    workspace.update_doc(creds, file_id, doc.title, html)
                else:
                    file_id = workspace.create_doc(creds, doc.title, html, folder)
            elif doc.kind is DocKind.sheet:
                if file_id:
                    workspace.rename(creds, file_id, doc.title)
                    workspace.update_sheet(creds, file_id, content["columns"], content["rows"])
                else:
                    file_id = workspace.create_sheet(creds, doc.title, content["columns"], content["rows"])
                    workspace.move_into(creds, file_id, folder)
            else:
                if file_id:
                    workspace.rename(creds, file_id, doc.title)
                    workspace.update_slides(creds, file_id, content["slides"])
                else:
                    file_id = workspace.create_slides(creds, doc.title, content["slides"])
                    workspace.move_into(creds, file_id, folder)

            doc.google_file_id = file_id
            doc.backed_up_at = utcnow()
            doc.backup_error = None
        except (workspace.GoogleApiError, oauth.GoogleReconnectRequired) as exc:
            doc.backup_error = str(exc)
        session.add(doc)
        session.commit()
        session.refresh(doc)
        return doc


def trash_mirror(owner_id: int, file_id: str) -> None:
    def run() -> None:
        with Session(engine) as session:
            try:
                creds = oauth.credentials_for(session, owner_id)
                if creds:
                    workspace.trash(creds, file_id)
            except (workspace.GoogleApiError, oauth.GoogleReconnectRequired):
                pass

    threading.Thread(target=run, daemon=True).start()


def queue_user(user_id: int) -> None:
    """Back up everything a user owns (after they link Google)."""
    with Session(engine) as session:
        ids = session.exec(select(Document.id).where(Document.owner_id == user_id)).all()
    for i, doc_id in enumerate(ids):
        schedule(doc_id, delay=1 + i * 0.5)


def resume_pending() -> None:
    with Session(engine) as session:
        ids = session.exec(
            select(Document.id)
            .join(GoogleAccount, col(GoogleAccount.user_id) == Document.owner_id)
            .where(or_(col(Document.backed_up_at).is_(None), col(Document.backed_up_at) < col(Document.updated_at)))
        ).all()
    for i, doc_id in enumerate(ids):
        schedule(doc_id, delay=2 + i * 0.5)
