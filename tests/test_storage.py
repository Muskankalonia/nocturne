import gzip
import json
import sys
import tempfile
import types
import unittest
from datetime import datetime, timezone
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
SRC_DIR = PROJECT_ROOT / "src"
sys.path.insert(0, str(SRC_DIR))

try:
    from google.cloud import storage as _installed_google_storage  # noqa: F401
except ModuleNotFoundError:
    google_module = types.ModuleType("google")
    cloud_module = types.ModuleType("google.cloud")
    storage_module = types.ModuleType("google.cloud.storage")
    retry_module = types.ModuleType("google.cloud.storage.retry")

    class MissingGoogleStorageClient:
        def __init__(self, *args, **kwargs):
            raise RuntimeError("Tests must inject a fake GCS client")

    storage_module.Client = MissingGoogleStorageClient
    retry_module.DEFAULT_RETRY_IF_GENERATION_SPECIFIED = object()
    google_module.cloud = cloud_module
    cloud_module.storage = storage_module
    sys.modules["google"] = google_module
    sys.modules["google.cloud"] = cloud_module
    sys.modules["google.cloud.storage"] = storage_module
    sys.modules["google.cloud.storage.retry"] = retry_module

from nocturne_crawler.storage import (  # noqa: E402
    GcsJsonlSink,
    LocalTextSink,
    create_output_sink,
)


class FakeBlob:
    def __init__(self, name, should_fail=False):
        self.name = name
        self.should_fail = should_fail
        self.content_encoding = None
        self.metadata = None
        self.uploads = []

    def upload_from_string(self, data, **kwargs):
        self.uploads.append({"data": data, **kwargs})
        if self.should_fail:
            raise RuntimeError("simulated permanent upload failure")


class FakeBucket:
    def __init__(self, fail_suffix=None):
        self.fail_suffix = fail_suffix
        self.blobs = {}
        self.requested_names = []

    def blob(self, name):
        self.requested_names.append(name)
        blob = FakeBlob(
            name,
            should_fail=bool(self.fail_suffix and name.endswith(self.fail_suffix)),
        )
        self.blobs[name] = blob
        return blob


class FakeStorageClient:
    def __init__(self, fail_suffix=None):
        self.bucket_name = None
        self.fake_bucket = FakeBucket(fail_suffix=fail_suffix)

    def bucket(self, name):
        self.bucket_name = name
        return self.fake_bucket


def page_record(number=1, raw_text=None, org_id="odido"):
    text = raw_text if raw_text is not None else f"raw page content {number}"
    return {
        "schema_version": 2,
        "org_id": org_id,
        "doc_id": f"document-{number}",
        "dedupe_key": f"dedupe-{number}",
        "run_id": "execution-abc",
        "source": "ahmia",
        "query": "odido",
        "url": f"http://page-{number}.example.onion/",
        "title": f"Page {number}",
        "fetched_at": "2026-07-19T10:00:00Z",
        "depth": 1,
        "keywords_matched": ["breach"],
        "links_found": 2,
        "content_length": len(text),
        "content_sha256": f"content-{number}",
        "raw_text": text,
    }


class GcsJsonlSinkTests(unittest.TestCase):
    def setUp(self):
        self.client = FakeStorageClient()
        self.started_at = datetime(2026, 7, 19, 10, 30, tzinfo=timezone.utc)

    def make_sink(self, **overrides):
        options = {
            "bucket_name": "raw-crawler-data",
            "org_id": "odido",
            "prefix": "raw/crawls",
            "max_documents": 2,
            "max_bytes": 1024 * 1024,
            "client": self.client,
            "run_id": "execution-abc",
            "task_index": "3",
            "task_attempt": "1",
            "started_at": self.started_at,
        }
        options.update(overrides)
        return GcsJsonlSink(**options)

    def part_blob(self, part_number=0):
        suffix = f"part-{part_number:05d}.jsonl.gz"
        name = next(
            name
            for name in self.client.fake_bucket.blobs
            if name.endswith(suffix)
        )
        return self.client.fake_bucket.blobs[name]

    def test_document_limit_flushes_multiple_records_as_jsonl(self):
        sink = self.make_sink()

        self.assertIsNone(sink.write(page_record(1)))
        uri = sink.write(page_record(2))

        self.assertEqual(
            uri,
            "gs://raw-crawler-data/raw/crawls/org_id=odido/"
            "crawl_date=2026-07-19/"
            "run_id=execution-abc/task=3/attempt=1/part-00000.jsonl.gz",
        )
        blob = self.part_blob()
        upload = blob.uploads[0]
        records = [
            json.loads(line)
            for line in gzip.decompress(upload["data"]).decode("utf-8").splitlines()
        ]

        self.assertEqual([record["doc_id"] for record in records], [
            "document-1",
            "document-2",
        ])
        self.assertEqual(records[0]["raw_text"], "raw page content 1")
        self.assertEqual(blob.content_encoding, "gzip")
        self.assertEqual(blob.metadata["document-count"], "2")
        self.assertEqual(blob.metadata["schema-version"], "2")
        self.assertEqual(blob.metadata["org-id"], "odido")
        self.assertEqual(upload["content_type"], "application/x-ndjson")
        self.assertEqual(upload["if_generation_match"], 0)
        self.assertIsNotNone(upload["retry"])

    def test_byte_limit_flushes_an_oversized_record(self):
        sink = self.make_sink(max_documents=100, max_bytes=20)

        uri = sink.write(page_record(raw_text="x" * 100))

        self.assertTrue(uri.endswith("part-00000.jsonl.gz"))
        self.assertEqual(len(self.client.fake_bucket.blobs), 1)

    def test_finalize_flushes_partial_batch_and_uploads_manifest(self):
        sink = self.make_sink(max_documents=100)
        sink.write(page_record())

        result = sink.finalize(
            {
                "schema_version": 2,
                "org_id": "odido",
                "status": "succeeded",
                "total_pages_scraped": 1,
            }
        )

        self.assertEqual(len(result["storage"]["objects"]), 1)
        stored_part = result["storage"]["objects"][0]
        self.assertEqual(stored_part["document_count"], 1)
        self.assertGreater(stored_part["uncompressed_bytes"], 0)
        self.assertGreater(stored_part["compressed_bytes"], 0)

        manifest_name = next(
            name
            for name in self.client.fake_bucket.blobs
            if name.endswith("_manifest.json")
        )
        manifest_blob = self.client.fake_bucket.blobs[manifest_name]
        uploaded_manifest = json.loads(manifest_blob.uploads[0]["data"])
        self.assertEqual(uploaded_manifest["status"], "succeeded")
        self.assertEqual(uploaded_manifest["org_id"], "odido")
        self.assertEqual(
            uploaded_manifest["storage"]["org_id"], "odido"
        )
        self.assertEqual(
            uploaded_manifest["storage"]["manifest_uri"],
            f"gs://raw-crawler-data/{manifest_name}",
        )
        self.assertEqual(
            manifest_blob.uploads[0]["content_type"], "application/json"
        )
        self.assertEqual(manifest_blob.uploads[0]["if_generation_match"], 0)
        self.assertEqual(manifest_blob.metadata["schema-version"], "2")
        self.assertEqual(manifest_blob.metadata["org-id"], "odido")

    def test_zero_result_crawl_still_uploads_a_manifest(self):
        sink = self.make_sink()

        result = sink.finalize(
            {
                "schema_version": 2,
                "org_id": "odido",
                "status": "succeeded",
                "total_pages_scraped": 0,
            }
        )

        self.assertEqual(result["storage"]["objects"], [])
        self.assertEqual(len(self.client.fake_bucket.blobs), 1)
        only_name = next(iter(self.client.fake_bucket.blobs))
        self.assertTrue(only_name.endswith("_manifest.json"))

    def test_failed_part_upload_does_not_create_a_success_manifest(self):
        client = FakeStorageClient(fail_suffix="part-00000.jsonl.gz")
        sink = self.make_sink(client=client, max_documents=1)

        with self.assertRaisesRegex(RuntimeError, "simulated permanent"):
            sink.write(page_record())

        self.assertEqual(len(client.fake_bucket.requested_names), 1)
        self.assertFalse(
            any(name.endswith("_manifest.json") for name in client.fake_bucket.blobs)
        )

    def test_identical_runs_are_partitioned_by_organization(self):
        first = self.make_sink(org_id="odido", max_documents=1)
        second = self.make_sink(org_id="demo_org", max_documents=1)

        first_uri = first.write(page_record(org_id="odido"))
        second_uri = second.write(page_record(org_id="demo_org"))

        self.assertIn("/org_id=odido/", first_uri)
        self.assertIn("/org_id=demo_org/", second_uri)
        self.assertNotEqual(first_uri, second_uri)

    def test_finalized_sink_rejects_more_writes(self):
        sink = self.make_sink()
        sink.finalize({"status": "succeeded"})

        with self.assertRaisesRegex(RuntimeError, "finalized"):
            sink.write(page_record())
        with self.assertRaisesRegex(RuntimeError, "already been finalized"):
            sink.finalize({"status": "succeeded"})


class LocalTextSinkTests(unittest.TestCase):
    def test_local_sink_preserves_text_files_and_summary(self):
        with tempfile.TemporaryDirectory() as directory:
            sink = LocalTextSink(directory)
            filepath = Path(sink.write(page_record()))
            result = sink.finalize(
                {"status": "succeeded", "total_pages_scraped": 1}
            )

            self.assertTrue(filepath.exists())
            self.assertIn("URL: http://page-1.example.onion/", filepath.read_text())
            self.assertIn("raw page content 1", filepath.read_text())
            summary_path = Path(directory) / "crawl_summary.json"
            self.assertTrue(summary_path.exists())
            self.assertEqual(result["storage"]["backend"], "local")
            self.assertEqual(json.loads(summary_path.read_text())["status"], "succeeded")


class OutputSinkFactoryTests(unittest.TestCase):
    def test_factory_defaults_to_local(self):
        with tempfile.TemporaryDirectory() as directory:
            sink = create_output_sink(directory, environ={})
            self.assertIsInstance(sink, LocalTextSink)

    def test_factory_builds_gcs_sink_from_environment(self):
        client = FakeStorageClient()
        sink = create_output_sink(
            "/unused",
            environ={
                "OUTPUT_BACKEND": "gcs",
                "ORG_ID": "odido",
                "GCS_BUCKET": "raw-crawler-data",
                "GCS_PREFIX": "landing",
                "GCS_BATCH_MAX_DOCUMENTS": "5",
                "GCS_BATCH_MAX_BYTES": "4096",
            },
            client=client,
        )

        self.assertIsInstance(sink, GcsJsonlSink)
        self.assertEqual(sink.max_documents, 5)
        self.assertEqual(sink.max_bytes, 4096)
        self.assertEqual(sink.org_id, "odido")
        self.assertTrue(
            sink.object_base.startswith(
                "landing/org_id=odido/crawl_date="
            )
        )

    def test_factory_rejects_missing_bucket_and_invalid_backend(self):
        with self.assertRaisesRegex(ValueError, "GCS_BUCKET is required"):
            create_output_sink("/unused", environ={"OUTPUT_BACKEND": "gcs"})

        with self.assertRaisesRegex(ValueError, "either 'local' or 'gcs'"):
            create_output_sink("/unused", environ={"OUTPUT_BACKEND": "unknown"})

    def test_factory_rejects_missing_and_invalid_org_id(self):
        base_environment = {
            "OUTPUT_BACKEND": "gcs",
            "GCS_BUCKET": "raw-crawler-data",
        }
        with self.assertRaisesRegex(ValueError, "org_id is required"):
            create_output_sink(
                "/unused",
                environ=base_environment,
                client=FakeStorageClient(),
            )

        with self.assertRaisesRegex(ValueError, "lowercase slug"):
            create_output_sink(
                "/unused",
                org_id="Odido",
                environ=base_environment,
                client=FakeStorageClient(),
            )

    def test_factory_rejects_invalid_batch_limits(self):
        with self.assertRaisesRegex(ValueError, "positive integer"):
            create_output_sink(
                "/unused",
                environ={
                    "OUTPUT_BACKEND": "gcs",
                    "ORG_ID": "odido",
                    "GCS_BUCKET": "raw-crawler-data",
                    "GCS_BATCH_MAX_DOCUMENTS": "0",
                },
                client=FakeStorageClient(),
            )


if __name__ == "__main__":
    unittest.main()
