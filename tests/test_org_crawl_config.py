"""Unit tests for scripts/org_crawl_config.py.

This script is the bridge between what an analyst types on the Monitored Assets
page and what a crawl actually searches for. Getting build_query wrong does not
raise — it returns a query that quietly matches nothing, and the run comes back
with zero pages and no explanation.
"""

import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT / "scripts"))

import org_crawl_config  # noqa: E402
from org_crawl_config import (  # noqa: E402
    ORG_ID_PATTERN,
    as_list,
    build_keywords,
    build_query,
    fetch_organization,
    load_env_file,
    required_env,
)


class FakeCursor:
    """Stands in for a Snowflake DictCursor."""

    def __init__(self, row):
        self._row = row
        self.closed = False
        self.executed = None

    def execute(self, sql, params=None):
        self.executed = (sql, params)

    def fetchone(self):
        return self._row

    def close(self):
        self.closed = True


class FakeConnection:
    def __init__(self, row):
        self.cursor_obj = FakeCursor(row)
        self.closed = False

    def cursor(self, _kind=None):
        return self.cursor_obj

    def close(self):
        self.closed = True


class AsListTest(unittest.TestCase):
    def test_passes_through_a_real_list(self):
        self.assertEqual(as_list(["a", "b"]), ["a", "b"])

    def test_parses_the_json_text_the_connector_returns(self):
        # Snowflake ARRAY columns arrive as JSON text through the connector.
        self.assertEqual(as_list('["a", "b"]'), ["a", "b"])

    def test_wraps_a_bare_string_that_is_not_json(self):
        # A single alias typed without brackets is still one alias, not zero.
        self.assertEqual(as_list("acme"), ["acme"])

    def test_wraps_a_json_scalar(self):
        self.assertEqual(as_list('"acme"'), ["acme"])

    def test_is_empty_for_null_and_blank(self):
        self.assertEqual(as_list(None), [])
        self.assertEqual(as_list(""), [])
        self.assertEqual(as_list("   "), [])

    def test_stringifies_non_string_elements(self):
        self.assertEqual(as_list([1, 2]), ["1", "2"])


class BuildQueryTest(unittest.TestCase):
    def test_quotes_the_canonical_name(self):
        # Quoted so a multi-word name cannot match on one of its words.
        self.assertEqual(build_query({"CANONICAL_NAME": "Acme Corp"}), '"Acme Corp"')

    def test_falls_back_to_an_alias_then_a_domain(self):
        self.assertEqual(
            build_query({"CANONICAL_NAME": "", "ALIASES": '["acme"]'}),
            '"acme"',
        )
        self.assertEqual(
            build_query({"CANONICAL_NAME": None, "DOMAINS": '["acme.com"]'}),
            '"acme.com"',
        )

    def test_uses_exactly_one_term(self):
        # Neither Ahmia nor Dread treats OR as a boolean operator, so joining
        # aliases narrowed the results instead of widening them — Ahmia
        # returned nothing at all. Relevance comes from the keyword filter.
        query = build_query(
            {"CANONICAL_NAME": "Acme Corp", "ALIASES": '["acme"]', "DOMAINS": '["acme.com"]'}
        )
        self.assertEqual(query, '"Acme Corp"')
        self.assertNotIn("OR", query)

    def test_skips_whitespace_only_terms(self):
        self.assertEqual(
            build_query({"CANONICAL_NAME": "   ", "ALIASES": '["acme"]'}),
            '"acme"',
        )

    def test_refuses_an_organization_with_nothing_to_search_for(self):
        # Better to stop than to dispatch a crawl that cannot match anything.
        with self.assertRaises(SystemExit):
            build_query({"ORG_ID": "empty_org"})


class BuildKeywordsTest(unittest.TestCase):
    def test_joins_every_profile_field(self):
        self.assertEqual(
            build_keywords(
                {
                    "CANONICAL_NAME": "Acme Corp",
                    "ALIASES": '["acme"]',
                    "DOMAINS": '["acme.com"]',
                    "PRODUCTS": '["Anvil"]',
                }
            ),
            "Acme Corp,acme,acme.com,Anvil",
        )

    def test_includes_products_even_though_the_query_does_not(self):
        # Products make a page recognisably about this organization once
        # fetched, while searching for them alone surfaces unrelated chatter.
        keywords = build_keywords({"CANONICAL_NAME": "Acme", "PRODUCTS": '["Anvil"]'})
        self.assertIn("Anvil", keywords)
        self.assertNotIn("Anvil", build_query({"CANONICAL_NAME": "Acme", "PRODUCTS": '["Anvil"]'}))

    def test_deduplicates_case_insensitively_keeping_first_spelling(self):
        self.assertEqual(
            build_keywords({"CANONICAL_NAME": "Acme", "ALIASES": '["ACME", "acme"]'}),
            "Acme",
        )

    def test_is_empty_for_an_empty_profile(self):
        self.assertEqual(build_keywords({}), "")


class OrgIdPatternTest(unittest.TestCase):
    def test_accepts_the_slug_form_the_console_writes(self):
        for org_id in ("acme", "acme_corp", "european_commission", "org2", "a1_b2"):
            self.assertRegex(org_id, ORG_ID_PATTERN)

    def test_rejects_anything_that_could_be_an_injection_or_a_path(self):
        for org_id in ("Acme", "acme-corp", "acme_", "_acme", "acme corp",
                       "acme;drop", "../etc", "", "acme__corp"):
            with self.subTest(org_id=org_id):
                self.assertIsNone(ORG_ID_PATTERN.match(org_id))


class LoadEnvFileTest(unittest.TestCase):
    def setUp(self):
        self._dir = tempfile.TemporaryDirectory()
        self.path = Path(self._dir.name) / ".env"
        self._saved = dict(os.environ)

    def tearDown(self):
        self._dir.cleanup()
        os.environ.clear()
        os.environ.update(self._saved)

    def test_a_missing_file_is_not_an_error(self):
        # A local .env is a convenience, not a requirement.
        load_env_file(Path(self._dir.name) / "absent")

    def test_reads_key_value_pairs_and_strips_quotes(self):
        self.path.write_text('NOCTURNE_T_A="one"\nNOCTURNE_T_B=\'two\'\n')
        load_env_file(self.path)
        self.assertEqual(os.environ["NOCTURNE_T_A"], "one")
        self.assertEqual(os.environ["NOCTURNE_T_B"], "two")

    def test_skips_comments_blanks_and_malformed_lines(self):
        self.path.write_text("# a comment\n\nNOT_A_PAIR\nNOCTURNE_T_C=three\n")
        load_env_file(self.path)
        self.assertEqual(os.environ["NOCTURNE_T_C"], "three")
        self.assertNotIn("NOT_A_PAIR", os.environ)

    def test_never_overrides_an_existing_variable(self):
        # The real environment wins: a stale .env must not silently replace
        # credentials the caller exported deliberately.
        os.environ["NOCTURNE_T_D"] = "from-environment"
        self.path.write_text("NOCTURNE_T_D=from-file\n")
        load_env_file(self.path)
        self.assertEqual(os.environ["NOCTURNE_T_D"], "from-environment")


class RequiredEnvTest(unittest.TestCase):
    def tearDown(self):
        os.environ.pop("NOCTURNE_T_REQ", None)

    def test_returns_a_set_value(self):
        os.environ["NOCTURNE_T_REQ"] = " value "
        self.assertEqual(required_env("NOCTURNE_T_REQ"), "value")

    def test_exits_naming_the_variable(self):
        with self.assertRaises(SystemExit) as raised:
            required_env("NOCTURNE_T_REQ")
        self.assertIn("NOCTURNE_T_REQ", str(raised.exception))

    def test_treats_whitespace_as_unset(self):
        os.environ["NOCTURNE_T_REQ"] = "   "
        with self.assertRaises(SystemExit):
            required_env("NOCTURNE_T_REQ")


class ConnectTest(unittest.TestCase):
    def setUp(self):
        self._saved = dict(os.environ)
        for key in ("SNOWFLAKE_TOKEN", "SNOWFLAKE_PASSWORD"):
            os.environ.pop(key, None)
        os.environ["SNOWFLAKE_ACCOUNT"] = "acct"
        os.environ["SNOWFLAKE_USER"] = "user"

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self._saved)

    def test_refuses_to_connect_with_no_credential(self):
        with self.assertRaises(SystemExit):
            org_crawl_config.connect()

    def test_prefers_a_programmatic_access_token(self):
        os.environ["SNOWFLAKE_TOKEN"] = "pat"
        os.environ["SNOWFLAKE_PASSWORD"] = "pw"
        with mock.patch.object(org_crawl_config.snowflake.connector, "connect") as connect:
            org_crawl_config.connect()
        kwargs = connect.call_args.kwargs
        self.assertEqual(kwargs["authenticator"], "PROGRAMMATIC_ACCESS_TOKEN")
        self.assertNotIn("password", kwargs)

    def test_falls_back_to_a_password(self):
        os.environ["SNOWFLAKE_PASSWORD"] = "pw"
        with mock.patch.object(org_crawl_config.snowflake.connector, "connect") as connect:
            org_crawl_config.connect()
        self.assertEqual(connect.call_args.kwargs["password"], "pw")

    def test_reads_the_config_schema_under_a_traceable_query_tag(self):
        os.environ["SNOWFLAKE_TOKEN"] = "pat"
        with mock.patch.object(org_crawl_config.snowflake.connector, "connect") as connect:
            org_crawl_config.connect()
        kwargs = connect.call_args.kwargs
        self.assertEqual(kwargs["schema"], "CONFIG")
        self.assertEqual(
            kwargs["session_parameters"]["QUERY_TAG"], "NOCTURNE_CRAWLER_CONFIG_READ"
        )


class FetchOrganizationTest(unittest.TestCase):
    def test_returns_the_row_and_closes_the_cursor(self):
        conn = FakeConnection({"ORG_ID": "acme"})
        self.assertEqual(fetch_organization(conn, "acme"), {"ORG_ID": "acme"})
        self.assertTrue(conn.cursor_obj.closed)

    def test_binds_the_org_id_rather_than_interpolating_it(self):
        # The slug reaches this query from an argument, so it is bound.
        conn = FakeConnection({"ORG_ID": "acme"})
        fetch_organization(conn, "acme")
        sql, params = conn.cursor_obj.executed
        self.assertEqual(params, ("acme",))
        self.assertNotIn("acme", sql)

    def test_exits_when_the_organization_is_not_monitored(self):
        conn = FakeConnection(None)
        with self.assertRaises(SystemExit):
            fetch_organization(conn, "ghost")
        self.assertTrue(conn.cursor_obj.closed)


class MainTest(unittest.TestCase):
    ROW = {
        "ORG_ID": "acme_corp",
        "CANONICAL_NAME": "Acme Corp",
        "ALIASES": '["acme"]',
        "DOMAINS": '["acme.com"]',
        "PRODUCTS": '["Anvil"]',
        "ENABLED": "true",
    }

    def _run(self, argv, row=None):
        conn = FakeConnection(self.ROW if row is None else row)
        buffer = io.StringIO()
        with mock.patch.object(sys, "argv", ["org_crawl_config.py", *argv]), \
                mock.patch.object(org_crawl_config, "connect", return_value=conn), \
                mock.patch.object(org_crawl_config, "load_env_file"), \
                redirect_stdout(buffer):
            code = org_crawl_config.main()
        return code, buffer.getvalue(), conn

    def test_emits_shell_quoted_env_lines(self):
        code, output, conn = self._run(["--org-id", "acme_corp"])
        self.assertEqual(code, 0)
        self.assertIn("ORG_ID=acme_corp", output)
        self.assertIn("QUERY=", output)
        self.assertIn("KEYWORDS=", output)
        self.assertTrue(conn.closed)

    def test_shell_quotes_a_query_containing_spaces(self):
        # The documented usage is `eval "$(...)"`, so an unquoted multi-word
        # name would split into separate shell words.
        _, output, _ = self._run(["--org-id", "acme_corp"])
        query_line = next(line for line in output.splitlines() if line.startswith("QUERY="))
        self.assertIn("'\"Acme Corp\"'", query_line)

    def test_emits_the_resolved_profile_as_json(self):
        _, output, _ = self._run(["--org-id", "acme_corp", "--format", "json"])
        parsed = json.loads(output)
        self.assertEqual(parsed["org_id"], "acme_corp")
        self.assertEqual(parsed["aliases"], ["acme"])
        self.assertEqual(parsed["products"], ["Anvil"])
        self.assertTrue(parsed["enabled"])
        self.assertEqual(parsed["query"], '"Acme Corp"')

    def test_emits_an_empty_keyword_list_rather_than_one_empty_string(self):
        row = {"ORG_ID": "bare", "CANONICAL_NAME": "", "DOMAINS": '["bare.com"]', "ENABLED": "true"}
        _, output, _ = self._run(["--org-id", "bare", "--format", "json"], row)
        self.assertEqual(json.loads(output)["keywords"], ["bare.com"])

    def test_refuses_an_org_id_that_is_not_a_slug(self):
        # The slug reaches a GCS object path and a Snowflake filter, so it is
        # validated before anything is opened.
        for bad in ("../etc", "Acme", "acme;drop"):
            with self.subTest(org_id=bad), self.assertRaises(SystemExit):
                self._run(["--org-id", bad])

    def test_refuses_to_emit_config_for_paused_monitoring(self):
        # Paused monitoring is a deliberate state; crawling anyway spends money
        # collecting pages the pipeline is configured to ignore.
        row = {**self.ROW, "ENABLED": "false"}
        with self.assertRaises(SystemExit) as raised:
            self._run(["--org-id", "acme_corp"], row)
        self.assertIn("--allow-disabled", str(raised.exception))

    def test_allow_disabled_overrides_the_pause(self):
        row = {**self.ROW, "ENABLED": "false"}
        code, output, _ = self._run(["--org-id", "acme_corp", "--allow-disabled"], row)
        self.assertEqual(code, 0)
        self.assertIn("ORG_ID=acme_corp", output)

    def test_closes_the_connection_even_when_the_lookup_fails(self):
        conn = FakeConnection(None)
        with mock.patch.object(sys, "argv", ["x", "--org-id", "ghost"]), \
                mock.patch.object(org_crawl_config, "connect", return_value=conn), \
                mock.patch.object(org_crawl_config, "load_env_file"), \
                self.assertRaises(SystemExit):
            org_crawl_config.main()
        self.assertTrue(conn.closed)


if __name__ == "__main__":
    unittest.main()
