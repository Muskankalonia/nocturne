from __future__ import annotations

import gzip
import json
import os
import re
import uuid
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Protocol

from google.cloud import storage as gcs_storage
from google.cloud.storage.retry import DEFAULT_RETRY_IF_GENERATION_SPECIFIED


DEFAULT_BATCH_DOCUMENTS = 100
DEFAULT_BATCH_BYTES = 64 * 1024 * 1024


class OutputSink(Protocol):
    def write(self, record: Mapping[str, Any]) -> str | None:
        """Persist or buffer one crawled-page record."""

    def finalize(self, manifest: Mapping[str, Any]) -> dict[str, Any]:
        """Flush remaining records and persist the crawl manifest."""


@dataclass(frozen=True)
class StoredObject:
    uri: str
    name: str
    document_count: int
    uncompressed_bytes: int
    compressed_bytes: int


def _safe_path_component(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_.-]", "-", value.strip())
    return cleaned.strip("-.") or "unknown"


def _local_run_id(now: datetime) -> str:
    timestamp = now.strftime("%Y%m%dT%H%M%SZ")
    return f"local-{timestamp}-{uuid.uuid4().hex[:8]}"


def _positive_int(value: str | int, name: str) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be a positive integer") from exc
    if parsed <= 0:
        raise ValueError(f"{name} must be a positive integer")
    return parsed


class LocalTextSink:
    """Write one human-readable text file per page for local development."""

    def __init__(self, output_dir: str | Path) -> None:
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self._document_count = 0
        self._files: list[str] = []
        self._closed = False

    def write(self, record: Mapping[str, Any]) -> str:
        if self._closed:
            raise RuntimeError("Cannot write to a finalized sink")

        self._document_count += 1
        url = str(record["url"])
        url_name = re.sub(r"https?://", "", url)
        url_name = re.sub(r"[^\w\-.]", "_", url_name)[:100]
        filename = (
            f"{self._document_count:03d}_depth{record['depth']}_{url_name}.txt"
        )
        filepath = self.output_dir / filename
        keywords = ", ".join(record.get("keywords_matched", []))

        filepath.write_text(
            "\n".join(
                [
                    f"URL: {url}",
                    f"Title: {record.get('title', 'N/A')}",
                    f"Depth: {record['depth']}",
                    f"Keywords matched: {keywords}",
                    f"Scraped at: {record['fetched_at']}",
                    "=" * 80,
                    "",
                    str(record["raw_text"]),
                ]
            ),
            encoding="utf-8",
        )
        self._files.append(filename)
        return str(filepath)

    def finalize(self, manifest: Mapping[str, Any]) -> dict[str, Any]:
        if self._closed:
            raise RuntimeError("Sink has already been finalized")

        completed_manifest = dict(manifest)
        completed_manifest["storage"] = {
            "backend": "local",
            "output_dir": str(self.output_dir),
            "files": list(self._files),
        }
        manifest_path = self.output_dir / "crawl_summary.json"
        manifest_path.write_text(
            json.dumps(completed_manifest, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
        self._closed = True
        return completed_manifest


class GcsJsonlSink:
    """Buffer page records and upload bounded gzip-compressed JSONL objects."""

    def __init__(
        self,
        bucket_name: str,
        prefix: str = "raw/crawls",
        max_documents: int = DEFAULT_BATCH_DOCUMENTS,
        max_bytes: int = DEFAULT_BATCH_BYTES,
        *,
        client: Any | None = None,
        run_id: str | None = None,
        task_index: str | None = None,
        task_attempt: str | None = None,
        started_at: datetime | None = None,
    ) -> None:
        if not bucket_name.strip():
            raise ValueError("GCS bucket name must not be empty")

        self.max_documents = _positive_int(max_documents, "max_documents")
        self.max_bytes = _positive_int(max_bytes, "max_bytes")
        self.started_at = started_at or datetime.now(timezone.utc)
        if self.started_at.tzinfo is None:
            raise ValueError("started_at must include timezone information")

        self.bucket_name = bucket_name
        self.prefix = prefix.strip("/")
        self.run_id = _safe_path_component(
            run_id
            or os.getenv("CLOUD_RUN_EXECUTION")
            or _local_run_id(self.started_at)
        )
        self.task_index = _safe_path_component(
            task_index or os.getenv("CLOUD_RUN_TASK_INDEX", "0")
        )
        self.task_attempt = _safe_path_component(
            task_attempt or os.getenv("CLOUD_RUN_TASK_ATTEMPT", "0")
        )

        path_parts = [
            self.prefix,
            f"crawl_date={self.started_at.date().isoformat()}",
            f"run_id={self.run_id}",
            f"task={self.task_index}",
            f"attempt={self.task_attempt}",
        ]
        self.object_base = "/".join(part for part in path_parts if part)

        self._client = client or gcs_storage.Client()
        self._bucket = self._client.bucket(bucket_name)
        self._lines: list[bytes] = []
        self._buffer_bytes = 0
        self._part_number = 0
        self._objects: list[StoredObject] = []
        self._closed = False

    def write(self, record: Mapping[str, Any]) -> str | None:
        if self._closed:
            raise RuntimeError("Cannot write to a finalized sink")

        line = (
            json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n"
        ).encode("utf-8")

        would_exceed_limit = self._lines and (
            len(self._lines) >= self.max_documents
            or self._buffer_bytes + len(line) > self.max_bytes
        )
        if would_exceed_limit:
            self._flush()

        self._lines.append(line)
        self._buffer_bytes += len(line)

        if (
            len(self._lines) >= self.max_documents
            or self._buffer_bytes >= self.max_bytes
        ):
            return self._flush()
        return None

    def _flush(self) -> str | None:
        if not self._lines:
            return None

        document_count = len(self._lines)
        uncompressed_bytes = self._buffer_bytes
        payload = gzip.compress(b"".join(self._lines))
        object_name = f"{self.object_base}/part-{self._part_number:05d}.jsonl.gz"
        blob = self._bucket.blob(object_name)
        blob.content_encoding = "gzip"
        blob.metadata = {
            "document-count": str(document_count),
            "schema-version": "1",
        }
        blob.upload_from_string(
            payload,
            content_type="application/x-ndjson",
            if_generation_match=0,
            retry=DEFAULT_RETRY_IF_GENERATION_SPECIFIED,
        )

        uri = f"gs://{self.bucket_name}/{object_name}"
        self._objects.append(
            StoredObject(
                uri=uri,
                name=object_name,
                document_count=document_count,
                uncompressed_bytes=uncompressed_bytes,
                compressed_bytes=len(payload),
            )
        )
        self._part_number += 1
        self._lines.clear()
        self._buffer_bytes = 0
        return uri

    def finalize(self, manifest: Mapping[str, Any]) -> dict[str, Any]:
        if self._closed:
            raise RuntimeError("Sink has already been finalized")

        self._flush()
        completed_manifest = dict(manifest)
        completed_manifest["storage"] = {
            "backend": "gcs",
            "bucket": self.bucket_name,
            "prefix": self.object_base,
            "objects": [asdict(stored) for stored in self._objects],
        }

        manifest_name = f"{self.object_base}/_manifest.json"
        completed_manifest["storage"]["manifest_uri"] = (
            f"gs://{self.bucket_name}/{manifest_name}"
        )
        manifest_blob = self._bucket.blob(manifest_name)
        manifest_blob.metadata = {"schema-version": "1"}
        manifest_blob.upload_from_string(
            json.dumps(completed_manifest, indent=2, ensure_ascii=False).encode("utf-8"),
            content_type="application/json",
            if_generation_match=0,
            retry=DEFAULT_RETRY_IF_GENERATION_SPECIFIED,
        )
        self._closed = True
        return completed_manifest


def create_output_sink(
    output_dir: str | Path,
    *,
    environ: Mapping[str, str] | None = None,
    client: Any | None = None,
) -> OutputSink:
    env = os.environ if environ is None else environ
    backend = env.get("OUTPUT_BACKEND", "local").strip().lower()

    if backend == "local":
        return LocalTextSink(output_dir)
    if backend != "gcs":
        raise ValueError("OUTPUT_BACKEND must be either 'local' or 'gcs'")

    bucket_name = env.get("GCS_BUCKET", "").strip()
    if not bucket_name:
        raise ValueError("GCS_BUCKET is required when OUTPUT_BACKEND=gcs")

    return GcsJsonlSink(
        bucket_name=bucket_name,
        prefix=env.get("GCS_PREFIX", "raw/crawls"),
        max_documents=_positive_int(
            env.get("GCS_BATCH_MAX_DOCUMENTS", DEFAULT_BATCH_DOCUMENTS),
            "GCS_BATCH_MAX_DOCUMENTS",
        ),
        max_bytes=_positive_int(
            env.get("GCS_BATCH_MAX_BYTES", DEFAULT_BATCH_BYTES),
            "GCS_BATCH_MAX_BYTES",
        ),
        client=client,
    )
