"""Blob storage for image bytes: a local folder in dev, Amazon S3 in production.

Set STORAGE_BACKEND=local (default, files under LOCAL_STORAGE_DIR) or STORAGE_BACKEND=s3
(S3_BUCKET, optional S3_PREFIX / S3_REGION / S3_ENDPOINT_URL). With S3 the API never streams
bytes to browsers: it hands out short-lived presigned GET URLs instead.
"""

from functools import lru_cache
from pathlib import Path
from typing import Protocol

from app.config import get_settings


class Storage(Protocol):
    def put(self, key: str, data: bytes, media_type: str) -> None: ...

    def get(self, key: str) -> bytes | None: ...

    def delete(self, key: str) -> None: ...

    def presigned_url(self, key: str) -> str | None:
        """A URL the browser can fetch directly, or None to serve the bytes through the API."""
        ...


class LocalStorage:
    def __init__(self, root: str) -> None:
        self.root = Path(root).resolve()

    def _path(self, key: str) -> Path:
        path = (self.root / key).resolve()
        if not path.is_relative_to(self.root):
            raise ValueError(f"Storage key escapes the storage folder: {key!r}")
        return path

    def put(self, key: str, data: bytes, media_type: str) -> None:
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_bytes(data)
        tmp.replace(path)  # readers never see a half-written file

    def get(self, key: str) -> bytes | None:
        try:
            return self._path(key).read_bytes()
        except FileNotFoundError:
            return None

    def delete(self, key: str) -> None:
        self._path(key).unlink(missing_ok=True)

    def presigned_url(self, key: str) -> str | None:
        return None


class S3Storage:
    def __init__(self, bucket: str, prefix: str, region: str | None, endpoint_url: str | None, expires: int) -> None:
        import boto3  # only needed when S3 is in use

        if not bucket:
            raise RuntimeError("STORAGE_BACKEND=s3 needs S3_BUCKET")
        self.bucket = bucket
        self.prefix = prefix.strip("/") + "/" if prefix.strip("/") else ""
        self.expires = expires
        self.client = boto3.client("s3", region_name=region, endpoint_url=endpoint_url)

    def put(self, key: str, data: bytes, media_type: str) -> None:
        # Keys are content-addressed per asset id and never rewritten, so caches may keep them.
        self.client.put_object(
            Bucket=self.bucket,
            Key=self.prefix + key,
            Body=data,
            ContentType=media_type,
            CacheControl="private, max-age=31536000, immutable",
        )

    def get(self, key: str) -> bytes | None:
        try:
            return self.client.get_object(Bucket=self.bucket, Key=self.prefix + key)["Body"].read()
        except self.client.exceptions.NoSuchKey:
            return None

    def delete(self, key: str) -> None:
        self.client.delete_object(Bucket=self.bucket, Key=self.prefix + key)

    def presigned_url(self, key: str) -> str | None:
        return self.client.generate_presigned_url(
            "get_object", Params={"Bucket": self.bucket, "Key": self.prefix + key}, ExpiresIn=self.expires
        )


@lru_cache
def get_storage() -> Storage:
    s = get_settings()
    if s.storage_backend == "s3":
        return S3Storage(s.s3_bucket, s.s3_prefix, s.s3_region, s.s3_endpoint_url, s.presigned_url_seconds)
    return LocalStorage(s.local_storage_dir)
