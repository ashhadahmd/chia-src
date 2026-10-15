"""End-to-end checks through the HTTP API, the MCP endpoint and the WebSocket.

Phase 1: workspaces, roles, sharing, scoped agent keys, blob storage, SQL search.
Phase 2: three-way merges of concurrent human + agent edits (no 409), surgical MCP tools,
realtime events, conditional (ETag) reconciles.
"""

import io
import json
import queue
import threading
from typing import Any

import pytest
from fastapi import WebSocketDisconnect
from PIL import Image
from sqlmodel import Session, select

from app.db import engine
from app.models import ApiKey, Asset, AssetReference, Document, DocumentSnapshot, User
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
