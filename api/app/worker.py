"""Background work that runs outside request handling: Google Drive backups.

- AWS: point an EventBridge schedule (or an SQS trigger) at `app.worker.handler`, with
  DRIVE_SYNC_RUNNER=external on the API.
- Anywhere else: `uv run python -m app.worker` loops forever.
- Local dev needs neither: with DRIVE_SYNC_RUNNER=local the API runs `local_runner` itself.
"""

import logging
import time
from typing import Any

import anyio

from app.google import backup

log = logging.getLogger("chia.worker")

INTERVAL_SECONDS = 2.0


def handler(event: dict[str, Any] | None = None, context: Any = None) -> dict[str, int]:
    """Lambda entry point: sync every document that is due, in batches."""
    synced = 0
    while batch := backup.run_due():
        synced += batch
    return {"synced": synced}


async def local_runner() -> None:
    """The API's own runner for local dev; cancelled when the app shuts down."""
    while True:
        try:
            await anyio.to_thread.run_sync(backup.run_due)
        except Exception:
            log.exception("Drive sync pass failed")
        await anyio.sleep(INTERVAL_SECONDS)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    while True:
        try:
            backup.run_due()
        except Exception:
            log.exception("Drive sync pass failed")
        time.sleep(INTERVAL_SECONDS)
