"""Google Drive backup: every document is mirrored as a native Google file in a "Chia" folder.

State lives in the database, not in the process, so any number of API instances or Lambda
workers can share the work:

- A save marks the doc `pending` and stamps `drive_sync_requested_at` (`mark_changed`).
- `run_due()` syncs docs whose last change is DEBOUNCE old, so a burst of autosaves makes one
  Drive write. Each doc is claimed with a conditional UPDATE (`pending` -> `syncing`), so two
  runners never sync the same doc; a claim older than CLAIM_TTL counts as abandoned.
- A change that lands mid-sync flips the doc back to `pending`, and the finished sync leaves it
  that way, so the newer content goes out on the next pass.

Who calls `run_due()`: locally, a small loop in the API process (DRIVE_SYNC_RUNNER=local); in
AWS, an EventBridge schedule or SQS-triggered Lambda (`app.worker.handler`).
"""

import logging
import time
from datetime import timedelta

from sqlalchemy import case, update
from sqlmodel import Session, and_, col, or_, select

from app import assets
from app.db import engine
from app.export import resolve_colors
from app.google import oauth, workspace
from app.models import DocKind, Document, DriveSyncStatus, GoogleAccount, utcnow

log = logging.getLogger("chia.backup")

DEBOUNCE = timedelta(seconds=4)
CLAIM_TTL = timedelta(minutes=5)
FOLDER_NAME = "Chia"

S = DriveSyncStatus


def mark_changed(session: Session, doc: Document) -> None:
    """Queue a Drive sync for a changed doc, inside the caller's transaction."""
    if oauth.has_google(session, doc.owner_id):
        doc.drive_sync_status = S.pending
        doc.drive_sync_requested_at = utcnow()


def queue_user(session: Session, user_id: int) -> None:
    """Back up everything a user created (after they link Google)."""
    session.execute(
        update(Document)
        .where(col(Document.owner_id) == user_id)
        .values(drive_sync_status=S.pending, drive_sync_requested_at=utcnow())
    )
    session.commit()


def _folder(session: Session, creds, account: GoogleAccount) -> str:
    if account.backup_folder_id and workspace.is_live(creds, account.backup_folder_id):
        return account.backup_folder_id
    account.backup_folder_id = workspace.create_folder(creds, FOLDER_NAME)
    session.add(account)
    session.commit()
    return account.backup_folder_id


def _claim(session: Session, doc_id: str, *, force: bool = False) -> bool:
    """Take a doc for syncing. Without `force`, only a settled `pending` doc (or an abandoned
    claim) qualifies; with it, anything not being synced right now."""
    now = utcnow()
    settled = and_(col(Document.drive_sync_status) == S.pending, col(Document.drive_sync_requested_at) <= now - DEBOUNCE)
    abandoned = and_(col(Document.drive_sync_status) == S.syncing, col(Document.drive_sync_claimed_at) < now - CLAIM_TTL)
    claimable = or_(col(Document.drive_sync_status) != S.syncing, abandoned) if force else or_(settled, abandoned)
    result = session.execute(
        update(Document)
        .where(col(Document.id) == doc_id, claimable)
        .values(drive_sync_status=S.syncing, drive_sync_claimed_at=now)
    )
    session.commit()
    return result.rowcount == 1


def _finish(session: Session, doc_id: str, outcome: DriveSyncStatus) -> None:
    """Record the outcome, unless a newer change re-queued the doc mid-sync (it stays pending)."""
    session.execute(
        update(Document)
        .where(col(Document.id) == doc_id)
        .values(
            drive_sync_status=case((col(Document.drive_sync_status) == S.syncing, outcome), else_=col(Document.drive_sync_status)),
            drive_sync_claimed_at=None,
        )
    )
    session.commit()


def _sync(session: Session, doc_id: str) -> None:
    """Mirror one claimed document to Drive."""
    doc = session.get(Document, doc_id)
    account = session.get(GoogleAccount, doc.owner_id) if doc else None
    if doc is None:
        return
    if account is None:  # Google was unlinked; nothing to mirror
        _finish(session, doc_id, S.clean)
        return
    outcome = S.clean
    try:
        creds = oauth.credentials_for(session, doc.owner_id)
        assert creds is not None
        folder = _folder(session, creds, account)
        content = doc.content or {}
        file_id = doc.google_file_id if doc.google_file_id and workspace.is_live(creds, doc.google_file_id) else None

        if doc.kind is DocKind.doc:
            html = resolve_colors(content.get("html", ""))
            html = assets.inline(html, assets.resolver(session, html))
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
        outcome = S.failed
    session.add(doc)
    session.commit()
    _finish(session, doc_id, outcome)


def run_due(limit: int = 25) -> int:
    """Sync docs whose changes have settled. Returns how many were synced. Safe to call from any
    number of processes at once."""
    now = utcnow()
    with Session(engine) as session:
        ids = session.exec(
            select(Document.id)
            .where(
                or_(
                    and_(col(Document.drive_sync_status) == S.pending, col(Document.drive_sync_requested_at) <= now - DEBOUNCE),
                    and_(col(Document.drive_sync_status) == S.syncing, col(Document.drive_sync_claimed_at) < now - CLAIM_TTL),
                )
            )
            .order_by(col(Document.drive_sync_requested_at))
            .limit(limit)
        ).all()
        done = 0
        for doc_id in ids:
            if _claim(session, doc_id):
                try:
                    _sync(session, doc_id)
                except Exception:
                    log.exception("Backup of %s failed", doc_id)
                    session.rollback()
                    _finish(session, doc_id, S.failed)
                done += 1
        return done


def backup_now(doc_id: str, wait: float = 30.0) -> Document | None:
    """Mirror one document to Drive now (Export to Google). If another runner is syncing it,
    wait for that to finish. Returns the doc, or None if it is gone."""
    deadline = time.monotonic() + wait
    with Session(engine) as session:
        while not _claim(session, doc_id, force=True):
            if session.get(Document, doc_id) is None or time.monotonic() > deadline:
                break
            time.sleep(0.5)
            session.expire_all()
        else:
            _sync(session, doc_id)
        session.expire_all()
        return session.get(Document, doc_id)


def trash_mirror(owner_id: int, file_id: str) -> None:
    """Send a deleted doc's Drive copy to the Drive trash. Run after the response
    (FastAPI BackgroundTasks), which a Lambda also completes before returning."""
    with Session(engine) as session:
        try:
            creds = oauth.credentials_for(session, owner_id)
            if creds:
                workspace.trash(creds, file_id)
        except (workspace.GoogleApiError, oauth.GoogleReconnectRequired):
            pass
