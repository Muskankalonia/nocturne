"""Unit tests for the pure helpers in nocturne_crawler.scraper.

The crawler's decisions about *what to keep* live in these functions, and every
one of them fails quietly. A keyword matcher that is too loose fills RAW with
pages about other companies; one that is too tight returns an empty run that
looks like "nothing was leaked". Neither raises.

Nothing here drives Selenium or Tor. The functions under test take strings and
return strings, which is exactly why they are worth pinning.
"""

import hashlib
import sys
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT / "src"))

from bs4 import BeautifulSoup  # noqa: E402

from nocturne_crawler import scraper  # noqa: E402


class EnvIntTest(unittest.TestCase):
    def tearDown(self):
        import os
        os.environ.pop("NOCTURNE_TEST_INT", None)

    def test_returns_the_default_when_unset(self):
        self.assertEqual(scraper.env_int("NOCTURNE_TEST_INT", 7, 0), 7)

    def test_reads_an_override(self):
        import os
        os.environ["NOCTURNE_TEST_INT"] = "12"
        self.assertEqual(scraper.env_int("NOCTURNE_TEST_INT", 7, 0), 12)

    def test_rejects_a_non_integer(self):
        import os
        os.environ["NOCTURNE_TEST_INT"] = "lots"
        with self.assertRaises(ValueError):
            scraper.env_int("NOCTURNE_TEST_INT", 7, 0)

    def test_enforces_the_minimum(self):
        # MAX_PAGES=0 would dispatch a container that crawls nothing.
        import os
        os.environ["NOCTURNE_TEST_INT"] = "0"
        with self.assertRaises(ValueError):
            scraper.env_int("NOCTURNE_TEST_INT", 7, 1)


class EnvListTest(unittest.TestCase):
    def tearDown(self):
        import os
        os.environ.pop("NOCTURNE_TEST_LIST", None)

    def test_falls_back_to_the_config_value(self):
        self.assertEqual(scraper.env_list("NOCTURNE_TEST_LIST", ["a", "b"]), ["a", "b"])

    def test_treats_a_missing_fallback_as_empty(self):
        self.assertEqual(scraper.env_list("NOCTURNE_TEST_LIST", None), [])

    def test_splits_on_commas_and_newlines(self):
        import os
        os.environ["NOCTURNE_TEST_LIST"] = "a, b\nc,,d"
        self.assertEqual(scraper.env_list("NOCTURNE_TEST_LIST", []), ["a", "b", "c", "d"])

    def test_an_explicit_empty_override_wins_over_the_fallback(self):
        import os
        os.environ["NOCTURNE_TEST_LIST"] = ""
        self.assertEqual(scraper.env_list("NOCTURNE_TEST_LIST", ["a"]), [])


class CleanKeywordTest(unittest.TestCase):
    def test_lowercases_and_strips_quotes(self):
        self.assertEqual(scraper.clean_keyword('  "Acme Corp" '), "acme corp")
        self.assertEqual(scraper.clean_keyword("'acme'"), "acme")

    def test_stringifies_non_strings(self):
        self.assertEqual(scraper.clean_keyword(42), "42")


class UniqueKeywordsTest(unittest.TestCase):
    def test_deduplicates_while_preserving_order(self):
        self.assertEqual(
            scraper.unique_keywords(["Acme", "acme", "leak", "ACME"]),
            ["acme", "leak"],
        )

    def test_drops_blanks(self):
        self.assertEqual(scraper.unique_keywords(["", "  ", "acme"]), ["acme"])


class KeywordInTextTest(unittest.TestCase):
    def test_matches_a_whole_word(self):
        self.assertTrue(scraper.keyword_in_text("sale", "database for sale here"))

    def test_does_not_match_inside_a_longer_word(self):
        # The reason this function exists: "sale" matching "Salesforce" turned
        # every vendor page into a false leak signal.
        self.assertFalse(scraper.keyword_in_text("sale", "we use salesforce daily"))
        self.assertFalse(scraper.keyword_in_text("acme", "acmecorp"))

    def test_allows_adjacent_punctuation(self):
        self.assertTrue(scraper.keyword_in_text("sale", "for sale, cheap"))
        self.assertTrue(scraper.keyword_in_text("dump", "(dump)"))

    def test_treats_domains_and_phrases_as_substring_anchors(self):
        # A domain has dots, so word boundaries would never fire on it.
        self.assertTrue(scraper.keyword_in_text("acme.com", "mail@acme.com listed"))
        self.assertTrue(scraper.keyword_in_text("acme corp", "the acme corporation"))
        self.assertTrue(scraper.keyword_in_text("a/b", "path a/b here"))

    def test_is_false_for_an_empty_keyword(self):
        self.assertFalse(scraper.keyword_in_text("", "anything"))


class KeywordMatchTest(unittest.TestCase):
    """keyword_match reads module-level keyword globals, so they are swapped."""

    def setUp(self):
        self._saved = (scraper.KEYWORDS, scraper.TARGET_KEYWORDS, scraper.LEAK_KEYWORDS)

    def tearDown(self):
        scraper.KEYWORDS, scraper.TARGET_KEYWORDS, scraper.LEAK_KEYWORDS = self._saved

    def _configure(self, keywords, targets, leaks):
        scraper.KEYWORDS = keywords
        scraper.TARGET_KEYWORDS = targets
        scraper.LEAK_KEYWORDS = leaks

    def test_saves_everything_when_no_keywords_are_configured(self):
        self._configure([], [], [])
        matched, hits = scraper.keyword_match("anything at all")
        self.assertTrue(matched)
        self.assertEqual(hits, [])

    def test_requires_both_a_target_anchor_and_a_leak_signal(self):
        # An organization-scoped scan must not store a page that merely names
        # the company, nor a generic breach thread about someone else.
        self._configure(["acme", "dump"], ["acme"], ["dump"])
        self.assertTrue(scraper.keyword_match("acme database dump for sale")[0])
        self.assertFalse(scraper.keyword_match("acme announces quarterly results")[0])
        self.assertFalse(scraper.keyword_match("big database dump from someone")[0])

    def test_reports_every_matched_keyword_once(self):
        self._configure(["acme", "dump"], ["acme"], ["dump"])
        _, hits = scraper.keyword_match("acme dump, acme dump again")
        self.assertEqual(sorted(hits), ["acme", "dump"])

    def test_falls_back_to_any_keyword_when_the_split_is_unavailable(self):
        # Local ad-hoc crawls have no target/leak split configured, and should
        # not suddenly start saving nothing.
        self._configure(["acme"], [], [])
        self.assertTrue(scraper.keyword_match("acme mentioned here")[0])
        self.assertFalse(scraper.keyword_match("nothing relevant")[0])


class CanonicalizeUrlTest(unittest.TestCase):
    def test_lowercases_scheme_and_host_but_not_path(self):
        # Onion paths are case-sensitive; hosts are not.
        self.assertEqual(
            scraper.canonicalize_url("HTTP://ABC.onion/Thread/A"),
            "http://abc.onion/Thread/A",
        )

    def test_drops_the_fragment_but_keeps_the_query(self):
        # A fragment is client-side only, so two URLs differing only there are
        # the same page and must dedupe to one.
        self.assertEqual(
            scraper.canonicalize_url("http://abc.onion/t?id=1#reply-9"),
            "http://abc.onion/t?id=1",
        )

    def test_supplies_a_root_path_when_there_is_none(self):
        self.assertEqual(scraper.canonicalize_url("http://abc.onion"), "http://abc.onion/")

    def test_strips_surrounding_whitespace(self):
        self.assertEqual(scraper.canonicalize_url("  http://abc.onion/  "), "http://abc.onion/")


class Sha256PartsTest(unittest.TestCase):
    def test_is_stable_for_the_same_parts(self):
        self.assertEqual(scraper.sha256_parts("a", "b"), scraper.sha256_parts("a", "b"))

    def test_separates_parts_so_boundaries_cannot_be_shifted(self):
        # Without a separator, ("ab", "c") and ("a", "bc") would collide, and
        # DEDUPE_KEY is built from org_id plus URL.
        self.assertNotEqual(scraper.sha256_parts("ab", "c"), scraper.sha256_parts("a", "bc"))

    def test_returns_a_full_hex_digest(self):
        digest = scraper.sha256_parts("a")
        self.assertEqual(len(digest), 64)
        self.assertEqual(digest, hashlib.sha256(b"a").hexdigest())


class VisibleTextTest(unittest.TestCase):
    def test_drops_script_and_style_bodies(self):
        # Otherwise minified JS becomes "page text" and matches leak keywords
        # that no human ever saw.
        text = scraper.visible_text(
            "<html><style>.a{}</style><script>var dump='x';</script><p>Hello</p></html>"
        )
        self.assertEqual(text, "Hello")

    def test_joins_blocks_with_a_separator(self):
        self.assertEqual(scraper.visible_text("<p>a</p><p>b</p>"), "a b")


class ErrorAndInterstitialTest(unittest.TestCase):
    def test_recognises_a_configured_error_marker(self):
        marker = scraper.ERROR_MARKERS[0]
        self.assertTrue(scraper.is_error_page(f"<html>{marker}</html>"))

    def test_an_ordinary_page_is_not_an_error(self):
        self.assertFalse(scraper.is_error_page("<html><p>a forum thread</p></html>"))

    def test_only_the_head_of_a_page_counts_as_an_interstitial(self):
        # A forum thread quoting "please do not refresh" further down is
        # content, not a queue — waiting on it would burn the runtime budget.
        filler = "<p>" + ("word " * 400) + "</p>"
        self.assertFalse(
            scraper.looks_like_interstitial(f"<html>{filler}<p>please do not refresh</p></html>")
        )


class ExtractOnionLinksTest(unittest.TestCase):
    def _links(self, html, current_url="http://aaa.onion/forum/"):
        return scraper.extract_onion_links(BeautifulSoup(html, "html.parser"), current_url)

    def test_resolves_a_host_relative_link_against_the_current_page(self):
        # Forums link internally with paths like "/d/DataBrokers", which carry
        # no hostname. Matching only hrefs containing ".onion" meant the
        # crawler could move between sites but never within one.
        self.assertIn(
            "http://aaa.onion/d/DataBrokers",
            self._links('<a href="/d/DataBrokers">x</a>'),
        )

    def test_follows_a_link_to_another_onion_service(self):
        self.assertIn(
            "http://bbb.onion/thread",
            self._links('<a href="http://bbb.onion/thread">x</a>'),
        )

    def test_refuses_to_leave_tor_for_the_clearnet(self):
        self.assertEqual(self._links('<a href="https://example.com/x">x</a>'), set())

    def test_skips_non_navigational_hrefs(self):
        html = (
            '<a href="#top">a</a><a href="mailto:x@y.z">b</a>'
            '<a href="javascript:void(0)">c</a><a href="data:text/html,x">d</a>'
            '<a href="tel:+1">e</a><a href="">f</a>'
        )
        self.assertEqual(self._links(html), set())

    def test_drops_the_fragment_when_normalising(self):
        self.assertEqual(
            self._links('<a href="/t?id=1#reply">x</a>'),
            {"http://aaa.onion/t?id=1"},
        )

    def test_deduplicates_links_to_the_same_page(self):
        html = '<a href="/t">a</a><a href="/t#x">b</a><a href="http://aaa.onion/t">c</a>'
        self.assertEqual(self._links(html), {"http://aaa.onion/t"})


class BuildPageRecordTest(unittest.TestCase):
    def _record(self, **overrides):
        kwargs = dict(
            run_id="nocturne-crawler-x8svq",
            url="HTTP://ABC.onion/Thread/1#reply",
            title="Acme dump",
            text="acme database dump",
            depth=1,
            matched_keywords=["acme", "dump"],
            links_found=3,
            source="ahmia",
        )
        kwargs.update(overrides)
        return scraper.build_page_record(**kwargs)

    def test_emits_the_schema_v2_contract_the_copy_expects(self):
        record = self._record()
        for field in (
            "schema_version", "org_id", "doc_id", "dedupe_key", "run_id", "source",
            "query", "url", "title", "fetched_at", "depth", "keywords_matched",
            "links_found", "content_length", "content_sha256", "raw_text",
        ):
            self.assertIn(field, record)
        self.assertEqual(record["schema_version"], 2)

    def test_keeps_the_url_as_found_but_dedupes_on_the_canonical_form(self):
        # RUN_ID plus DEDUPE_KEY is what the console joins on to count a run
        # through the cascade, so two spellings of one page must collapse.
        first = self._record(url="HTTP://ABC.onion/Thread/1#reply")
        second = self._record(url="http://abc.onion/Thread/1")
        self.assertEqual(first["url"], "HTTP://ABC.onion/Thread/1#reply")
        self.assertEqual(first["dedupe_key"], second["dedupe_key"])

    def test_hashes_the_content_so_mirrors_do_not_count_as_corroboration(self):
        same = self._record(url="http://aaa.onion/a")
        mirror = self._record(url="http://bbb.onion/b")
        self.assertEqual(same["content_sha256"], mirror["content_sha256"])
        self.assertNotEqual(same["dedupe_key"], mirror["dedupe_key"])

    def test_reports_the_content_length_in_characters(self):
        self.assertEqual(self._record(text="abcde")["content_length"], 5)

    def test_records_the_engine_that_seeded_the_page(self):
        self.assertEqual(self._record(source="dread")["source"], "dread")

    def test_the_source_default_is_unusable_and_every_caller_must_pass_one(self):
        # Latent defect, pinned rather than worked around: the `source=None`
        # default falls back to a global named SEARCH_ENGINE, which does not
        # exist — the module defines SEARCH_ENGINES (plural). bfs_crawl always
        # passes a real engine, so the path is dead in production, but the
        # signature advertises a default that raises. This test fails the day
        # someone fixes the name, which is the point.
        with self.assertRaises(NameError):
            self._record(source=None)


class FormatUtcTest(unittest.TestCase):
    def test_renders_a_utc_instant(self):
        from datetime import datetime, timezone
        stamped = scraper.format_utc(datetime(2026, 8, 18, 10, 0, 0, tzinfo=timezone.utc))
        self.assertTrue(stamped.startswith("2026-08-18"))

    def test_utc_now_is_timezone_aware(self):
        # A naive timestamp would land in Snowflake shifted by the runner's
        # local offset.
        self.assertIsNotNone(scraper.utc_now().tzinfo)


class RuntimeBudgetTest(unittest.TestCase):
    def test_no_deadline_means_unlimited_budget(self):
        self.assertTrue(scraper.has_runtime_budget(None))

    def test_a_passed_deadline_leaves_nothing(self):
        import time
        self.assertEqual(scraper.runtime_remaining(time.monotonic() - 5), 0)
        self.assertFalse(scraper.has_runtime_budget(time.monotonic() - 5))

    def test_a_future_deadline_leaves_budget(self):
        import time
        self.assertGreater(scraper.runtime_remaining(time.monotonic() + 30), 0)
        self.assertTrue(scraper.has_runtime_budget(time.monotonic() + 30))


if __name__ == "__main__":
    unittest.main()
