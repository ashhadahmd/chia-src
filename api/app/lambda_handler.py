"""AWS Lambda entry points.

- `api_handler`: the whole API (REST, MCP at /mcp, public links) behind API Gateway or a
  Lambda function URL, through Mangum. Lambda can't hold WebSockets, so set
  REALTIME_BACKEND=aws_appsync and browsers get change notices from AppSync Events.
- `migrate_handler`: run once per deploy (`alembic upgrade head`, then the root account),
  since AUTO_MIGRATE should be off where many instances start at once.
- `appsync_authorizer`: the AppSync Events Lambda authorizer for browser subscriptions.
- The Drive backup worker is `app.worker.handler`.

Mangum runs with lifespan="off": the startup work (migrations, the local Drive runner) doesn't
belong in a request path. The one thing MCP does need, its session manager's task group, is
started on the first request and kept for the life of the container (Mangum reuses one event
loop across invocations).
"""

import asyncio
from typing import Any

from mangum import Mangum
from starlette.types import ASGIApp, Receive, Scope, Send

from app.db import ensure_root, migrate
from app.main import app
from app.mcp_server import mcp
from app.routes.realtime import authorize_appsync


class _WithMcpSessions:
    def __init__(self, inner: ASGIApp) -> None:
        self.inner = inner
        self._ready: asyncio.Event | None = None
        self._holder: asyncio.Task[None] | None = None

    async def _hold(self, ready: asyncio.Event) -> None:
        async with mcp.session_manager.run():
            ready.set()
            await asyncio.Event().wait()  # until the container goes away

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http":
            if self._ready is None:
                self._ready = asyncio.Event()
                self._holder = asyncio.get_running_loop().create_task(self._hold(self._ready))
            await self._ready.wait()
        await self.inner(scope, receive, send)


api_handler = Mangum(_WithMcpSessions(app), lifespan="off")


def migrate_handler(event: dict[str, Any] | None = None, context: Any = None) -> dict[str, str]:
    migrate()
    ensure_root()
    return {"status": "migrated"}


def appsync_authorizer(event: dict[str, Any], context: Any = None) -> dict[str, Any]:
    return authorize_appsync(event)
