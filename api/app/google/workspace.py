"""Mirror Chia documents into Google Drive as native Docs / Sheets / Slides.

Used for Drive backup and "export to Google". Each operation is a fixed, small number of calls:
  doc    create/update: 1 (Drive import of the editor's HTML)
  sheet  create: 1 (+1 to file into the backup folder)   update: 2
  slides create: 2 (+1 to file into the backup folder)   update: 2
"""

import json
from functools import cache
from importlib import resources
from typing import Any
from uuid import uuid4

from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build_from_document
from googleapiclient.errors import HttpError
from googleapiclient.http import MediaInMemoryUpload

from app.models import DocKind

MIME = {
    DocKind.doc: "application/vnd.google-apps.document",
    DocKind.sheet: "application/vnd.google-apps.spreadsheet",
    DocKind.slides: "application/vnd.google-apps.presentation",
}

class GoogleApiError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


@cache
def _discovery(api: str, version: str) -> dict[str, Any]:
    # Discovery documents ship inside google-api-python-client; parse each once per process.
    ref = resources.files("googleapiclient") / "discovery_cache" / "documents" / f"{api}.{version}.json"
    return json.loads(ref.read_text())


def _svc(creds: Credentials, api: str, version: str) -> Any:
    return build_from_document(_discovery(api, version), credentials=creds)


def _call(request: Any) -> Any:
    try:
        return request.execute(num_retries=2)
    except HttpError as exc:
        status = exc.resp.status
        if status in (403, 404):
            raise GoogleApiError(status, "File is missing from Google Drive or Chia lost access to it") from exc
        raise GoogleApiError(502, f"Google API error {status}: {exc.reason}") from exc


def _html(body: str) -> bytes:
    return f"<html><head><meta charset='utf-8'></head><body>{body}</body></html>".encode()


# ───────────── Common ─────────────


def rename(creds: Credentials, file_id: str, title: str) -> None:
    _call(_svc(creds, "drive", "v3").files().update(fileId=file_id, body={"name": title}, fields="id"))


def trash(creds: Credentials, file_id: str) -> None:
    _call(_svc(creds, "drive", "v3").files().update(fileId=file_id, body={"trashed": True}, fields="id"))


def create_folder(creds: Credentials, name: str) -> str:
    body = {"name": name, "mimeType": "application/vnd.google-apps.folder"}
    return _call(_svc(creds, "drive", "v3").files().create(body=body, fields="id"))["id"]


def is_live(creds: Credentials, file_id: str) -> bool:
    """False when the file was deleted, trashed, or Chia lost access to it."""
    try:
        meta = _call(_svc(creds, "drive", "v3").files().get(fileId=file_id, fields="trashed"))
    except GoogleApiError as exc:
        if exc.status in (403, 404):
            return False
        raise
    return not meta.get("trashed", False)


def move_into(creds: Credentials, file_id: str, folder_id: str) -> None:
    _call(_svc(creds, "drive", "v3").files().update(fileId=file_id, addParents=folder_id, fields="id"))


# ───────────── Docs ─────────────


def create_doc(creds: Credentials, title: str, html: str, folder_id: str | None = None) -> str:
    # Drive's HTML import keeps bold/italic/underline, font sizes, alignment and lists in one call.
    media = MediaInMemoryUpload(_html(html), mimetype="text/html", resumable=False)
    body: dict[str, Any] = {"name": title, "mimeType": MIME[DocKind.doc]}
    if folder_id:
        body["parents"] = [folder_id]
    return _call(_svc(creds, "drive", "v3").files().create(body=body, media_body=media, fields="id"))["id"]


def update_doc(creds: Credentials, file_id: str, title: str, html: str) -> None:
    media = MediaInMemoryUpload(_html(html), mimetype="text/html", resumable=False)
    _call(_svc(creds, "drive", "v3").files().update(fileId=file_id, body={"name": title}, media_body=media, fields="id"))


# ───────────── Sheets ─────────────


def _cell(value: Any, header: bool = False) -> dict[str, Any]:
    if value is None or value == "":
        cell: dict[str, Any] = {}
    elif isinstance(value, bool):
        cell = {"userEnteredValue": {"boolValue": value}}
    elif isinstance(value, int | float):
        cell = {"userEnteredValue": {"numberValue": value}}
    elif isinstance(value, str) and value.startswith("="):
        cell = {"userEnteredValue": {"formulaValue": value}}
    else:
        cell = {"userEnteredValue": {"stringValue": str(value)}}
    if header:
        cell["userEnteredFormat"] = {"textFormat": {"bold": True}}
    return cell


def create_sheet(creds: Credentials, title: str, columns: list[str], rows: list[list[Any]]) -> str:
    row_data = [{"values": [_cell(c, header=True) for c in columns]}]
    row_data += [{"values": [_cell(v) for v in row]} for row in rows]
    body = {
        "properties": {"title": title},
        "sheets": [
            {
                "properties": {"title": "Sheet1", "gridProperties": {"frozenRowCount": 1}},
                "data": [{"startRow": 0, "startColumn": 0, "rowData": row_data}],
            }
        ],
    }
    return _call(_svc(creds, "sheets", "v4").spreadsheets().create(body=body, fields="spreadsheetId"))["spreadsheetId"]


def update_sheet(creds: Credentials, file_id: str, columns: list[str], rows: list[list[Any]]) -> None:
    values = _svc(creds, "sheets", "v4").spreadsheets().values()
    _call(values.clear(spreadsheetId=file_id, range="A1:ZZZ", body={}))
    _call(
        values.update(
            spreadsheetId=file_id,
            range="A1",
            valueInputOption="USER_ENTERED",
            body={"values": [columns, *[["" if v is None else v for v in r] for r in rows]]},
        )
    )


# ───────────── Slides ─────────────


def _slide_requests(slides: list[dict[str, str]], start_index: int = 0) -> list[dict[str, Any]]:
    """createSlide + insertText (+ bullets for "- " / "* " lines) for each slide."""
    batch = uuid4().hex[:8]
    requests: list[dict[str, Any]] = []
    for i, slide in enumerate(slides):
        sid, tid, bid = f"chia_{batch}_{i}", f"chia_{batch}_{i}_t", f"chia_{batch}_{i}_b"
        requests.append(
            {
                "createSlide": {
                    "objectId": sid,
                    "insertionIndex": start_index + i,
                    "slideLayoutReference": {"predefinedLayout": "TITLE_AND_BODY"},
                    "placeholderIdMappings": [
                        {"layoutPlaceholder": {"type": "TITLE"}, "objectId": tid},
                        {"layoutPlaceholder": {"type": "BODY"}, "objectId": bid},
                    ],
                }
            }
        )
        if title := slide.get("title", "").strip():
            requests.append({"insertText": {"objectId": tid, "text": title}})

        lines, bullet_ranges, offset = [], [], 0
        for raw in slide.get("body", "").strip().splitlines():
            is_bullet = raw.lstrip().startswith(("- ", "* "))
            line = raw.lstrip()[2:] if is_bullet else raw
            if is_bullet:
                bullet_ranges.append((offset, offset + len(line)))
            lines.append(line)
            offset += len(line) + 1
        if text := "\n".join(lines):
            requests.append({"insertText": {"objectId": bid, "text": text}})
            for start, end in bullet_ranges:
                if end > start:
                    requests.append(
                        {
                            "createParagraphBullets": {
                                "objectId": bid,
                                "textRange": {"type": "FIXED_RANGE", "startIndex": start, "endIndex": end},
                                "bulletPreset": "BULLET_DISC_CIRCLE_SQUARE",
                            }
                        }
                    )
    return requests


def create_slides(creds: Credentials, title: str, slides: list[dict[str, str]]) -> str:
    presentations = _svc(creds, "slides", "v1").presentations()
    created = _call(presentations.create(body={"title": title}))
    file_id = created["presentationId"]
    requests = _slide_requests(slides or [{"title": title, "body": ""}])
    # Drop the blank title slide Google adds to every new presentation.
    requests += [{"deleteObject": {"objectId": s["objectId"]}} for s in created.get("slides", [])]
    _call(presentations.batchUpdate(presentationId=file_id, body={"requests": requests}))
    return file_id


def update_slides(creds: Credentials, file_id: str, slides: list[dict[str, str]]) -> None:
    presentations = _svc(creds, "slides", "v1").presentations()
    existing = _call(presentations.get(presentationId=file_id, fields="slides(objectId)")).get("slides", [])
    requests = _slide_requests(slides or [{"title": "", "body": ""}], start_index=len(existing))
    requests += [{"deleteObject": {"objectId": s["objectId"]}} for s in existing]
    _call(presentations.batchUpdate(presentationId=file_id, body={"requests": requests}))


# ───────────── Import ─────────────

# Native Google file type → Office format it is exported as for import.
OFFICE_EXPORT = {
    MIME[DocKind.doc]: ("application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".docx"),
    MIME[DocKind.sheet]: ("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xlsx"),
    MIME[DocKind.slides]: ("application/vnd.openxmlformats-officedocument.presentationml.presentation", ".pptx"),
}


def download(creds: Credentials, file_id: str, max_bytes: int) -> tuple[str, bytes]:
    """Fetch a Drive file for import: Google files as Office files, uploads as they are.

    With the drive.file scope this works for files the user picked in the Google Picker
    (or that Chia created); anything else comes back as GoogleApiError 403/404.
    """
    files = _svc(creds, "drive", "v3").files()
    meta = _call(files.get(fileId=file_id, fields="name,mimeType,size"))
    name, mime = meta["name"], meta["mimeType"]
    if mime in OFFICE_EXPORT:
        office_mime, ext = OFFICE_EXPORT[mime]
        return name + ext, _call(files.export(fileId=file_id, mimeType=office_mime))
    if int(meta.get("size") or 0) > max_bytes:
        raise GoogleApiError(413, "That file is larger than 25 MB")
    return name, _call(files.get_media(fileId=file_id))
