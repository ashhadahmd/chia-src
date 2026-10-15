"""WebSocket for change notices: `/api/ws`.

Browsers can't put a bearer token on a WebSocket, so the first message carries it:

    → {"type": "hello", "token": "<session JWT>", "workspace_id": "<id or null>", "doc_id": "<id or null>"}
    ← {"type": "ready", "workspace_id": "<resolved id>", "doc_id": "<id or null>"}
    → {"type": "subscribe", "workspace_id": ..., "doc_id": ...}   (switching workspace or document)
    → {"type": "ping"}  ← {"type": "pong"}
    ← {"type": "doc.created" | "doc.updated" | "doc.deleted", "doc_id", "workspace_id", "revision", ...}

The tab closes the socket while it is hidden and reconciles with one conditional request when it
comes back, so idle tabs cost nothing.

With REALTIME_BACKEND=aws_appsync (Lambda), tabs subscribe to AWS AppSync Events instead:
`GET /api/realtime/config` tells them where, and `authorize_appsync` (wired up as the AppSync
Lambda authorizer in app.lambda_handler) lets each user subscribe only to the workspace and
document channels they may read, the same check this socket makes.
"""

import asyncio
import contextlib
import json
from typing import Any, Literal

import anyio
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import BaseModel
from sqlmodel import Session

from app import realtime
from app.config import get_settings
from app.db import engine
from app.deps import CurrentUser
from app.models import Document, User
from app.security import decode_access_token
from app.workspaces import (
    AccessError,
    check_doc_access,
    personal_workspace,
    resolve_actor,
)

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


# ───────────── AWS AppSync Events ─────────────


class RealtimeConfig(BaseModel):
    backend: Literal["websocket", "aws_appsync"]
    personal_workspace_id: str
    # AppSync only:
    realtime_url: str | None = None  # wss://.../event/realtime
    http_host: str | None = None  # the host AppSync expects in the auth header
    namespace: str | None = None
    auth: Literal["lambda", "api_key"] | None = None
    api_key: str | None = None  # dev setups only (see APPSYNC_API_KEY)


def _host(url: str) -> str:
    return url.split("://", 1)[-1].split("/", 1)[0]


@router.get("/realtime/config")
def realtime_config(user: CurrentUser) -> RealtimeConfig:
    """Where this tab listens for change notices."""
    s = get_settings()
    with Session(engine) as session:
        assert user.id is not None
        personal = personal_workspace(session, user.id).id
    if s.realtime_backend != "aws_appsync" or not s.appsync_realtime_endpoint:
        return RealtimeConfig(backend="websocket", personal_workspace_id=personal)
    return RealtimeConfig(
        backend="aws_appsync",
        personal_workspace_id=personal,
        realtime_url=s.appsync_realtime_endpoint.rstrip("/") + "/event/realtime",
        http_host=_host(s.appsync_http_endpoint),
        namespace=s.appsync_namespace,
        auth="api_key" if s.appsync_api_key else "lambda",
        api_key=s.appsync_api_key or None,
    )


def authorize_appsync(event: dict[str, Any]) -> dict[str, Any]:
    """AppSync Events Lambda authorizer. The token is the user's Chia session (JWT). Connecting
    needs a valid session; subscribing needs read access to the channel's workspace or document;
    publishing is refused (only the API publishes, signed with IAM). Decisions aren't cached
    (ttlOverride 0) because each one is for one channel."""
    deny = {"isAuthorized": False, "ttlOverride": 0}
    token = str(event.get("authorizationToken") or "").removeprefix("Bearer ").strip()
    user_id = decode_access_token(token) if token else None
    if user_id is None:
        return deny
    context = event.get("requestContext") or {}
    operation = context.get("operation")
    if operation == "EVENT_CONNECT":
        allowed = True
    elif operation == "EVENT_SUBSCRIBE":
        target = realtime.parse_appsync_channel(get_settings().appsync_namespace, str(context.get("channel") or ""))
        if target is None:
            return deny
        kind, ident = target
        try:
            _channels(user_id, ident if kind == "workspace" else None, ident if kind == "doc" else None)
            allowed = True
        except Refused:
            allowed = False
    else:
        allowed = False
    return {"isAuthorized": allowed, "ttlOverride": 0}
