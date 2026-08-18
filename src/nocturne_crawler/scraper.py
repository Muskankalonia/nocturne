import hashlib
import os
import re
import socket
import sys
import time
import uuid
from collections import Counter, deque
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, quote, urljoin, urlparse, urlsplit, urlunsplit

import yaml
from bs4 import BeautifulSoup
from selenium import webdriver
from selenium.webdriver.chrome.options import Options as ChromeOptions
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys

from .storage import create_output_sink


# Load config
DEFAULT_CONFIG_PATH = Path(__file__).resolve().parents[2] / "config.yaml"
CONFIG_PATH = Path(os.getenv("CONFIG_PATH", DEFAULT_CONFIG_PATH))
with CONFIG_PATH.open("r", encoding="utf-8") as config_file:
    config = yaml.safe_load(config_file) or {}


def env_int(name, default, minimum):
    raw_value = os.getenv(name)
    if raw_value is None:
        return default
    try:
        value = int(raw_value)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer") from exc
    if value < minimum:
        raise ValueError(f"{name} must be at least {minimum}")
    return value


OUTPUT_DIR = os.getenv("OUTPUT_DIR", "/tmp/scraped_pages")
MAX_DEPTH = env_int("MAX_DEPTH", config.get("max_depth", 2), 0)
# Per-engine budget. The BFS frontier is one FIFO queue, so a global budget
# would let whichever engine is queried first spend all of it: Ahmia routinely
# returns dozens of mirror hosts, which would starve Dread of the budget
# entirely even though Dread carries the leak threads worth having.
MAX_PAGES = env_int("MAX_PAGES", config.get("max_pages", 30), 1)
MAX_VISITED_URLS = env_int("MAX_VISITED_URLS", 1000, 1)
MAX_QUEUE_SIZE = env_int("MAX_QUEUE_SIZE", 2000, 1)

# The demo tenant exists so the dashboard has seed data. A live crawler run
# should never spend Tor/Cloud Run time on it unless a developer deliberately
# opts in while debugging locally.
DEMO_ORG_ID = "demo_org"
ALLOW_DEMO_ORG_CRAWL = os.getenv("ALLOW_DEMO_ORG_CRAWL", "").strip().lower() in {
    "1",
    "true",
    "yes",
}


def env_list(name, fallback):
    """Comma- or newline-separated override for a list-valued config key."""
    raw_value = os.getenv(name)
    if raw_value is None:
        return [str(item).strip() for item in (fallback or []) if str(item).strip()]
    return [item.strip() for item in re.split(r"[,\n]+", raw_value) if item.strip()]


KEYWORDS = [kw.lower() for kw in env_list("KEYWORDS", config.get("keywords"))]

# Live scans receive a mixed keyword list from the dashboard: target anchors
# such as "odido.nl" plus generic leak terms such as "password" and "dump".
# Saving on any one of those terms is too broad because generic dark-web forum
# pages almost always mention passwords/databases. Split the list so storage
# requires both: evidence that the page is about the selected organization and
# evidence that the page discusses leaked/exposed material.
LEAK_SIGNAL_KEYWORDS = {
    "access",
    "breach",
    "breached",
    "credential",
    "credentials",
    "customer",
    "database",
    "dump",
    "employee",
    "escrow",
    "exfil",
    "exfiltrated",
    "for sale",
    "leak",
    "leaked",
    "logs",
    "password",
    "passwords",
    "ransom",
    "sale",
}

# The crawl frontier comes entirely from search. Production default is both
# engines — Ahmia indexes broadly but shallowly, Dread carries the forum
# discussion and leak threads Ahmia never indexes.
SUPPORTED_ENGINES = ("ahmia", "dread")


def configured_search_engines():
    raw = env_list(
        "SEARCH_ENGINES",
        config.get("search_engines") or list(SUPPORTED_ENGINES),
    )
    engines = []
    for value in raw:
        engine = value.strip().lower()
        if engine not in SUPPORTED_ENGINES:
            raise ValueError(
                f"Unknown search engine: {engine!r} "
                f"(supported: {', '.join(SUPPORTED_ENGINES)})"
            )
        if engine not in engines:
            engines.append(engine)
    if not engines:
        raise ValueError(
            "At least one search engine must be configured "
            f"(supported: {', '.join(SUPPORTED_ENGINES)})"
        )
    return engines


SEARCH_ENGINES = configured_search_engines()

# `source` participates in doc_id, so it is recorded per page rather than per
# run. `dedupe_key` is intentionally URL-based to prevent the same page from
# producing noisy duplicate dashboard incidents when the content changes
# slightly between crawls.
QUERY = os.getenv("QUERY", config.get("query", "security research"))
SEARCH_PAGES = env_int("SEARCH_PAGES", config.get("search_pages", 2), 1)


def clean_keyword(value):
    return str(value).strip().strip("\"'").lower()


def env_list_or_none(name):
    raw_value = os.getenv(name)
    if raw_value is None:
        return None
    return [clean_keyword(item) for item in re.split(r"[,\n]+", raw_value) if item.strip()]


def unique_keywords(values):
    seen = set()
    result = []
    for value in values:
        keyword = clean_keyword(value)
        if keyword and keyword not in seen:
            seen.add(keyword)
            result.append(keyword)
    return result


def keyword_in_text(keyword, text_lower):
    """Match keywords without turning short words into noisy substrings.

    Domains and multi-word phrases are still treated as substring anchors, but
    single token words need simple alphanumeric boundaries. This prevents a
    leak term such as "sale" from matching the unrelated word "Salesforce".
    """
    if not keyword:
        return False
    if any(separator in keyword for separator in (".", "/", ":", "@", " ")):
        return keyword in text_lower
    pattern = rf"(?<![a-z0-9]){re.escape(keyword)}(?![a-z0-9])"
    return re.search(pattern, text_lower) is not None


def derive_target_keywords():
    explicit = env_list_or_none("TARGET_KEYWORDS")
    if explicit is not None:
        return unique_keywords(explicit)

    query_anchor = clean_keyword(QUERY)
    candidates = [kw for kw in KEYWORDS if kw not in LEAK_SIGNAL_KEYWORDS]
    if query_anchor and query_anchor not in LEAK_SIGNAL_KEYWORDS:
        candidates.insert(0, query_anchor)
    return unique_keywords(candidates)


def derive_leak_keywords():
    explicit = env_list_or_none("LEAK_KEYWORDS")
    if explicit is not None:
        return unique_keywords(explicit)
    return unique_keywords([kw for kw in KEYWORDS if kw in LEAK_SIGNAL_KEYWORDS])


TARGET_KEYWORDS = derive_target_keywords()
LEAK_KEYWORDS = derive_leak_keywords()

# Dread's onion address changes when the operators rotate it, so it is
# configuration rather than a constant. A wrong value must fail loudly.
DREAD_BASE_URL = (
    os.getenv("DREAD_BASE_URL")
    or config.get("dread_base_url")
    or "https://dreadytofatroptsdj6io7l3xptbet6onoyno2yv7jicoxknyazubrad.onion"
).rstrip("/")

# Seconds to let a page settle after load before reading the DOM.
PAGE_WAIT = env_int("PAGE_WAIT", config.get("page_wait", 10), 0)
PAGE_LOAD_TIMEOUT = env_int("PAGE_LOAD_TIMEOUT", 120, 1)

# Queue/interstitial handling. Dread gates every request behind an access
# queue, so with it in the default engine list this must be on by default.
INTERSTITIAL_WAIT = env_int(
    "INTERSTITIAL_WAIT", config.get("interstitial_wait", 300), 0
)
INTERSTITIAL_POLL = env_int(
    "INTERSTITIAL_POLL", config.get("interstitial_poll", 15), 1
)
# Attempts per URL. Queue-gated sites often time out on deep links until the
# browser session has cleared the waiting room once.
FETCH_ATTEMPTS = env_int("FETCH_ATTEMPTS", config.get("fetch_attempts", 2), 1)
FETCH_RETRY_BACKOFF = env_int(
    "FETCH_RETRY_BACKOFF", config.get("fetch_retry_backoff", 15), 0
)

# Cloud Run's configured task timeout is a hard kill: Python never reaches the
# manifest/finalize block, so buffered GCS records can be lost and the UI sees a
# failed crawl even when pages were already collected. Stop early enough to
# upload the final JSONL batch and manifest. Set to 0 to disable locally.
CRAWL_MAX_RUNTIME_SECONDS = env_int("CRAWL_MAX_RUNTIME_SECONDS", 6600, 0)
MIN_PAGE_TIME_BUDGET_SECONDS = env_int(
    "MIN_PAGE_TIME_BUDGET_SECONDS",
    max(PAGE_LOAD_TIMEOUT + PAGE_WAIT + INTERSTITIAL_WAIT + 60, 180),
    30,
)

ERROR_MARKERS = (
    "ERR_TIMED_OUT",
    "ERR_CONNECTION_REFUSED",
    "ERR_SOCKS_CONNECTION_FAILED",
    "ERR_NAME_NOT_RESOLVED",
    "ERR_CERT_AUTHORITY_INVALID",
    "This site can't be reached",
    "took too long to respond",
    "net::ERR_",
    "about:neterror",
)

# Waiting-room and bot-check pages. These return HTTP 200 with real markup, so
# only the visible text distinguishes them from content.
INTERSTITIAL_PATTERNS = (
    r"you have been placed in a queue",
    r"awaiting forwarding",
    r"access queue",
    r"estimated entry time",
    r"you will be automatically redirected",
    r"please do not refresh",
    r"checking your browser",
    r"cf-browser-verification",
    r"ddos protection",
    r"under attack mode",
    r"waiting room",
)
TOR_STARTUP_TIMEOUT = env_int("TOR_STARTUP_TIMEOUT", 90, 1)


def configured_org_id():
    organization = config.get("organization") or {}
    raw_value = os.getenv("ORG_ID", organization.get("org_id", ""))
    org_id = str(raw_value).strip()
    if not org_id:
        raise ValueError(
            "organization.org_id is required in config.yaml or through ORG_ID"
        )
    if not re.fullmatch(r"[a-z0-9]+(?:_[a-z0-9]+)*", org_id):
        raise ValueError(
            "ORG_ID must be a lowercase slug containing letters, numbers, "
            "and single underscores"
        )
    if org_id == DEMO_ORG_ID and not ALLOW_DEMO_ORG_CRAWL:
        raise ValueError(
            "demo_org is demonstration data and cannot be crawled. Select a "
            "real monitored organization, or set ALLOW_DEMO_ORG_CRAWL=true "
            "for local debugging only."
        )
    return org_id


ORG_ID = configured_org_id()


def utc_now():
    return datetime.now(timezone.utc)


def format_utc(value):
    return value.isoformat(timespec="seconds").replace("+00:00", "Z")


def wait_for_tor(host="127.0.0.1", port=9050, timeout=TOR_STARTUP_TIMEOUT):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with socket.create_connection((host, port), timeout=1):
                print(f"Tor SOCKS proxy ready at {host}:{port}", flush=True)
                return
        except OSError:
            time.sleep(1)
    raise TimeoutError(f"Tor did not become ready at {host}:{port} within {timeout}s")


def runtime_remaining(deadline_monotonic):
    if deadline_monotonic is None:
        return None
    return max(0.0, deadline_monotonic - time.monotonic())


def has_runtime_budget(deadline_monotonic, minimum_seconds=1):
    remaining = runtime_remaining(deadline_monotonic)
    return remaining is None or remaining >= minimum_seconds


def create_tor_driver():
    options = ChromeOptions()
    options.add_argument("--headless=new")
    options.add_argument("--no-sandbox")
    options.add_argument("--disable-dev-shm-usage")
    options.add_argument("--proxy-server=socks5://127.0.0.1:9050")
    options.add_argument("--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1")
    # Onion services routinely serve self-signed certificates; the hidden
    # service address itself already authenticates the endpoint, so a CA chain
    # adds nothing and its absence would otherwise block the page.
    options.add_argument("--ignore-certificate-errors")
    options.binary_location = "/usr/bin/chromium"
    driver = webdriver.Chrome(service=Service("/usr/bin/chromedriver"), options=options)
    driver.set_page_load_timeout(PAGE_LOAD_TIMEOUT)
    return driver


def create_direct_driver():
    options = ChromeOptions()
    options.add_argument("--headless=new")
    options.add_argument("--no-sandbox")
    options.add_argument("--disable-dev-shm-usage")
    options.add_argument("--disable-blink-features=AutomationControlled")
    options.add_argument("--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
    options.binary_location = "/usr/bin/chromium"
    options.add_experimental_option("excludeSwitches", ["enable-automation"])
    options.add_experimental_option("useAutomationExtension", False)
    driver = webdriver.Chrome(service=Service("/usr/bin/chromedriver"), options=options)
    driver.execute_cdp_cmd("Page.addScriptToEvaluateOnNewDocument", {
        "source": "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})"
    })
    driver.set_page_load_timeout(30)
    return driver


def search_ahmia(query, pages=3):
    """Search Ahmia over clearnet in its own browser session.

    Exceptions propagate: run_search_engines isolates them and records the
    engine as failed. Swallowing them here would report an outage as a
    successful search that happened to find nothing.
    """
    print(f"\n[SEARCH:ahmia] '{query}' ({pages} page(s))\n", flush=True)
    results = []
    driver = None

    try:
        driver = create_direct_driver()
        print("  Loading Ahmia homepage...", flush=True)
        driver.get("https://ahmia.fi/")
        time.sleep(5)

        search_input = driver.find_element(By.CSS_SELECTOR, "input[name='q'], input[type='search'], input[type='text']")
        search_input.clear()
        search_input.send_keys(query)
        search_input.send_keys(Keys.RETURN)
        time.sleep(15)

        print(f"  Result URL: {driver.current_url}", flush=True)
        print(f"  Page length: {len(driver.page_source)} chars", flush=True)

        for page in range(pages):
            soup = BeautifulSoup(driver.page_source, "html.parser")

            for a in soup.find_all("a", href=True):
                href = a["href"]
                if "redirect_url=" in href:
                    parsed = parse_qs(urlparse(href).query)
                    if "redirect_url" in parsed:
                        actual_url = parsed["redirect_url"][0]
                        if ".onion" in actual_url:
                            results.append(actual_url)
                elif ".onion" in href and "ahmia" not in href and "juhanu" not in href:
                    if href.startswith("http"):
                        results.append(href)

            print(f"  Page {page + 1}: found {len(results)} URLs so far", flush=True)

            if page < pages - 1:
                try:
                    next_link = driver.find_element(By.PARTIAL_LINK_TEXT, "Next")
                    next_link.click()
                    time.sleep(10)
                except Exception:
                    print("  No more pages available.", flush=True)
                    break

    finally:
        if driver is not None:
            try:
                driver.quit()
            except Exception as exc:
                print(f"  Warning: failed to close Ahmia browser: {exc}", flush=True)

    results = list(dict.fromkeys(results))
    print(f"\n  Ahmia returned {len(results)} result URL(s)", flush=True)
    return results


def visible_text(page_source):
    soup = BeautifulSoup(page_source, "html.parser")
    for tag in soup(["script", "style"]):
        tag.decompose()
    return soup.get_text(separator=" ", strip=True)


def is_error_page(page_source):
    return any(marker in page_source for marker in ERROR_MARKERS)


def looks_like_interstitial(page_source):
    """True for waiting-room / bot-check pages that will resolve on their own.

    Only the head of the visible text is inspected: a forum thread quoting the
    phrase "please do not refresh" further down is content, not a queue.
    """
    head = visible_text(page_source)[:600].lower()
    return any(re.search(pattern, head) for pattern in INTERSTITIAL_PATTERNS)


def wait_out_interstitial(driver, budget, deadline_monotonic=None):
    """Hold the tab open until the waiting room forwards us.

    Deliberately never re-issues driver.get(): these pages redirect themselves
    and explicitly warn that reloading forfeits your place in the queue. The
    browser session is shared across the crawl, so clearing the queue once
    generally admits every later URL on that host.
    """
    remaining = runtime_remaining(deadline_monotonic)
    if remaining is not None:
        # Leave time for the caller to unwind, close Selenium, and upload the
        # final partial GCS batch before Cloud Run's hard timeout.
        budget = min(budget, max(0, int(remaining - 30)))
    if budget <= 0:
        print("    QUEUE: no runtime budget left for forwarding", flush=True)
        return None

    deadline = time.monotonic() + budget
    print(f"    QUEUE: waiting up to {budget}s for forwarding...", flush=True)

    while time.monotonic() < deadline:
        time.sleep(min(INTERSTITIAL_POLL, max(1, int(deadline - time.monotonic()))))
        try:
            page_source = driver.page_source
        except Exception as exc:
            print(f"    QUEUE: lost the tab: {type(exc).__name__}: {exc}", flush=True)
            return None

        if is_error_page(page_source):
            print("    QUEUE: page failed while waiting", flush=True)
            return page_source
        if not looks_like_interstitial(page_source):
            waited = int(budget - (deadline - time.monotonic()))
            print(f"    QUEUE: cleared after ~{waited}s", flush=True)
            return page_source

    print(f"    QUEUE: still queued after {budget}s, giving up", flush=True)
    return None


def fetch_page(driver, url, deadline_monotonic=None):
    """Load one URL, absorbing waiting rooms and transient failures.

    Returns (page_source, outcome) where outcome is 'ok', 'unreachable',
    'queued', or 'runtime_budget'. Raising is left to the caller's exception
    handling.
    """
    last_source = None

    for attempt in range(1, FETCH_ATTEMPTS + 1):
        if not has_runtime_budget(deadline_monotonic, MIN_PAGE_TIME_BUDGET_SECONDS):
            return last_source, "runtime_budget"

        driver.get(url)
        if PAGE_WAIT:
            wait_seconds = PAGE_WAIT
            remaining = runtime_remaining(deadline_monotonic)
            if remaining is not None:
                wait_seconds = min(wait_seconds, max(0, int(remaining - 30)))
            if wait_seconds:
                time.sleep(wait_seconds)
        page_source = driver.page_source
        last_source = page_source

        if INTERSTITIAL_WAIT and looks_like_interstitial(page_source):
            cleared = wait_out_interstitial(
                driver,
                INTERSTITIAL_WAIT,
                deadline_monotonic=deadline_monotonic,
            )
            if cleared is None:
                if not has_runtime_budget(deadline_monotonic, 30):
                    return page_source, "runtime_budget"
                # Still in the queue. Retrying now would only re-enter it.
                return page_source, "queued"
            page_source = cleared
            last_source = page_source

        if not is_error_page(page_source):
            return page_source, "ok"

        if attempt < FETCH_ATTEMPTS:
            print(
                f"    RETRY {attempt}/{FETCH_ATTEMPTS - 1} after "
                f"{FETCH_RETRY_BACKOFF}s (page unreachable)",
                flush=True,
            )
            if FETCH_RETRY_BACKOFF:
                backoff_seconds = FETCH_RETRY_BACKOFF
                remaining = runtime_remaining(deadline_monotonic)
                if remaining is not None:
                    backoff_seconds = min(
                        backoff_seconds,
                        max(0, int(remaining - MIN_PAGE_TIME_BUDGET_SECONDS)),
                    )
                if backoff_seconds:
                    time.sleep(backoff_seconds)

    return last_source, "unreachable"


# Validated against a real crawl: /post/<hex> are threads and /d/<sub> are
# board listings, while /u/, /page/, /discover/, /leaderboard and /store/ are
# site chrome that would only add noise to the frontier.
DREAD_RESULT_PATH = re.compile(r"^/(post|d)/[^/]+")


def search_dread(driver, query, pages=None):
    """Search Dread over Tor, sitting through its access queue.

    Runs on the shared Tor browser rather than its own: clearing the queue is
    per-session, so reusing the session that will do the crawling means the
    queue is cleared once instead of once per driver.
    """
    pages = pages or SEARCH_PAGES
    print(f"\n[SEARCH:dread] '{query}' ({pages} page(s))", flush=True)
    results = []

    for page in range(1, pages + 1):
        url = f"{DREAD_BASE_URL}/search/?q={quote(query)}&p={page}"
        page_source, outcome = fetch_page(driver, url)

        if outcome != "ok":
            if page == 1:
                # Never reaching the first page is an outage, a stale onion
                # address, or an unclearable queue — not "Dread knows nothing
                # about this organization". Raising keeps run_search_engines
                # from recording a failure as a clean zero-hit search.
                raise RuntimeError(
                    f"Dread search unreachable ({outcome}) at {DREAD_BASE_URL}"
                )
            print(f"  page {page}: {outcome}; stopping Dread pagination", flush=True)
            break

        soup = BeautifulSoup(page_source, "html.parser")
        before = len(results)
        for link in extract_onion_links(soup, url):
            if DREAD_RESULT_PATH.match(urlsplit(link).path or ""):
                results.append(link)

        found = len(dict.fromkeys(results)) - len(dict.fromkeys(results[:before]))
        print(f"  page {page}: {found} new result link(s)", flush=True)
        if not found:
            # Dread pages past the last result render an empty result list.
            break

    results = list(dict.fromkeys(results))
    print(f"  Dread returned {len(results)} result URL(s)", flush=True)
    return results


def run_search_engines(query, tor_driver):
    """Query every enabled engine, keeping each one's failure to itself.

    One engine being down, rate-limited, or moved must not cost the run the
    results of the others, so each is isolated and its status recorded.
    """
    discovered = []
    statuses = {}

    for engine in SEARCH_ENGINES:
        try:
            if engine == "ahmia":
                urls = search_ahmia(query, pages=SEARCH_PAGES)
            elif engine == "dread":
                urls = search_dread(tor_driver, query, pages=SEARCH_PAGES)
            else:  # pragma: no cover - configured_search_engines rejects these
                raise ValueError(f"Unhandled engine {engine!r}")
            statuses[engine] = {"status": "ok", "results": len(urls)}
            discovered.extend((url, engine) for url in urls)
        except Exception as exc:
            statuses[engine] = {
                "status": "failed",
                "results": 0,
                "error": f"{type(exc).__name__}: {exc}"[:300],
            }
            print(
                f"  WARNING: {engine} search failed: {type(exc).__name__}: {exc}",
                flush=True,
            )

    return discovered, statuses


def keyword_match(text):
    """Check whether a page is worth storing.

    For organization-scoped live scans, a page must contain at least one target
    anchor and at least one leak signal. If the configuration does not provide
    enough information to split those categories, fall back to the legacy "any
    keyword" behavior so local ad-hoc crawls do not suddenly save nothing.
    """
    if not KEYWORDS:
        return True, []  # No keywords = save everything
    text_lower = text.lower()
    target_matches = [kw for kw in TARGET_KEYWORDS if keyword_in_text(kw, text_lower)]
    leak_matches = [kw for kw in LEAK_KEYWORDS if keyword_in_text(kw, text_lower)]

    if TARGET_KEYWORDS and LEAK_KEYWORDS:
        return bool(target_matches and leak_matches), unique_keywords(
            target_matches + leak_matches
        )

    matched = [kw for kw in KEYWORDS if keyword_in_text(kw, text_lower)]
    return len(matched) > 0, matched


def canonicalize_url(url):
    parsed = urlsplit(url.strip())
    return urlunsplit(
        (
            parsed.scheme.lower(),
            parsed.netloc.lower(),
            parsed.path or "/",
            parsed.query,
            "",
        )
    )


def sha256_parts(*parts):
    joined = "\0".join(str(part) for part in parts)
    return hashlib.sha256(joined.encode("utf-8")).hexdigest()


def build_page_record(
    *,
    run_id,
    url,
    title,
    text,
    depth,
    matched_keywords,
    links_found,
    source=None,
):
    page_source = source or SEARCH_ENGINE
    fetched_at = format_utc(utc_now())
    canonical_url = canonicalize_url(url)
    content_sha256 = hashlib.sha256(text.encode("utf-8")).hexdigest()
    return {
        "schema_version": 2,
        "org_id": ORG_ID,
        "doc_id": sha256_parts(
            ORG_ID, page_source, canonical_url, fetched_at
        ),
        "dedupe_key": sha256_parts(ORG_ID, canonical_url),
        "run_id": run_id,
        "source": page_source,
        "query": QUERY,
        "url": url,
        "title": title,
        "fetched_at": fetched_at,
        "depth": depth,
        "keywords_matched": matched_keywords,
        "links_found": links_found,
        "content_length": len(text),
        "content_sha256": content_sha256,
        "raw_text": text,
    }


SKIP_HREF_PREFIXES = ("#", "mailto:", "javascript:", "data:", "tel:")


def extract_onion_links(soup, current_url):
    """Onion links, plus same-site links resolved against the current page.

    Matching only hrefs that literally contain '.onion' meant the crawler could
    move between sites but never within one: forums and markets link internally
    with host-relative paths like '/d/DataBrokers', which carry no hostname.
    """
    links = set()
    current_host = (urlsplit(current_url).hostname or "").lower()

    for anchor in soup.find_all("a", href=True):
        href = anchor["href"].strip()
        if not href or href.lower().startswith(SKIP_HREF_PREFIXES):
            continue

        parts = urlsplit(urljoin(current_url, href))
        if parts.scheme not in ("http", "https"):
            continue

        host = (parts.hostname or "").lower()
        if not host:
            continue
        # Stay on onion services, or within whatever host we are already on.
        if not (host.endswith(".onion") or host == current_host):
            continue

        links.add(
            urlunsplit(
                (parts.scheme, parts.netloc, parts.path or "/", parts.query, "")
            )
        )
    return links


def bfs_crawl(driver, seed_entries, sink, run_id, deadline_monotonic=None):
    print(
        f"\n[STEP 2 & 3] BFS Crawl "
        f"(max_depth={MAX_DEPTH}, max_pages={MAX_PAGES} per engine)",
        flush=True,
    )
    print(
        f"  Keywords filter: {KEYWORDS if KEYWORDS else 'NONE (saving all)'}",
        flush=True,
    )
    if TARGET_KEYWORDS and LEAK_KEYWORDS:
        print(f"  Target anchors: {TARGET_KEYWORDS}", flush=True)
        print(f"  Leak signals: {LEAK_KEYWORDS}", flush=True)
        print("  Save rule: target anchor AND leak signal\n", flush=True)
    else:
        print("  Save rule: legacy any-keyword match\n", flush=True)

    queue = deque()
    scheduled_urls = set()
    links_dropped_queue_limit = 0

    def enqueue_url(candidate_url, depth, source):
        nonlocal links_dropped_queue_limit
        if depth > MAX_DEPTH:
            return False
        if not candidate_url.startswith("http"):
            candidate_url = "http://" + candidate_url

        url_identity = canonicalize_url(candidate_url)
        if url_identity in scheduled_urls:
            return False
        if len(queue) >= MAX_QUEUE_SIZE:
            links_dropped_queue_limit += 1
            return False

        scheduled_urls.add(url_identity)
        # Links discovered while crawling inherit the provenance of the entry
        # point they were reached from.
        queue.append((candidate_url, depth, source))
        return True

    for url, source in seed_entries:
        enqueue_url(url, 0, source)

    scraped_data = []
    page_counts = Counter()
    visited_count = 0
    skipped_no_keyword = 0
    unreachable_pages = 0
    failed_pages = 0
    queued_pages = 0
    duplicate_content_pages = 0
    skipped_budget_spent = 0
    runtime_budget_reached = False
    # Search engines routinely return one site under many mirror addresses.
    # Those differ by host, so they produce different dedupe_keys and survive
    # Snowflake's deduplication as separate documents — meaning the same bytes
    # would be classified, extracted, and paid for once per mirror.
    seen_content = set()

    # Every engine that put something on the frontier gets its own MAX_PAGES.
    frontier_sources = {source for _, source in seed_entries}

    def budget_left(source):
        return page_counts[source] < MAX_PAGES

    while queue and visited_count < MAX_VISITED_URLS:
        if not any(budget_left(source) for source in frontier_sources):
            break
        if not has_runtime_budget(deadline_monotonic, MIN_PAGE_TIME_BUDGET_SECONDS):
            runtime_budget_reached = True
            print(
                "  Runtime budget reached: stopping early so buffered pages "
                "can be uploaded before Cloud Run timeout.",
                flush=True,
            )
            break

        url, depth, source = queue.popleft()

        if not budget_left(source):
            # This engine has its pages; fetching more of its URLs would spend
            # crawl time on results that could never be stored.
            skipped_budget_spent += 1
            continue

        visited_count += 1

        print(
            f"  [{source} {page_counts[source] + 1}/{MAX_PAGES}] "
            f"Depth {depth} | {url}",
            flush=True,
        )

        try:
            page_source, outcome = fetch_page(
                driver,
                url,
                deadline_monotonic=deadline_monotonic,
            )

            if outcome == "queued":
                queued_pages += 1
                print("    SKIPPED: still in the site's access queue", flush=True)
                continue
            if outcome == "runtime_budget":
                runtime_budget_reached = True
                print(
                    "    STOPPED: runtime budget reached before this page "
                    "could be fetched safely",
                    flush=True,
                )
                break
            if outcome == "unreachable":
                unreachable_pages += 1
                print("    SKIPPED: Site unreachable", flush=True)
                continue

            soup = BeautifulSoup(page_source, "html.parser")

            for tag in soup(["script", "style"]):
                tag.decompose()

            title = soup.title.string.strip() if soup.title and soup.title.string else "N/A"
            text = soup.get_text(separator="\n", strip=True)

            # Extract links for BFS (always, regardless of keyword match)
            new_links = extract_onion_links(soup, url)
            added = 0
            for link in new_links:
                if enqueue_url(link, depth + 1, source):
                    added += 1

            # Keyword filtering determines whether this page enters the raw dump.
            has_match, matched_keywords = keyword_match(text)

        except Exception as e:
            failed_pages += 1
            print(f"    FAILED: {type(e).__name__}: {str(e)[:100]}", flush=True)
            time.sleep(5)
            continue

        if has_match:
            content_fingerprint = hashlib.sha256(text.encode("utf-8")).hexdigest()
            if content_fingerprint in seen_content:
                duplicate_content_pages += 1
                print(
                    "    DUPLICATE CONTENT - already stored this run "
                    "(links still followed)",
                    flush=True,
                )
                print(
                    f"    Links: {len(new_links)} found, {added} added to queue",
                    flush=True,
                )
                time.sleep(5)
                continue
            seen_content.add(content_fingerprint)

            record = build_page_record(
                run_id=run_id,
                url=url,
                title=title,
                text=text,
                depth=depth,
                matched_keywords=matched_keywords,
                links_found=len(new_links),
                source=source,
            )

            # Storage failures are deliberately not swallowed as crawl failures.
            # A failed GCS upload must fail the Cloud Run Job.
            storage_reference = sink.write(record)
            page_counts[source] += 1
            print(f"    SAVED | Title: {title}", flush=True)
            print(f"    Keywords: {matched_keywords}", flush=True)
            if storage_reference:
                print(
                    f"    Content: {len(text)} chars | Stored: {storage_reference}",
                    flush=True,
                )
            else:
                print(
                    f"    Content: {len(text)} chars | Buffered for batch upload",
                    flush=True,
                )

            scraped_data.append(
                {
                    key: value
                    for key, value in record.items()
                    if key != "raw_text"
                }
            )
        else:
            skipped_no_keyword += 1
            print(
                "    NO TARGET+LEAK MATCH - skipped (links still followed)",
                flush=True,
            )

        print(
            f"    Links: {len(new_links)} found, {added} added to queue",
            flush=True,
        )

        time.sleep(5)

    print(f"\n  Pages saved: {sum(page_counts.values())}", flush=True)
    for engine in sorted(page_counts):
        print(f"    {engine}: {page_counts[engine]}/{MAX_PAGES}", flush=True)
    print(f"  Pages skipped (no keyword): {skipped_no_keyword}", flush=True)
    if duplicate_content_pages:
        print(
            f"  Pages skipped (duplicate content/mirrors): "
            f"{duplicate_content_pages}",
            flush=True,
        )
    visited_limit_reached = visited_count >= MAX_VISITED_URLS and bool(queue)
    if visited_limit_reached:
        print(
            f"  URL visit limit reached: {MAX_VISITED_URLS} "
            f"({len(queue)} URLs left pending)",
            flush=True,
        )
    if links_dropped_queue_limit:
        print(
            f"  Queue limit reached: dropped {links_dropped_queue_limit} links",
            flush=True,
        )
    if runtime_budget_reached:
        print(
            "  Runtime budget reached before frontier was exhausted; partial "
            "results will still be finalized.",
            flush=True,
        )
    return scraped_data, {
        "urls_visited": visited_count,
        "urls_scheduled": len(scheduled_urls),
        "urls_pending_at_stop": len(queue),
        "pages_skipped_no_keyword": skipped_no_keyword,
        "pages_skipped_duplicate_content": duplicate_content_pages,
        "urls_skipped_budget_spent": skipped_budget_spent,
        "pages_per_engine": dict(page_counts),
        "max_pages_per_engine": MAX_PAGES,
        "pages_unreachable": unreachable_pages,
        "pages_queued": queued_pages,
        "pages_failed": failed_pages,
        "visited_limit_reached": visited_limit_reached,
        "links_dropped_queue_limit": links_dropped_queue_limit,
        "runtime_budget_reached": runtime_budget_reached,
    }


def main():
    started_at = utc_now()
    deadline_monotonic = (
        time.monotonic() + CRAWL_MAX_RUNTIME_SECONDS
        if CRAWL_MAX_RUNTIME_SECONDS
        else None
    )
    print("=" * 60, flush=True)
    print("  DARK WEB BFS CRAWLER", flush=True)
    print("=" * 60, flush=True)
    print("\n  Config:", flush=True)
    print(f"    Organization ID: {ORG_ID}", flush=True)
    print(
        "    Search engines: "
        + (", ".join(SEARCH_ENGINES) if SEARCH_ENGINES else "none (seed URLs only)"),
        flush=True,
    )
    if "dread" in SEARCH_ENGINES:
        print(f"    Dread base URL: {DREAD_BASE_URL}", flush=True)
    print(f"    Search pages per engine: {SEARCH_PAGES}", flush=True)
    print(f"    Query: {QUERY}", flush=True)
    print(f"    Keywords: {KEYWORDS if KEYWORDS else 'None (save all)'}", flush=True)
    if TARGET_KEYWORDS and LEAK_KEYWORDS:
        print(f"    Target anchors: {TARGET_KEYWORDS}", flush=True)
        print(f"    Leak signals: {LEAK_KEYWORDS}", flush=True)
    print(f"    Max depth: {MAX_DEPTH}", flush=True)
    print(f"    Max pages per engine: {MAX_PAGES}", flush=True)
    print(f"    Max visited URLs: {MAX_VISITED_URLS}", flush=True)
    print(f"    Max queue size: {MAX_QUEUE_SIZE}", flush=True)
    print(f"    Page settle wait: {PAGE_WAIT}s", flush=True)
    print(
        "    Access-queue wait: "
        + (f"{INTERSTITIAL_WAIT}s (poll {INTERSTITIAL_POLL}s)"
           if INTERSTITIAL_WAIT else "disabled"),
        flush=True,
    )
    print(f"    Fetch attempts per URL: {FETCH_ATTEMPTS}", flush=True)
    print(
        "    Runtime budget: "
        + (
            f"{CRAWL_MAX_RUNTIME_SECONDS}s "
            f"(stop with at least {MIN_PAGE_TIME_BUDGET_SECONDS}s spare)"
            if CRAWL_MAX_RUNTIME_SECONDS
            else "disabled"
        ),
        flush=True,
    )
    print(f"    Output backend: {os.getenv('OUTPUT_BACKEND', 'local')}", flush=True)

    driver = None
    try:
        sink = create_output_sink(OUTPUT_DIR, org_id=ORG_ID)
        run_id = getattr(
            sink,
            "run_id",
            os.getenv("CLOUD_RUN_EXECUTION")
            or f"local-{started_at.strftime('%Y%m%dT%H%M%SZ')}-{uuid.uuid4().hex[:8]}",
        )

        # Tor comes up before searching: Dread is an onion service, so it needs
        # the same browser session that will later do the crawling.
        print("\nWaiting for Tor...", flush=True)
        wait_for_tor()
        print("Starting Tor browser...", flush=True)
        driver = create_tor_driver()

        print("Verifying Tor connection...", flush=True)
        try:
            driver.get("https://check.torproject.org")
            time.sleep(5)
            if "Congratulations" in driver.page_source:
                print("Tor verified!\n", flush=True)
            else:
                print("WARNING: Tor may not be connected\n", flush=True)
        except Exception as exc:
            print(f"WARNING: Tor verification failed: {exc}\n", flush=True)

        # Step 1: every enabled engine's results feed one BFS frontier, each
        # entry keeping the provenance of the engine that found it.
        print(f"\n[STEP 1] Searching: {', '.join(SEARCH_ENGINES)}", flush=True)
        discovered, engine_statuses = run_search_engines(QUERY, driver)

        seed_entries = []
        seen = set()
        for url, engine in discovered:
            identity = canonicalize_url(url)
            if identity in seen:
                continue
            seen.add(identity)
            seed_entries.append((url, engine))

        if all(status["status"] == "failed" for status in engine_statuses.values()):
            # Every engine failing is an outage or a stale onion address, not an
            # empty result set. Failing here keeps a broken configuration from
            # being reported as a clean zero-hit run.
            raise RuntimeError(
                f"Every search engine failed: {engine_statuses}"
            )

        print(f"\nEntry points ({len(seed_entries)}):", flush=True)
        for index, (url, source) in enumerate(seed_entries[:20], 1):
            print(f"  {index}. [{source}] {url}", flush=True)
        if len(seed_entries) > 20:
            print(f"  ... and {len(seed_entries) - 20} more", flush=True)

        if not seed_entries:
            print("\nNo results for this query; nothing to crawl.", flush=True)

        scraped_data, crawl_counts = bfs_crawl(
            driver,
            seed_entries,
            sink,
            run_id,
            deadline_monotonic=deadline_monotonic,
        )

        completed_at = utc_now()
        manifest = {
            "schema_version": 2,
            "status": (
                "partial_success"
                if crawl_counts.get("runtime_budget_reached")
                else "succeeded"
            ),
            "org_id": ORG_ID,
            "run_id": run_id,
            "started_at": format_utc(started_at),
            "completed_at": format_utc(completed_at),
            "config": {
                "org_id": ORG_ID,
                "search_engines": SEARCH_ENGINES,
                "search_pages": SEARCH_PAGES,
                "dread_base_url": DREAD_BASE_URL if "dread" in SEARCH_ENGINES else None,
                "query": QUERY,
                "keywords": KEYWORDS,
                "target_keywords": TARGET_KEYWORDS,
                "leak_keywords": LEAK_KEYWORDS,
                "max_depth": MAX_DEPTH,
                "max_pages_per_engine": MAX_PAGES,
                "max_visited_urls": MAX_VISITED_URLS,
                "max_queue_size": MAX_QUEUE_SIZE,
            },
            "search_engine_results": engine_statuses,
            "entry_points": [url for url, _ in seed_entries],
            "entry_point_sources": {
                source: sum(1 for _, entry in seed_entries if entry == source)
                for source in dict.fromkeys(entry for _, entry in seed_entries)
            },
            "total_pages_scraped": len(scraped_data),
            "counts": crawl_counts,
            "pages": scraped_data,
        }
        completed_manifest = sink.finalize(manifest)
        storage_details = completed_manifest["storage"]
        output_location = storage_details.get(
            "manifest_uri", storage_details.get("output_dir", OUTPUT_DIR)
        )

        print(f"\n{'=' * 60}", flush=True)
        print("  CRAWL COMPLETE", flush=True)
        print(f"  Pages saved (keyword match): {len(scraped_data)}", flush=True)
        print(f"  Output: {output_location}", flush=True)
        print("=" * 60, flush=True)
        return 0
    except Exception as exc:
        print(
            f"\nFATAL: {type(exc).__name__}: {exc}",
            file=sys.stderr,
            flush=True,
        )
        return 1
    finally:
        if driver is not None:
            try:
                driver.quit()
            except Exception as exc:
                print(f"WARNING: failed to close Tor browser: {exc}", flush=True)


if __name__ == "__main__":
    sys.exit(main())
