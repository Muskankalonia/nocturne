"""Unit tests for the pure helpers in deploy_pipeline.py.

Only the functions that decide something are covered: how a SQL file is split
into statements, what object a statement creates, and how warehouse values are
rendered for the log. Everything else in that module talks to Snowflake, and a
test of a mocked cursor is a test of the mock.

The statement splitter earns the most attention here. It is the one piece
between "the SQL file on disk" and "what actually runs", and every failure mode
it has is silent: a mis-split file does not error, it deploys a fragment.
"""

import sys
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from deploy_pipeline import (  # noqa: E402
    _display_bool,
    _normalized_row,
    _object_from_statement,
    _truncated,
    _variant_array,
    parse_sql_statements,
)


class ParseSqlStatementsTest(unittest.TestCase):
    def setUp(self):
        self._tmp = Path(__file__).parent / "_tmp_sql"
        self._tmp.mkdir(exist_ok=True)

    def tearDown(self):
        for path in self._tmp.glob("*.sql"):
            path.unlink()
        self._tmp.rmdir()

    def _parse(self, sql: str) -> list[str]:
        path = self._tmp / "statements.sql"
        path.write_text(sql, encoding="utf-8")
        return parse_sql_statements(path)

    def test_splits_on_semicolons(self):
        self.assertEqual(
            self._parse("SELECT 1;\nSELECT 2;\n"),
            ["SELECT 1", "SELECT 2"],
        )

    def test_strips_full_line_comments(self):
        self.assertEqual(
            self._parse("-- explain the next bit\nSELECT 1;\n"),
            ["SELECT 1"],
        )

    def test_keeps_a_trailing_statement_with_no_semicolon(self):
        self.assertEqual(self._parse("SELECT 1"), ["SELECT 1"])

    def test_ignores_blank_input(self):
        self.assertEqual(self._parse("\n\n   \n"), [])
        self.assertEqual(self._parse("-- only a comment\n"), [])

    def test_does_not_split_inside_a_dollar_block(self):
        # A Python UDF body is full of semicolons. Splitting on them would
        # deploy the first two lines of the function and then fail on the rest.
        sql = (
            "CREATE FUNCTION f() RETURNS STRING LANGUAGE PYTHON AS $$\n"
            "import re;\n"
            "def handler(x):\n"
            "    y = x.strip();\n"
            "    return y;\n"
            "$$;\n"
            "SELECT 2;\n"
        )
        statements = self._parse(sql)
        self.assertEqual(len(statements), 2)
        self.assertIn("def handler(x)", statements[0])
        self.assertEqual(statements[1], "SELECT 2")

    def test_keeps_comment_lines_that_live_inside_a_dollar_block(self):
        # "--" is a comment in SQL but a decrement in a UDF body. Stripping it
        # inside $$ would silently rewrite the function.
        sql = (
            "CREATE FUNCTION f() RETURNS STRING AS $$\n"
            "-- this line is part of the body\n"
            "$$;\n"
        )
        self.assertIn("-- this line is part of the body", self._parse(sql)[0])

    def test_handles_a_dollar_block_opened_and_closed_on_one_line(self):
        self.assertEqual(
            self._parse("CREATE FUNCTION f() AS $$ return 1 $$;\nSELECT 2;\n"),
            ["CREATE FUNCTION f() AS $$ return 1 $$", "SELECT 2"],
        )

    def test_drops_the_trailing_semicolon_but_not_inner_ones(self):
        self.assertEqual(self._parse("SELECT 'a;b';"), ["SELECT 'a;b'"])

    def test_parses_a_real_pipeline_file_into_runnable_statements(self):
        # The deployer's contract with the repo: every shipped .sql file has to
        # split into at least one statement and never into an empty fragment.
        for path in sorted((PROJECT_ROOT / "snowflake").glob("*.sql")):
            with self.subTest(sql_file=path.name):
                statements = parse_sql_statements(path)
                self.assertGreater(len(statements), 0)
                self.assertTrue(all(s.strip() for s in statements))


class ObjectFromStatementTest(unittest.TestCase):
    def test_names_the_object_a_statement_creates(self):
        self.assertEqual(
            _object_from_statement(
                "create or replace dynamic table nocturne.raw.dt_regex_indicators as select 1",
                "TABLE",
            ),
            "NOCTURNE.RAW.DT_REGEX_INDICATORS",
        )

    def test_looks_past_an_if_not_exists_clause(self):
        self.assertEqual(
            _object_from_statement("CREATE SCHEMA IF NOT EXISTS NOCTURNE.RAW", "SCHEMA"),
            "NOCTURNE.RAW",
        )

    def test_collapses_whitespace_before_matching(self):
        self.assertEqual(
            _object_from_statement("CREATE\n  TASK\n    MY_TASK", "TASK"),
            "MY_TASK",
        )

    def test_returns_none_when_the_kind_is_absent(self):
        self.assertIsNone(_object_from_statement("SELECT 1", "TABLE"))


class VariantArrayTest(unittest.TestCase):
    def test_passes_through_a_real_list(self):
        self.assertEqual(_variant_array(["a", "b"]), ["a", "b"])

    def test_converts_a_tuple(self):
        self.assertEqual(_variant_array(("a",)), ["a"])

    def test_parses_the_json_text_the_connector_returns_for_an_array(self):
        self.assertEqual(_variant_array('["a", "b"]'), ["a", "b"])

    def test_is_empty_for_null_and_for_unparseable_input(self):
        # A VARIANT column that failed to parse must read as "no elements",
        # never as a one-element list containing the raw text.
        self.assertEqual(_variant_array(None), [])
        self.assertEqual(_variant_array("not json"), [])
        self.assertEqual(_variant_array('{"a": 1}'), [])
        self.assertEqual(_variant_array(42), [])


class DisplayBoolTest(unittest.TestCase):
    def test_distinguishes_unknown_from_false(self):
        # A suspended task and a task whose state could not be read are
        # different findings in the go-live log.
        self.assertEqual(_display_bool(None), "unknown")
        self.assertEqual(_display_bool(False), "false")

    def test_reads_the_string_forms_snowflake_returns(self):
        for truthy in ("true", "TRUE", "Yes", "1"):
            self.assertEqual(_display_bool(truthy), "true")
        for falsy in ("false", "FALSE", "No", "0"):
            self.assertEqual(_display_bool(falsy), "false")

    def test_falls_back_to_python_truthiness(self):
        self.assertEqual(_display_bool(1), "true")
        self.assertEqual(_display_bool(0), "false")
        self.assertEqual(_display_bool("something else"), "true")
        self.assertEqual(_display_bool(""), "false")


class TruncatedTest(unittest.TestCase):
    def test_collapses_whitespace(self):
        self.assertEqual(_truncated("a\n\tb   c"), "a b c")

    def test_is_empty_for_none(self):
        self.assertEqual(_truncated(None), "")

    def test_leaves_a_short_value_intact(self):
        self.assertEqual(_truncated("short", limit=10), "short")

    def test_elides_at_the_limit(self):
        result = _truncated("x" * 300, limit=10)
        self.assertEqual(len(result), 10)
        self.assertTrue(result.endswith("…"))

    def test_does_not_elide_a_value_exactly_at_the_limit(self):
        self.assertEqual(_truncated("x" * 10, limit=10), "x" * 10)


class NormalizedRowTest(unittest.TestCase):
    def test_upper_cases_every_key(self):
        # Snowflake returns unquoted identifiers upper-cased but quoted ones as
        # written, so callers cannot rely on the case they asked for.
        self.assertEqual(
            _normalized_row({"org_id": "acme", "Name": "Acme"}),
            {"ORG_ID": "acme", "NAME": "Acme"},
        )

    def test_leaves_values_untouched(self):
        self.assertEqual(_normalized_row({"n": None}), {"N": None})

    def test_handles_an_empty_row(self):
        self.assertEqual(_normalized_row({}), {})


if __name__ == "__main__":
    unittest.main()
