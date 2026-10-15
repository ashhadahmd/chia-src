"""Large document bodies live in blob storage (`app.storage`), small ones inline in the row.

A body whose JSON is larger than INLINE_CONTENT_MAX_BYTES is gzipped to
`docs/{doc_id}/rev-{revision}-{nonce}.json.gz`; the row's `content` becomes `OFFLOADED` and its
`s3_content_key` names the blob. Snapshots of that revision point at the same blob, so a big doc
is written once per revision. Keys are never rewritten (the nonce keeps two racing saves of one
revision apart), which makes them safe to cache.
"""

import gzip
import json
from collections import OrderedDict
from secrets import token_hex
from threading import Lock
from typing import Any

from app.config import get_settings
from app.storage import get_storage

OFFLOADED: dict[str, Any] = {"_offloaded": True}

_CACHE_SIZE = 32
_cache: OrderedDict[str, bytes] = OrderedDict()  # key -> raw JSON; keys are immutable
_lock = Lock()


def _remember(key: str, raw: bytes) -> None:
    with _lock:
        _cache[key] = raw
        _cache.move_to_end(key)
        while len(_cache) > _CACHE_SIZE:
            _cache.popitem(last=False)


def encode(content: dict[str, Any]) -> bytes:
    return json.dumps(content, separators=(",", ":"), ensure_ascii=False).encode()


def pack(doc_id: str, revision: int, content: dict[str, Any]) -> tuple[dict[str, Any], str | None]:
    """What to store in the row for `content`: (content, None) when it is small enough to keep
    inline, else (OFFLOADED, key) after writing the blob."""
    raw = encode(content)
    if len(raw) <= get_settings().inline_content_max_bytes:
        return content, None
    key = f"docs/{doc_id}/rev-{revision}-{token_hex(4)}.json.gz"
    get_storage().put(key, gzip.compress(raw), "application/gzip")
    _remember(key, raw)
    return dict(OFFLOADED), key


def load(key: str) -> dict[str, Any]:
    with _lock:
        raw = _cache.get(key)
    if raw is None:
        blob = get_storage().get(key)
        if blob is None:
            raise LookupError(f"Offloaded content {key} is missing from storage")
        raw = gzip.decompress(blob)
        _remember(key, raw)
    return json.loads(raw)


def hydrate(content: dict[str, Any] | None, key: str | None) -> dict[str, Any] | None:
    """The full body of a row: its inline content, or the blob it points at."""
    return load(key) if key else content


def delete(keys: set[str]) -> None:
    storage = get_storage()
    for key in keys:
        with _lock:
            _cache.pop(key, None)
        storage.delete(key)
