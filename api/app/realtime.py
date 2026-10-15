"""Realtime change notices: tiny JSON events pushed to open Chia tabs, so nothing polls.

Document writes call `publish()` after they commit (from any thread). Events go to two kinds of
channel: `workspace:<id>` (every tab looking at that workspace's library) and `doc:<id>` (tabs
with that document open, including people it was shared with). Events carry the document
summary (no content), so a library updates without a request and an editor fetches only when
another writer changed the document it shows.

Delivery is pluggable:
- `LocalHub` (default): in-process fan-out to the WebSocket connections this process holds.
  Right for local dev and for a single container.
- Extra sinks (`add_sink`) receive every event too. `AppSyncEventsSink` (REALTIME_BACKEND=
  aws_appsync) publishes to AWS AppSync Events, which browsers subscribe to directly; that is
  how realtime works on Lambda, where no process holds sockets. Redis `PUBLISH` or Postgres
  `pg_notify` sinks would plug in the same way.
"""

import asyncio
import json
import logging
import threading
from collections import defaultdict
from collections.abc import Callable
from typing import Any
from urllib.parse import urlsplit

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


# ───────────── AWS AppSync Events ─────────────


def appsync_channel(namespace: str, channel: str) -> str:
    """`workspace:<id>` -> `/<namespace>/workspace/<id>` (AppSync channel segments)."""
    kind, _, ident = channel.partition(":")
    return f"/{namespace}/{kind}/{ident}"


def parse_appsync_channel(namespace: str, path: str) -> tuple[str, str] | None:
    """`/<namespace>/workspace/<id>` -> ("workspace", id); None for anything else."""
    parts = path.strip("/").split("/")
    if len(parts) != 3 or parts[0] != namespace or parts[1] not in ("workspace", "doc") or not parts[2]:
        return None
    return parts[1], parts[2]


class AppSyncEventsSink:
    """Publishes each event to AWS AppSync Events over HTTP (POST {endpoint}/event), one
    request per channel. Signs with IAM (SigV4, the Lambda's role) unless an API key is given.
    Runs inline after the commit, so a Lambda doesn't freeze with the publish half-sent; the
    timeout is short and a failure only means tabs reconcile on their next resync."""

    def __init__(self, endpoint: str, namespace: str, api_key: str = "", region: str | None = None, transport: Any = None) -> None:
        import httpx

        if not endpoint:
            raise RuntimeError("REALTIME_BACKEND=aws_appsync needs APPSYNC_HTTP_ENDPOINT")
        base = endpoint if "://" in endpoint else f"https://{endpoint}"
        self.url = base.rstrip("/") + "/event"
        self.namespace = namespace
        self.api_key = api_key
        self.region = region
        self.client = httpx.Client(timeout=3.0, transport=transport)
        self._signer: Any = None

    def _signed_headers(self, body: bytes) -> dict[str, str]:
        if self.api_key:
            return {"content-type": "application/json", "x-api-key": self.api_key}
        from botocore.auth import SigV4Auth
        from botocore.awsrequest import AWSRequest

        if self._signer is None:
            import boto3

            session = boto3.Session()
            # The endpoint names its region (xxxx.appsync-api.<region>.amazonaws.com); a custom
            # domain doesn't, so then the Lambda's own region applies.
            host = (urlsplit(self.url).hostname or "").split(".")
            from_host = host[2] if len(host) > 3 and host[1] == "appsync-api" else None
            region = self.region or from_host or session.region_name
            self._signer = SigV4Auth(session.get_credentials(), "appsync", region)
        request = AWSRequest(method="POST", url=self.url, data=body, headers={"content-type": "application/json"})
        self._signer.add_auth(request)
        return dict(request.headers.items())

    def __call__(self, channels: list[str], event: Event) -> None:
        payload = json.dumps(event, separators=(",", ":"))
        for channel in channels:
            body = json.dumps({"channel": appsync_channel(self.namespace, channel), "events": [payload]}).encode()
            response = self.client.post(self.url, content=body, headers=self._signed_headers(body))
            response.raise_for_status()


def configure() -> None:
    """Hook up the sink REALTIME_BACKEND asks for. Called once at startup."""
    from app.config import get_settings

    s = get_settings()
    if s.realtime_backend == "aws_appsync" and not any(isinstance(x, AppSyncEventsSink) for x in _sinks):
        add_sink(AppSyncEventsSink(s.appsync_http_endpoint, s.appsync_namespace, s.appsync_api_key, s.appsync_region))
