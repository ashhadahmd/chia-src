"""Realtime change notices: tiny JSON events pushed to open Chia tabs, so nothing polls.

Document writes call `publish()` after they commit (from any thread). Events go to two kinds of
channel: `workspace:<id>` (every tab looking at that workspace's library) and `doc:<id>` (tabs
with that document open, including people it was shared with). Events carry the document
summary (no content), so a library updates without a request and an editor fetches only when
another writer changed the document it shows.

Delivery is pluggable:
- `LocalHub` (default): in-process fan-out to the WebSocket connections this process holds.
  Right for local dev and for a single container.
- Extra sinks (`add_sink`) receive every event too. Production hooks plug in here: an AWS API
  Gateway WebSocket sink (look up connection ids subscribed to the channel, then
  `apigatewaymanagementapi.post_to_connection`), Redis `PUBLISH`, or Postgres `pg_notify`
  with each instance's listener feeding `hub.deliver`.
"""

import asyncio
import logging
import threading
from collections import defaultdict
from collections.abc import Callable
from typing import Any

log = logging.getLogger("chia.realtime")

Event = dict[str, Any]
Sink = Callable[[list[str], Event], None]


def workspace_channel(workspace_id: str) -> str:
    return f"workspace:{workspace_id}"


def doc_channel(doc_id: str) -> str:
    return f"doc:{doc_id}"


class Subscriber:
    """One open WebSocket: a queue the connection drains, and the channels it listens to."""

    def __init__(self, loop: asyncio.AbstractEventLoop) -> None:
        self.loop = loop
        self.queue: asyncio.Queue[Event] = asyncio.Queue(maxsize=256)
        self.channels: set[str] = set()

    def offer(self, event: Event) -> None:
        try:
            self.queue.put_nowait(event)
        except asyncio.QueueFull:  # a stalled tab; it reconciles when it reconnects
            pass


class LocalHub:
    def __init__(self) -> None:
        self._subs: dict[str, set[Subscriber]] = defaultdict(set)
        self._lock = threading.Lock()  # writes publish from worker threads

    def subscribe(self, sub: Subscriber, channels: set[str]) -> None:
        with self._lock:
            for ch in sub.channels - channels:
                self._subs[ch].discard(sub)
                if not self._subs[ch]:
                    del self._subs[ch]
            for ch in channels:
                self._subs[ch].add(sub)
            sub.channels = set(channels)

    def unsubscribe(self, sub: Subscriber) -> None:
        self.subscribe(sub, set())

    def deliver(self, channels: list[str], event: Event) -> None:
        """Queue `event` for every local subscriber of any of `channels`, once each. Thread-safe."""
        with self._lock:
            targets = {sub for ch in channels for sub in self._subs.get(ch, ())}
        for sub in targets:
            try:
                sub.loop.call_soon_threadsafe(sub.offer, event)
            except RuntimeError:  # its event loop has closed
                pass


hub = LocalHub()
_sinks: list[Sink] = []


def add_sink(sink: Sink) -> None:
    """Also send every event to `sink(channels, event)` (API Gateway, Redis, pg_notify...)."""
    _sinks.append(sink)


def publish(channels: list[str], event: Event) -> None:
    """Fan an event out. Never raises: a missed notice only means a tab reconciles later."""
    try:
        hub.deliver(channels, event)
    except Exception:
        log.exception("Local realtime delivery failed")
    for sink in _sinks:
        try:
            sink(channels, event)
        except Exception:
            log.exception("Realtime sink failed")
