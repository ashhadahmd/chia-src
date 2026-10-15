"""End-to-end checks through the HTTP API, the MCP endpoint and the WebSocket.

Phase 1: workspaces, roles, sharing, scoped agent keys, blob storage, SQL search.
Phase 2: three-way merges of concurrent human + agent edits (no 409), surgical MCP tools,
realtime events, conditional (ETag) reconciles.
Phase 3: sheet row ids, offloaded large bodies, public links, lazy heavy imports, the Lambda
entry points, the AppSync Events sink and authorizer, and the browser's formula evaluator.
"""

import gzip
import io
import json
import os
import queue
import shutil
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any

import pytest
from fastapi import WebSocketDisconnect
from PIL import Image
from sqlmodel import Session, select

from app import export, realtime
from app.config import get_settings
from app.db import engine
from app.models import ApiKey, Asset, AssetReference, Document, DocumentSnapshot, User
from app.routes.realtime import authorize_appsync
from app.security import create_access_token, hash_password
from app.storage import get_storage


class ToolFailed(Exception):
    pass


def _user(username: str) -> int:
    with Session(engine) as s:
        user = s.exec(select(User).where(User.username == username)).first()
        if user is None:
            user = User(email=f"{username}@test.chia", username=username, hashed_password=hash_password("x"))
            s.add(user)
            s.commit()
            s.refresh(user)
        assert user.id is not None
        return user.id


@pytest.fixture(scope="module")
def ids(client) -> dict[str, int]:
    return {"root": _user("root"), "bob": _user("bob"), "carol": _user("carol")}


@pytest.fixture(scope="module")
def auth(ids) -> dict[str, dict[str, str]]:
    return {name: {"Authorization": f"Bearer {create_access_token(uid)}"} for name, uid in ids.items()}


@pytest.fixture(scope="module")
def agent_key(client, auth) -> str:
    return client.post("/api/keys", headers=auth["root"], json={"name": "Claude Code"}).json()["key"]


def tool(client, key: str, name: str, args: dict[str, Any], workspace: str | None = None) -> Any:
    headers = {"Authorization": f"Bearer {key}", "Accept": "application/json, text/event-stream"}
    if workspace:
        headers["X-Workspace-Id"] = workspace
    r = client.post("/mcp", headers=headers, json={"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": args}})
    if r.status_code != 200:
        raise ToolFailed(f"HTTP {r.status_code}: {r.text}")
    result = r.json()["result"]
    if result.get("isError"):
        raise ToolFailed(result["content"][0]["text"])
    data = result["structuredContent"]
    return data["result"] if set(data) == {"result"} else data


def png() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (4, 4), (200, 10, 10)).save(buf, "PNG")
    return buf.getvalue()


def new_doc(client, headers, kind: str, content: dict | None = None, title: str = "Test") -> dict:
    body: dict[str, Any] = {"kind": kind, "title": title}
    if content is not None:
        body["content"] = content
    r = client.post("/api/documents", headers=headers, json=body)
    assert r.status_code == 201, r.text
    return r.json()


# ───────────── Phase 1: workspaces, roles, sharing ─────────────


def test_solo_user_lands_in_personal_workspace(client, auth):
    ws = client.get("/api/workspaces", headers=auth["root"]).json()
    assert ws[0]["kind"] == "personal" and ws[0]["role"] == "owner"
    doc = new_doc(client, auth["root"], "doc")
    assert doc["workspace_id"] == ws[0]["id"]


def test_assets_live_in_storage_and_are_released_on_delete(client, auth):
    up = client.post("/api/assets", headers=auth["root"], files={"file": ("a.png", png(), "image/png")}).json()
    r = client.get(up["url"])
    assert r.status_code == 200 and r.content[:4] == b"\x89PNG"
    doc = new_doc(client, auth["root"], "doc", {"html": f'<p>pic</p><img src="{up["url"]}">', "page": "a4"})
    with Session(engine) as s:
        assert s.exec(select(AssetReference).where(AssetReference.document_id == doc["id"])).all()
        key = s.get(Asset, up["id"]).storage_key
    r = client.get(f"/api/documents/{doc['id']}/export/docx", headers=auth["root"])
    assert r.status_code == 200 and len(r.content) > 1000
    assert client.delete(f"/api/documents/{doc['id']}", headers=auth["root"]).status_code == 204
    with Session(engine) as s:
        assert s.get(Asset, up["id"]) is None
    assert get_storage().get(key) is None


def test_mcp_search_uses_sql(client, auth, agent_key):
    doc = new_doc(client, auth["root"], "doc", {"html": "<p>zebracorn apples</p>", "page": "a4"})
    hits = tool(client, agent_key, "search_documents", {"query": "zebra"})
    assert any(h["id"] == doc["id"] for h in hits)
    with Session(engine) as s:
        assert "zebracorn" in s.get(Document, doc["id"]).search_text


def test_team_roles(client, auth):
    team = client.post("/api/workspaces", headers=auth["root"], json={"name": "Acme"}).json()
    team_headers = {**auth["root"], "X-Workspace-Id": team["id"]}
    sheet = new_doc(client, team_headers, "sheet")
    assert sheet["workspace_id"] == team["id"]
    assert all(d["id"] != sheet["id"] for d in client.get("/api/documents", headers=auth["root"]).json())
    assert client.get("/api/documents", headers={**auth["bob"], "X-Workspace-Id": team["id"]}).status_code == 403
    assert client.get(f"/api/documents/{sheet['id']}", headers=auth["bob"]).status_code == 404
    client.put(f"/api/workspaces/{team['id']}/members", headers=auth["root"], json={"user": "bob", "role": "viewer"})
    r = client.get(f"/api/documents/{sheet['id']}", headers=auth["bob"])
    assert r.status_code == 200 and r.json()["role"] == "viewer"
    assert client.patch(f"/api/documents/{sheet['id']}", headers=auth["bob"], json={"title": "x"}).status_code == 403
    client.put(f"/api/workspaces/{team['id']}/members", headers=auth["root"], json={"user": "bob", "role": "editor"})
    assert client.patch(f"/api/documents/{sheet['id']}", headers=auth["bob"], json={"title": "Bob's"}).status_code == 200
    assert client.delete(f"/api/documents/{sheet['id']}", headers=auth["bob"]).status_code == 403
    members = client.get(f"/api/workspaces/{team['id']}/members", headers=auth["bob"]).json()
    assert {m["username"]: m["role"] for m in members} == {"root": "owner", "bob": "editor"}


def test_direct_share(client, auth):
    doc = new_doc(client, auth["root"], "doc")
    assert client.get(f"/api/documents/{doc['id']}", headers=auth["carol"]).status_code == 404
    r = client.post(f"/api/documents/{doc['id']}/shares", headers=auth["root"], json={"principal": "carol@test.chia", "role": "viewer"})
    assert r.status_code == 201 and r.json()["label"] == "carol"
    assert client.get(f"/api/documents/{doc['id']}", headers=auth["carol"]).status_code == 200
    listed = client.get("/api/documents?include_shared=true", headers=auth["carol"]).json()
    assert any(d["id"] == doc["id"] for d in listed)
    assert client.patch(f"/api/documents/{doc['id']}", headers=auth["carol"], json={"title": "no"}).status_code == 403


def test_scoped_agent_keys(client, auth):
    team = client.post("/api/workspaces", headers=auth["root"], json={"name": "Bots"}).json()
    team_doc = new_doc(client, {**auth["root"], "X-Workspace-Id": team["id"]}, "doc")
    personal_doc = new_doc(client, auth["root"], "doc")
    key = client.post("/api/keys", headers=auth["root"], json={"name": "Team bot", "workspace_id": team["id"], "role": "viewer"}).json()
    assert key["workspace_id"] == team["id"] and key["role"] == "viewer"
    listing = tool(client, key["key"], "list_documents", {})
    assert [d["id"] for d in listing] == [team_doc["id"]]
    with pytest.raises(ToolFailed):
        tool(client, key["key"], "get_document", {"document_id": personal_doc["id"]})
    with pytest.raises(ToolFailed):
        tool(client, key["key"], "create_doc", {"title": "nope", "markdown": "x"})
    with pytest.raises(ToolFailed, match="403"):
        tool(client, key["key"], "list_documents", {}, workspace=personal_doc["workspace_id"])


def test_last_used_is_written_at_most_hourly(client, auth, agent_key):
    tool(client, agent_key, "list_documents", {})
    with Session(engine) as s:
        before = s.exec(select(ApiKey).where(ApiKey.name == "Claude Code")).first().last_used_at
    tool(client, agent_key, "list_documents", {})
    with Session(engine) as s:
        assert s.exec(select(ApiKey).where(ApiKey.name == "Claude Code")).first().last_used_at == before


# ───────────── Phase 2: concurrent human + agent edits merge, never 409 ─────────────


def test_doc_concurrent_edits_merge(client, auth, agent_key):
    doc = new_doc(client, auth["root"], "doc", {"html": "<h2>Plan</h2><p>first</p><p>second</p>", "page": "a4"})
    opened = client.get(f"/api/documents/{doc['id']}", headers=auth["root"]).json()
    tool(client, agent_key, "patch_doc", {"document_id": doc["id"], "markdown": "Added by the agent.", "mode": "append"})
    # The human saves an edit built on the revision they opened, after the agent's write.
    r = client.patch(
        f"/api/documents/{doc['id']}",
        headers=auth["root"],
        json={"content": {"html": "<h2>Plan</h2><p>first, edited by me</p><p>second</p>", "page": "a4"}, "base_revision": opened["revision"]},
    )
    assert r.status_code == 200, r.text
    saved = r.json()
    assert saved["merged"] is True and saved["conflicts"] == []
    assert saved["content"]["html"] == "<h2>Plan</h2><p>first, edited by me</p><p>second</p><p>Added by the agent.</p>"
    assert saved["revision"] == opened["revision"] + 2


def test_doc_same_paragraph_keeps_both(client, auth, agent_key):
    doc = new_doc(client, auth["root"], "doc", {"html": "<p>shared line</p><p>tail</p>", "page": "a4"})
    tool(client, agent_key, "update_document", {"document_id": doc["id"], "content": {"html": "<p>agent's line</p><p>tail</p>", "page": "a4"}})
    saved = client.patch(
        f"/api/documents/{doc['id']}",
        headers=auth["root"],
        json={"content": {"html": "<p>my line</p><p>tail</p>", "page": "a4"}, "base_revision": doc["revision"]},
    ).json()
    assert saved["merged"] and saved["conflicts"]
    assert saved["content"]["html"] == "<p>my line</p><p>agent's line</p><p>tail</p>"


def test_sheet_concurrent_cells_merge(client, auth, agent_key):
    sheet = new_doc(client, auth["root"], "sheet", {"columns": ["Item", "Qty", "Price"], "rows": [["Apples", 4, 1.0], ["Milk", 2, 0.9]]})
    tool(
        client,
        agent_key,
        "update_sheet_cells",
        {"document_id": sheet["id"], "cells": [{"row": 1, "column": "Price", "value": 1.25}, {"row": 2, "column": "C", "value": 0.95}], "append_rows": [["Bread", 1, 2.5]]},
    )
    saved = client.patch(
        f"/api/documents/{sheet['id']}",
        headers=auth["root"],
        json={"content": {"columns": ["Item", "Qty", "Price"], "rows": [["Green apples", 4, 1.0], ["Milk", 3, 0.9], ["Eggs", 12, None]]}, "base_revision": sheet["revision"]},
    ).json()
    assert saved["merged"] and saved["conflicts"] == []
    assert saved["content"]["rows"] == [["Green apples", 4, 1.25], ["Milk", 3, 0.95], ["Eggs", 12, None], ["Bread", 1, 2.5]]


def test_slides_concurrent_edits_merge(client, auth, agent_key):
    deck = new_doc(client, auth["root"], "slides", {"slides": [{"title": "Intro", "body": "hello"}, {"title": "Plan", "body": "- one"}]})
    ids = [s["id"] for s in deck["content"]["slides"]]
    assert all(ids) and len(set(ids)) == 2
    tool(client, agent_key, "update_slide", {"document_id": deck["id"], "action": "update", "slide_id": ids[1], "body": "- one\n- two"})
    added = tool(client, agent_key, "update_slide", {"document_id": deck["id"], "action": "add", "title": "Next steps", "position": 2})
    assert added["slide_number"] == 2 and added["slide_count"] == 3
    saved = client.patch(
        f"/api/documents/{deck['id']}",
        headers=auth["root"],
        json={"content": {"slides": [{"id": ids[0], "title": "Welcome", "body": "hello"}, {"id": ids[1], "title": "Plan", "body": "- one"}]}, "base_revision": deck["revision"]},
    ).json()
    assert saved["merged"] and saved["conflicts"] == []
    slides = saved["content"]["slides"]
    assert [(s["title"], s["body"]) for s in slides] == [("Welcome", "hello"), ("Next steps", ""), ("Plan", "- one\n- two")]
    assert slides[1]["id"] == added["slide_id"]


def test_save_older_than_snapshots_still_keeps_both_sides(client, auth, agent_key):
    doc = new_doc(client, auth["root"], "doc", {"html": "<p>start</p>", "page": "a4"})
    for i in range(12):
        tool(client, agent_key, "patch_doc", {"document_id": doc["id"], "markdown": f"agent {i}"})
    with Session(engine) as s:
        assert s.get(DocumentSnapshot, (doc["id"], doc["revision"])) is None  # pruned
    saved = client.patch(
        f"/api/documents/{doc['id']}",
        headers=auth["root"],
        json={"content": {"html": "<p>start</p><p>mine</p>", "page": "a4"}, "base_revision": doc["revision"]},
    ).json()
    html = saved["content"]["html"]
    assert saved["merged"] and "<p>mine</p>" in html and all(f"agent {i}" in html for i in range(12))


# ───────────── Phase 2: surgical MCP tools ─────────────


def test_patch_doc_modes(client, auth, agent_key):
    doc = new_doc(client, auth["root"], "doc", {"html": '<h1>Report</h1><p style="text-align:center">kept styling</p><h2>Risks</h2><p>old risk</p><h3>Detail</h3><p>old detail</p><h2>Next</h2><p>next</p>', "page": "a4"})
    tool(client, agent_key, "patch_doc", {"document_id": doc["id"], "markdown": "Summary first.", "mode": "prepend"})
    tool(client, agent_key, "patch_doc", {"document_id": doc["id"], "markdown": "- new risk", "mode": "replace_section", "heading": "## risks"})
    html = client.get(f"/api/documents/{doc['id']}", headers=auth["root"]).json()["content"]["html"]
    assert html.startswith("<p>Summary first.</p>")
    assert '<p style="text-align:center">kept styling</p>' in html
    assert "<h2>Risks</h2><ul>" in html and "new risk" in html
    assert "old risk" not in html and "old detail" not in html and "<h2>Next</h2><p>next</p>" in html
    with pytest.raises(ToolFailed, match="Headings"):
        tool(client, agent_key, "patch_doc", {"document_id": doc["id"], "markdown": "x", "mode": "replace_section", "heading": "Nope"})


def test_update_sheet_cells(client, auth, agent_key):
    sheet = new_doc(client, auth["root"], "sheet", {"columns": ["A", "B"], "rows": [[1, 2]]})
    tool(client, agent_key, "update_sheet_cells", {"document_id": sheet["id"], "cells": [{"row": 3, "column": 2, "value": "=A1*2"}]})
    rows = client.get(f"/api/documents/{sheet['id']}", headers=auth["root"]).json()["content"]["rows"]
    assert rows == [[1, 2], [None, None], [None, "=A1*2"]]
    with pytest.raises(ToolFailed, match="Columns"):
        tool(client, agent_key, "update_sheet_cells", {"document_id": sheet["id"], "cells": [{"row": 1, "column": "Missing", "value": 1}]})


def test_update_slide_move(client, auth, agent_key):
    deck = new_doc(client, auth["root"], "slides", {"slides": [{"title": "1"}, {"title": "2"}, {"title": "3"}]})
    moved = tool(client, agent_key, "update_slide", {"document_id": deck["id"], "action": "move", "number": 3, "position": 1})
    titles = [s["title"] for s in client.get(f"/api/documents/{deck['id']}", headers=auth["root"]).json()["content"]["slides"]]
    assert titles == ["3", "1", "2"] and moved["slide_number"] == 1


def test_mcp_workspace_parameter(client, auth, agent_key):
    team = client.post("/api/workspaces", headers=auth["root"], json={"name": "Writers"}).json()
    made = tool(client, agent_key, "create_doc", {"title": "Team note", "markdown": "hi", "workspace_id": team["id"]})
    assert made["workspace_id"] == team["id"]
    assert [d["id"] for d in tool(client, agent_key, "list_documents", {"workspace_id": team["id"]})] == [made["id"]]
    assert any(w["id"] == team["id"] for w in tool(client, agent_key, "list_workspaces", {}))


# ───────────── Phase 2: realtime and conditional reconciles ─────────────


class Socket:
    """A WebSocket read on a thread, so a missing event fails the test instead of hanging it."""

    def __init__(self, ws) -> None:
        self.ws = ws
        self.inbox: queue.Queue = queue.Queue()
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self) -> None:
        try:
            while True:
                self.inbox.put(self.ws.receive_json())
        except Exception as exc:  # noqa: BLE001  (socket closed: hand the reason to the test)
            self.inbox.put(exc)

    def next(self, timeout: float = 5) -> Any:
        item = self.inbox.get(timeout=timeout)
        if isinstance(item, Exception):
            raise item
        return item

    def until(self, kind: str, timeout: float = 5) -> dict:
        while True:
            event = self.next(timeout)
            if event.get("type") == kind:
                return event


def test_websocket_delivers_mcp_writes(client, auth, ids, agent_key):
    personal = client.get("/api/workspaces", headers=auth["root"]).json()[0]["id"]
    token = auth["root"]["Authorization"].removeprefix("Bearer ")
    with client.websocket_connect("/api/ws") as raw:
        ws = Socket(raw)
        raw.send_json({"type": "hello", "token": token})
        assert ws.next() == {"type": "ready", "workspace_id": personal, "doc_id": None}
        made = tool(client, agent_key, "create_doc", {"title": "Live", "markdown": "one"})
        created = ws.until("doc.created")
        assert created["doc_id"] == made["id"] and created["doc"]["title"] == "Live" and created["edited_by"] == "Claude Code"
        tool(client, agent_key, "patch_doc", {"document_id": made["id"], "markdown": "two"})
        updated = ws.until("doc.updated")
        assert updated["doc_id"] == made["id"] and updated["revision"] == created["revision"] + 1
        raw.send_json({"type": "ping"})
        assert ws.until("pong")


def test_websocket_scoping(client, auth, ids, agent_key):
    """Carol sees changes to the one doc shared with her, not the rest of root's workspace."""
    shared = new_doc(client, auth["root"], "doc")
    client.post(f"/api/documents/{shared['id']}/shares", headers=auth["root"], json={"principal": "carol", "role": "viewer"})
    private = new_doc(client, auth["root"], "doc")
    token = auth["carol"]["Authorization"].removeprefix("Bearer ")
    with client.websocket_connect("/api/ws") as raw:
        ws = Socket(raw)
        raw.send_json({"type": "hello", "token": token, "doc_id": shared["id"]})
        assert ws.next()["type"] == "ready"
        tool(client, agent_key, "patch_doc", {"document_id": private["id"], "markdown": "secret"})
        tool(client, agent_key, "patch_doc", {"document_id": shared["id"], "markdown": "public"})
        assert ws.until("doc.updated")["doc_id"] == shared["id"]
        raw.send_json({"type": "subscribe", "doc_id": private["id"]})
        with pytest.raises(WebSocketDisconnect) as refused:
            ws.until("ready")
        assert refused.value.code == 4403


def test_websocket_rejects_bad_token(client):
    with client.websocket_connect("/api/ws") as raw:
        ws = Socket(raw)
        raw.send_json({"type": "hello", "token": "nope"})
        with pytest.raises(WebSocketDisconnect) as refused:
            ws.next()
        assert refused.value.code == 4401


def test_conditional_reconcile(client, auth, agent_key):
    doc = new_doc(client, auth["root"], "doc")
    r = client.get(f"/api/documents/{doc['id']}", headers=auth["root"])
    etag = r.headers["etag"]
    assert client.get(f"/api/documents/{doc['id']}", headers={**auth["root"], "If-None-Match": etag}).status_code == 304
    listing = client.get("/api/documents", headers=auth["root"])
    list_etag = listing.headers["etag"]
    assert client.get("/api/documents", headers={**auth["root"], "If-None-Match": list_etag}).status_code == 304
    tool(client, agent_key, "patch_doc", {"document_id": doc["id"], "markdown": "changed"})
    assert client.get(f"/api/documents/{doc['id']}", headers={**auth["root"], "If-None-Match": etag}).status_code == 200
    assert client.get("/api/documents", headers={**auth["root"], "If-None-Match": list_etag}).status_code == 200


def test_delete_is_announced(client, auth):
    doc = new_doc(client, auth["root"], "sheet")
    token = auth["root"]["Authorization"].removeprefix("Bearer ")
    with client.websocket_connect("/api/ws") as raw:
        ws = Socket(raw)
        raw.send_json({"type": "hello", "token": token})
        ws.next()
        client.delete(f"/api/documents/{doc['id']}", headers=auth["root"])
        assert ws.until("doc.deleted")["doc_id"] == doc["id"]


def test_events_are_json_serialisable_summaries(client, auth, agent_key):
    """Events carry the library card's data (no content), so libraries update without a fetch."""
    token = auth["root"]["Authorization"].removeprefix("Bearer ")
    with client.websocket_connect("/api/ws") as raw:
        ws = Socket(raw)
        raw.send_json({"type": "hello", "token": token})
        ws.next()
        tool(client, agent_key, "create_sheet", {"title": "Numbers", "columns": ["x"], "rows": [[1]]})
        event = ws.until("doc.created")
        assert "content" not in event["doc"] and event["doc"]["kind"] == "sheet"
        json.dumps(event)


# ───────────── Phase 3: row ids, offloading, public links, serverless ─────────────


def test_sheet_rows_merge_by_id_across_inserts_and_deletes(client, auth):
    """Both sides insert and delete rows in the middle; edits follow their rows, not positions."""
    sheet = new_doc(client, auth["root"], "sheet", {"columns": ["Item", "Qty"], "rows": [["a", 1], ["b", 2], ["c", 3], ["d", 4], ["e", 5]]})
    ids, rows = sheet["content"]["row_ids"], sheet["content"]["rows"]
    assert len(set(ids)) == 5
    # Theirs (a teammate): insert x after a, delete c, set d to 40.
    theirs_rows = [rows[0], ["x", 9], rows[1], ["d", 40], rows[4]]
    theirs_ids = [ids[0], "newx0001", ids[1], ids[3], ids[4]]
    r = client.patch(
        f"/api/documents/{sheet['id']}",
        headers=auth["root"],
        json={"content": {"columns": ["Item", "Qty"], "rows": theirs_rows, "row_ids": theirs_ids}, "base_revision": sheet["revision"]},
    )
    assert r.status_code == 200 and not r.json()["merged"]
    # Ours (a tab still on the old revision): insert y at the top, delete e, set b to 20.
    ours_rows = [["y", 7], rows[0], ["b", 20], rows[2], rows[3]]
    ours_ids = ["newy0001", ids[0], ids[1], ids[2], ids[3]]
    saved = client.patch(
        f"/api/documents/{sheet['id']}",
        headers=auth["root"],
        json={"content": {"columns": ["Item", "Qty"], "rows": ours_rows, "row_ids": ours_ids}, "base_revision": sheet["revision"]},
    ).json()
    assert saved["merged"] and saved["conflicts"] == []
    assert saved["content"]["rows"] == [["y", 7], ["a", 1], ["x", 9], ["b", 20], ["d", 40]]
    assert saved["content"]["row_ids"] == ["newy0001", ids[0], "newx0001", ids[1], ids[3]]


def test_sheet_row_ids_are_filled_in_and_kept(client, auth, agent_key):
    """Sheets without row ids get them; an agent's cell edits and appended rows keep them."""
    made = tool(client, agent_key, "create_sheet", {"title": "Ids", "columns": ["n"], "rows": [[1], [2]]})
    first = client.get(f"/api/documents/{made['id']}", headers=auth["root"]).json()["content"]["row_ids"]
    tool(client, agent_key, "update_sheet_cells", {"document_id": made["id"], "cells": [{"row": 1, "column": "n", "value": "=A2*2"}], "append_rows": [[3]]})
    content = client.get(f"/api/documents/{made['id']}", headers=auth["root"]).json()["content"]
    assert content["rows"] == [["=A2*2"], [2], [3]]  # formulas stay as written
    assert content["row_ids"][:2] == first and len(set(content["row_ids"])) == 3
    with Session(engine) as s:  # a sheet stored before row ids existed reads with positional ones
        doc = s.get(Document, made["id"])
        doc.content = {"columns": ["n"], "rows": [[1], [2]]}
        s.add(doc)
        s.commit()
    assert client.get(f"/api/documents/{made['id']}", headers=auth["root"]).json()["content"]["row_ids"] == ["r0", "r1"]


@pytest.fixture
def small_inline_limit(monkeypatch):
    monkeypatch.setattr(get_settings(), "inline_content_max_bytes", 400)


def _blob(key: str) -> dict:
    data = get_storage().get(key)
    assert data is not None, f"{key} missing from storage"
    return json.loads(gzip.decompress(data))


def test_large_bodies_are_offloaded_and_read_transparently(client, auth, agent_key, small_inline_limit):
    big = "".join(f"<p>Paragraph {i} about offloaded zebrafish.</p>" for i in range(40))
    doc = new_doc(client, auth["root"], "doc", {"html": big, "page": "a4"})
    small = new_doc(client, auth["root"], "doc", {"html": "<p>tiny</p>", "page": "a4"})
    with Session(engine) as s:
        row = s.get(Document, doc["id"])
        assert row.content == {"_offloaded": True} and row.s3_content_key.startswith(f"docs/{doc['id']}/rev-0-")
        assert _blob(row.s3_content_key)["html"] == big
        snap = s.get(DocumentSnapshot, (doc["id"], 0))
        assert snap.content_z == b"" and snap.s3_content_key == row.s3_content_key
        assert s.get(Document, small["id"]).s3_content_key is None  # small bodies stay inline
    # Every reader sees the full body: REST, MCP, search, export.
    assert client.get(f"/api/documents/{doc['id']}", headers=auth["root"]).json()["content"]["html"] == big
    assert "Paragraph 39" in tool(client, agent_key, "get_document", {"document_id": doc["id"]})["content"]["markdown"]
    assert any(h["id"] == doc["id"] for h in tool(client, agent_key, "search_documents", {"query": "zebrafish"}))
    assert client.get(f"/api/documents/{doc['id']}/export/docx", headers=auth["root"]).status_code == 200
    # Merges hydrate both the stored version and the base snapshot.
    tool(client, agent_key, "patch_doc", {"document_id": doc["id"], "markdown": "Agent line."})
    saved = client.patch(
        f"/api/documents/{doc['id']}", headers=auth["root"], json={"content": {"html": "<p>Mine first.</p>" + big, "page": "a4"}, "base_revision": 0}
    ).json()
    assert saved["merged"] and saved["content"]["html"].startswith("<p>Mine first.</p>") and "Agent line." in saved["content"]["html"]


def test_offloaded_blobs_are_pruned_with_snapshots_and_deleted_with_the_doc(client, auth, small_inline_limit):
    body = lambda n: {"html": "".join(f"<p>Rev {n} line {i}</p>" for i in range(40)), "page": "a4"}
    doc = new_doc(client, auth["root"], "doc", body(0))
    with Session(engine) as s:
        keys = [s.get(Document, doc["id"]).s3_content_key]
    client.patch(f"/api/documents/{doc['id']}", headers=auth["root"], json={"title": "Renamed only"})
    with Session(engine) as s:
        assert s.get(Document, doc["id"]).s3_content_key == keys[0]  # a rename reuses the blob
    for n in range(1, 13):
        client.patch(f"/api/documents/{doc['id']}", headers=auth["root"], json={"content": body(n)})
        with Session(engine) as s:
            keys.append(s.get(Document, doc["id"]).s3_content_key)
    with Session(engine) as s:
        live = set(s.exec(select(DocumentSnapshot.s3_content_key).where(DocumentSnapshot.document_id == doc["id"])).all())
    assert len(live) == 10 and keys[-1] in live
    for key in keys:
        assert (get_storage().get(key) is not None) == (key in live), key
    assert client.get(f"/api/documents/{doc['id']}", headers=auth["root"]).json()["content"] == body(12)
    assert client.delete(f"/api/documents/{doc['id']}", headers=auth["root"]).status_code == 204
    assert all(get_storage().get(k) is None for k in keys)


def test_public_link_create_read_revoke(client, auth):
    sheet = new_doc(client, auth["root"], "sheet", {"columns": ["n", "double"], "rows": [[2, "=A1*2"]]}, title="Public sums")
    assert client.post(f"/api/documents/{sheet['id']}/shares", headers=auth["bob"], json={"principal_type": "public_link"}).status_code == 404
    link = client.post(f"/api/documents/{sheet['id']}/shares", headers=auth["root"], json={"principal_type": "public_link", "role": "editor"}).json()
    assert link["principal_type"] == "public_link" and link["role"] == "viewer" and len(link["principal_id"]) >= 32
    again = client.post(f"/api/documents/{sheet['id']}/shares", headers=auth["root"], json={"principal_type": "public_link"}).json()
    assert again["principal_id"] == link["principal_id"]  # one link per document
    # Anyone with the token reads it, with no sign-in; formulas come as written.
    r = client.get(f"/api/public/{link['principal_id']}")
    assert r.status_code == 200 and r.headers["cache-control"] == "no-cache"
    body = r.json()
    assert body["title"] == "Public sums" and body["kind"] == "sheet" and body["content"]["rows"] == [[2, "=A1*2"]]
    assert set(body) == {"kind", "title", "revision", "updated_at", "content"}  # no ids or owner
    assert client.get(f"/api/public/{link['principal_id']}", headers={"If-None-Match": r.headers["etag"]}).status_code == 304
    # The link reads; it never signs anyone in or lets them write.
    assert client.get(f"/api/documents/{sheet['id']}").status_code == 401
    assert client.patch(f"/api/documents/{sheet['id']}", json={"title": "x"}).status_code == 401
    assert client.get("/api/public/not-a-real-token").status_code == 404
    shares = client.get(f"/api/documents/{sheet['id']}/shares", headers=auth["root"]).json()
    assert [s["label"] for s in shares] == ["Anyone with the link"]
    assert client.delete(f"/api/documents/{sheet['id']}/shares/{link['id']}", headers=auth["root"]).status_code == 204
    assert client.get(f"/api/public/{link['principal_id']}").status_code == 404
    assert client.get(f"/api/public/{link['principal_id']}", headers={"If-None-Match": r.headers["etag"]}).status_code == 404


def test_public_link_dies_with_the_document(client, auth):
    doc = new_doc(client, auth["root"], "doc", {"html": "<p>bye</p>", "page": "a4"})
    token = client.post(f"/api/documents/{doc['id']}/shares", headers=auth["root"], json={"principal_type": "public_link"}).json()["principal_id"]
    assert client.get(f"/api/public/{token}").status_code == 200
    client.delete(f"/api/documents/{doc['id']}", headers=auth["root"])
    assert client.get(f"/api/public/{token}").status_code == 404


API_DIR = Path(__file__).resolve().parent.parent
HEAVY = ("weasyprint", "docx", "pptx", "openpyxl")


def _python(code: str) -> str:
    out = subprocess.run([sys.executable, "-c", code], cwd=API_DIR, env=os.environ.copy(), capture_output=True, text=True, timeout=120, check=False)
    assert out.returncode == 0, out.stderr[-3000:]
    return out.stdout


def test_api_boots_without_heavy_export_libraries():
    loaded = _python(f"import sys, app.main, app.lambda_handler; print([m for m in {HEAVY!r} if m in sys.modules])")
    assert loaded.strip() == "[]"


def test_pdf_export_answers_501_without_weasyprint(client, auth, monkeypatch):
    def missing():
        raise export.PdfUnavailable("Server-side PDF export isn't available here (OSError)")

    monkeypatch.setattr(export, "_weasyprint", missing)
    doc = new_doc(client, auth["root"], "doc", {"html": "<p>x</p>", "page": "a4"})
    r = client.get(f"/api/documents/{doc['id']}/export/pdf", headers=auth["root"])
    assert r.status_code == 501 and "Save as PDF" in r.json()["detail"]
    assert client.get(f"/api/documents/{doc['id']}/export/docx", headers=auth["root"]).status_code == 200


def test_lambda_entry_points(client, auth):
    """The Mangum handler serves REST and MCP from a fresh process, as a cold Lambda would,
    behind a non-localhost domain (MCP_ALLOWED_HOSTS)."""
    token = auth["root"]["Authorization"]
    code = f"""
import json
from app.lambda_handler import api_handler, migrate_handler

def call(method, path, headers, body=None, host="api.chia.example"):
    event = {{"version": "2.0", "routeKey": "$default", "rawPath": path, "rawQueryString": "",
        "headers": {{"host": host, **headers}}, "body": json.dumps(body) if body else None, "isBase64Encoded": False,
        "requestContext": {{"http": {{"method": method, "path": path, "sourceIp": "127.0.0.1", "protocol": "HTTP/1.1"}},
            "domainName": host, "stage": "$default", "accountId": "1", "apiId": "x", "requestId": "r"}}}}
    out = api_handler(event, None)
    return out["statusCode"], out["body"]

mcp = {{"authorization": "Bearer test-bootstrap-key", "accept": "application/json, text/event-stream", "content-type": "application/json"}}
print(json.dumps([
    migrate_handler(),
    call("GET", "/health", {{}}),
    call("GET", "/api/documents", {{"authorization": {token!r}}})[0],
    call("POST", "/mcp", mcp, {{"jsonrpc": "2.0", "id": 1, "method": "tools/list"}}),
    call("POST", "/mcp", mcp, {{"jsonrpc": "2.0", "id": 2, "method": "tools/list"}})[0],
    call("POST", "/mcp", mcp, {{"jsonrpc": "2.0", "id": 3, "method": "tools/list"}}, host="evil.example")[0],
]))
"""
    env = {**os.environ, "MCP_ALLOWED_HOSTS": '["api.chia.example"]'}
    out = subprocess.run([sys.executable, "-c", code], cwd=API_DIR, env=env, capture_output=True, text=True, timeout=120, check=False)
    assert out.returncode == 0, out.stderr[-3000:]
    migrated, health, docs_status, (mcp_status, mcp_body), second_call, other_host = json.loads(out.stdout.strip().splitlines()[-1])
    assert migrated == {"status": "migrated"}
    assert health == [200, '{"status":"ok"}'] and docs_status == 200
    assert mcp_status == 200 and "update_sheet_cells" in mcp_body and second_call == 200
    assert other_host == 421  # MCP's DNS-rebinding guard still holds for unknown hosts


def test_appsync_sink_publishes_each_channel(monkeypatch):
    import httpx

    sent: list[httpx.Request] = []
    transport = httpx.MockTransport(lambda request: sent.append(request) or httpx.Response(200, json={"successful": [], "failed": []}))
    keyed = realtime.AppSyncEventsSink("https://abc.appsync-api.eu-west-1.amazonaws.com", "chia", api_key="da2-test", transport=transport)
    keyed(["workspace:w1", "doc:d1"], {"type": "doc.updated", "doc_id": "d1"})
    assert [str(r.url) for r in sent] == ["https://abc.appsync-api.eu-west-1.amazonaws.com/event"] * 2
    bodies = [json.loads(r.content) for r in sent]
    assert [b["channel"] for b in bodies] == ["/chia/workspace/w1", "/chia/doc/d1"]
    assert json.loads(bodies[0]["events"][0]) == {"type": "doc.updated", "doc_id": "d1"}
    assert sent[0].headers["x-api-key"] == "da2-test"
    # Without an API key it signs with IAM (SigV4), region taken from the endpoint.
    for name, value in {"AWS_ACCESS_KEY_ID": "AKIDEXAMPLE", "AWS_SECRET_ACCESS_KEY": "secret", "AWS_SESSION_TOKEN": "tok"}.items():
        monkeypatch.setenv(name, value)
    monkeypatch.delenv("AWS_PROFILE", raising=False)
    sent.clear()
    signed = realtime.AppSyncEventsSink("abc.appsync-api.eu-west-1.amazonaws.com", "chia", transport=transport)
    signed(["doc:d1"], {"type": "doc.updated"})
    auth_header = sent[0].headers["authorization"]
    assert auth_header.startswith("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/") and "/eu-west-1/appsync/aws4_request" in auth_header
    assert sent[0].headers["x-amz-security-token"] == "tok"
    # A failing sink never breaks a save.
    broken = realtime.AppSyncEventsSink("https://x", "chia", api_key="k", transport=httpx.MockTransport(lambda r: httpx.Response(500)))
    realtime.add_sink(broken)
    try:
        realtime.publish(["doc:d1"], {"type": "doc.updated"})
    finally:
        realtime._sinks.remove(broken)


def test_appsync_authorizer_checks_channel_access(client, auth, ids):
    ws = client.get("/api/workspaces", headers=auth["root"]).json()[0]["id"]
    doc = new_doc(client, auth["root"], "doc")
    token = create_access_token(ids["carol"])
    root_token = create_access_token(ids["root"])

    def ask(tok: str, operation: str, channel: str = "") -> bool:
        event = {"authorizationToken": tok, "requestContext": {"operation": operation, "channel": channel, "channelNamespaceName": "chia"}}
        decision = authorize_appsync(event)
        assert decision["ttlOverride"] == 0
        return decision["isAuthorized"]

    assert ask(root_token, "EVENT_CONNECT") and not ask("garbage", "EVENT_CONNECT")
    assert ask(root_token, "EVENT_SUBSCRIBE", f"/chia/workspace/{ws}")
    assert ask(root_token, "EVENT_SUBSCRIBE", f"/chia/doc/{doc['id']}")
    assert not ask(token, "EVENT_SUBSCRIBE", f"/chia/workspace/{ws}")  # carol isn't a member
    assert not ask(token, "EVENT_SUBSCRIBE", f"/chia/doc/{doc['id']}")
    assert not ask(root_token, "EVENT_SUBSCRIBE", "/chia/other/x") and not ask(root_token, "EVENT_SUBSCRIBE", f"/elsewhere/doc/{doc['id']}")
    assert not ask(root_token, "EVENT_PUBLISH", f"/chia/doc/{doc['id']}")  # only the API publishes


def test_realtime_config_defaults_to_websocket(client, auth):
    cfg = client.get("/api/realtime/config", headers=auth["root"]).json()
    ws = client.get("/api/workspaces", headers=auth["root"]).json()[0]["id"]
    assert cfg["backend"] == "websocket" and cfg["personal_workspace_id"] == ws
    assert client.get("/api/realtime/config").status_code == 401


WEB_DIR = API_DIR.parent / "web"


@pytest.mark.skipif(shutil.which("node") is None, reason="needs Node.js")
def test_browser_formula_evaluator():
    """The sheet formula engine runs in the browser; its unit tests run under Node's test runner."""
    out = subprocess.run(["node", "--test", "--test-reporter=tap", "src/lib/formulas.test.ts"], cwd=WEB_DIR, capture_output=True, text=True, timeout=120, check=False)
    assert out.returncode == 0, out.stdout[-4000:] + out.stderr[-2000:]
    assert "# fail 0" in out.stdout
