from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import anyio
from fastapi import APIRouter, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.config import get_settings
from app.db import init_db
from app.documents import DocumentError
from app.mcp_server import mcp, mcp_app
from app.routes import assets, auth, documents, google, keys, realtime, workspaces
from app.worker import local_runner
from app.workspaces import AccessError


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    await anyio.to_thread.run_sync(init_db)
    async with anyio.create_task_group() as tasks:
        if get_settings().drive_sync_runner == "local":
            tasks.start_soon(local_runner)
        try:
            async with mcp.session_manager.run():
                yield
        finally:
            tasks.cancel_scope.cancel()


app = FastAPI(title="Chia API", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=get_settings().cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

api = APIRouter(prefix="/api")
api.include_router(assets.router)
api.include_router(auth.router)
api.include_router(documents.router)
api.include_router(google.router)
api.include_router(keys.router)
api.include_router(realtime.router)
api.include_router(workspaces.router)
app.include_router(api)


@app.exception_handler(DocumentError)
@app.exception_handler(AccessError)
async def document_error(_: Request, exc: DocumentError | AccessError) -> JSONResponse:
    return JSONResponse({"detail": str(exc)}, status_code=exc.status)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


# Mounted last so FastAPI routes take precedence; serves MCP at /mcp.
app.mount("/", mcp_app)
