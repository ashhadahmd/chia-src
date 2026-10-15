"""WebSocket for change notices: `/api/ws`.

Browsers can't put a bearer token on a WebSocket, so the first message carries it:

    → {"type": "hello", "token": "<session JWT>", "workspace_id": "<id or null>", "doc_id": "<id or null>"}
    ← {"type": "ready", "workspace_id": "<resolved id>", "doc_id": "<id or null>"}
    → {"type": "subscribe", "workspace_id": ..., "doc_id": ...}   (switching workspace or document)
    → {"type": "ping"}  ← {"type": "pong"}
    ← {"type": "doc.created" | "doc.updated" | "doc.deleted", "doc_id", "workspace_id", "revision", ...}

The tab closes the socket while it is hidden and reconciles with one conditional request when it
comes back, so idle tabs cost nothing.
"""

import asyncio
import contextlib
import json

import anyio
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from sqlmodel import Session

from app import realtime
from app.db import engine
from app.models import Document, User
from app.security import decode_access_token
from app.workspaces import AccessError, check_doc_access, resolve_actor

router = APIRouter(tags=["realtime"])

HELLO_TIMEOUT = 10  # seconds a new socket has to say who it is


class Refused(Exception):
    def __init__(self, code: int, detail: str) -> None:
        super().__init__(detail)
        self.code = code


def _channels(user_id: int, workspace_id: str | None, doc_id: str | None) -> tuple[set[str], str]:
    """Channels this user may listen to, checked against their workspace roles and shares."""
    with Session(engine) as session:
        if session.get(User, user_id) is None:
            raise Refused(4401, "Unknown user")
        try:
            actor = resolve_actor(session, user_id, workspace_id)
            channels = {realtime.workspace_channel(actor.workspace_id)}
            if doc_id:
                doc = session.get(Document, doc_id)
                if doc is None:
                    raise AccessError(404, "No such document")
                check_doc_access(session, actor, doc)
                channels.add(realtime.doc_channel(doc_id))
        except AccessError as exc:
            raise Refused(4403, str(exc)) from exc
        return channels, actor.workspace_id


@router.websocket("/ws")
async def changes(ws: WebSocket) -> None:
    await ws.accept()
    sub = realtime.Subscriber(asyncio.get_running_loop())
    pump_task: asyncio.Task | None = None
    try:
        with anyio.fail_after(HELLO_TIMEOUT):
            hello = json.loads(await ws.receive_text())
        if hello.get("type") != "hello":
            raise Refused(4400, "Say hello first")
        user_id = decode_access_token(str(hello.get("token", "")))
        if user_id is None:
            raise Refused(4401, "Invalid or expired session")

        async def subscribe(message: dict) -> None:
            doc_id = message.get("doc_id") or None
            channels, workspace_id = await anyio.to_thread.run_sync(_channels, user_id, message.get("workspace_id") or None, doc_id)
            realtime.hub.subscribe(sub, channels)
            await ws.send_json({"type": "ready", "workspace_id": workspace_id, "doc_id": doc_id})

        await subscribe(hello)

        async def pump() -> None:
            while True:
                await ws.send_json(await sub.queue.get())

        pump_task = asyncio.create_task(pump())
        while True:
            message = json.loads(await ws.receive_text())
            if message.get("type") == "ping":
                await ws.send_json({"type": "pong"})
            elif message.get("type") == "subscribe":
                await subscribe(message)
    except Refused as exc:
        with contextlib.suppress(RuntimeError):
            await ws.close(code=exc.code, reason=str(exc))
    except (WebSocketDisconnect, TimeoutError, json.JSONDecodeError, AttributeError):
        pass
    finally:
        realtime.hub.unsubscribe(sub)
        if pump_task is not None:
            pump_task.cancel()
