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

from .org_config import resolve_organizations
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


def env_list(name, fallback):
    """Comma- or newline-separated override for a list-valued config key."""
    raw_value = os.getenv(name)
    if raw_value is None:
        return [str(item).strip() for item in (fallback or []) if str(item).strip()]
    return [item.strip() for item in re.split(r"[,\n]+", raw_value) if item.strip()]


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

# `source` participates in doc_id and dedupe_key, so it is recorded per page
# rather than per run: a page found through both engines stays two
# observations instead of one silently deduplicating the other.
SEARCH_PAGES = env_int("SEARCH_PAGES", config.get("search_pages", 2), 1)

# Dread's onion address changes when the operators rotate it, so it is
# configuration rather than a constant. A wrong value must fail loudly.
DREAD_BASE_URL = (
    os.getenv("DREAD_BASE_URL")
    or config.get("dread_base_url")
    or "https://dreadytofatroptsdj6io7l3xptbet6onoyno2yv7jicoxknyazubrad.onion"
).rstrip("/")

# Seconds to let a page settle after load before reading the DOM.
PAGE_WAIT = env_int("PAGE_WAIT", config.get("page_wait", 10), 0)

# Timeouts for the clearnet search browser. Ahmia is slower under Cloud Run and
# under emulation than on a laptop, and a tight limit turns a slow search into a
# silent zero-result run rather than an error.
SEARCH_PAGE_LOAD_TIMEOUT = env_int(
    "SEARCH_PAGE_LOAD_TIMEOUT", config.get("search_page_load_timeout", 120), 1
)

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

# A crashed renderer takes the whole WebDriver session with it, so every later
# page would fail too. These identify that state so the session can be rebuilt
# instead of losing the rest of an unattended run.
SESSION_DEAD_MARKERS = (
    "tab crashed",
    "invalid session id",
    "session deleted",
    "no such session",
    "disconnected: not connected to DevTools",
    "chrome not reachable",
    "unable to connect to renderer",
)
MAX_BROWSER_RESTARTS = env_int("MAX_BROWSER_RESTARTS", 5, 0)


def is_session_dead(error) -> bool:
    message = str(error).lower()
    return any(marker in message for marker in SESSION_DEAD_MARKERS)


class TorBrowser:
    """Owns the Tor Chrome session so a crash can be recovered from.

    The session is shared across organizations and engines, which is what keeps
    Dread's access queue cleared once rather than per URL; rebuilding it costs
    that queue position, so it is only done when the session is genuinely dead.
    """

    def __init__(self):
        self.driver = None
        self.restarts = 0

    def start(self):
        self.driver = create_tor_driver()
        return self.driver

    def restart(self):
        if self.restarts >= MAX_BROWSER_RESTARTS:
            raise RuntimeError(
                f"Tor browser crashed more than {MAX_BROWSER_RESTARTS} times; "
                f"the task is most likely out of memory"
            )
        self.restarts += 1
        print(
            f"    RECOVERING: rebuilding the browser session "
            f"({self.restarts}/{MAX_BROWSER_RESTARTS})",
            flush=True,
        )
        self.quit()
        return self.start()

    def quit(self):
        if self.driver is not None:
            try:
                self.driver.quit()
            except Exception:
                pass
            self.driver = None




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


# Chromium dies with "tab crashed" when the renderer runs out of memory, and a
# Cloud Run task shares its allowance with Tor and Python. The crawler only ever
# reads text, so everything that costs memory to render is turned off.
LEAN_RENDER_ARGS = (
    "--headless=new",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--disable-extensions",
    "--disable-software-rasterizer",
    "--disable-background-networking",
    "--blink-settings=imagesEnabled=false",
    "--mute-audio",
    "--renderer-process-limit=1",
)


def create_tor_driver():
    options = ChromeOptions()
    for argument in LEAN_RENDER_ARGS:
        options.add_argument(argument)
    options.add_argument("--proxy-server=socks5://127.0.0.1:9050")
    options.add_argument("--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1")
    # Onion services routinely serve self-signed certificates; the hidden
    # service address itself already authenticates the endpoint, so a CA chain
    # adds nothing and its absence would otherwise block the page.
    options.add_argument("--ignore-certificate-errors")
    options.binary_location = "/usr/bin/chromium"
    driver = webdriver.Chrome(service=Service("/usr/bin/chromedriver"), options=options)
    driver.set_page_load_timeout(env_int("PAGE_LOAD_TIMEOUT", 120, 1))
    return driver


def create_direct_driver():
    options = ChromeOptions()
    for argument in LEAN_RENDER_ARGS:
        options.add_argument(argument)
    options.add_argument("--disable-blink-features=AutomationControlled")
    options.add_argument("--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
    options.binary_location = "/usr/bin/chromium"
    options.add_experimental_option("excludeSwitches", ["enable-automation"])
    options.add_experimental_option("useAutomationExtension", False)
    driver = webdriver.Chrome(service=Service("/usr/bin/chromedriver"), options=options)
    driver.execute_cdp_cmd("Page.addScriptToEvaluateOnNewDocument", {
        "source": "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})"
    })
    driver.set_page_load_timeout(SEARCH_PAGE_LOAD_TIMEOUT)
    # Submitting the search form navigates, and that wait is governed by the
    # script timeout, which defaults to 30s independently of the page-load one.
    driver.set_script_timeout(SEARCH_PAGE_LOAD_TIMEOUT)
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


def wait_out_interstitial(driver, budget):
    """Hold the tab open until the waiting room forwards us.

    Deliberately never re-issues driver.get(): these pages redirect themselves
    and explicitly warn that reloading forfeits your place in the queue. The
    browser session is shared across the crawl, so clearing the queue once
    generally admits every later URL on that host.
    """
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


def fetch_page(driver, url):
    """Load one URL, absorbing waiting rooms and transient failures.

    Returns (page_source, outcome) where outcome is 'ok', 'unreachable', or
    'queued'. Raising is left to the caller's exception handling.
    """
    last_source = None

    for attempt in range(1, FETCH_ATTEMPTS + 1):
        driver.get(url)
        if PAGE_WAIT:
            time.sleep(PAGE_WAIT)
        page_source = driver.page_source
        last_source = page_source

        if INTERSTITIAL_WAIT and looks_like_interstitial(page_source):
            cleared = wait_out_interstitial(driver, INTERSTITIAL_WAIT)
            if cleared is None:
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
                time.sleep(FETCH_RETRY_BACKOFF)

    return last_source, "unreachable"


# Validated against a real crawl: /post/<hex> are threads and /d/<sub> are
# board listings, while /u/, /page/, /discover/, /leaderboard and /store/ are
# site chrome that would only add noise to the frontier.
DREAD_RESULT_PATH = re.compile(r"^/(post|d)/[^/]+")


def search_dread(browser, query, pages=None):
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
        page_source, outcome = fetch_page(browser.driver, url)

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


def run_search_engines(query, browser):
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
                urls = search_dread(browser, query, pages=SEARCH_PAGES)
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
            if is_session_dead(exc):
                browser.restart()
            print(
                f"  WARNING: {engine} search failed: {type(exc).__name__}: {exc}",
                flush=True,
            )

    return discovered, statuses


def keyword_match(text, keywords):
    """Check if text contains any of this organization's keywords."""
    if not keywords:
        return True, []  # No keywords = save everything
    text_lower = text.lower()
    matched = [kw for kw in keywords if kw in text_lower]
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
    source,
    org,
):
    page_source = source
    fetched_at = format_utc(utc_now())
    canonical_url = canonicalize_url(url)
    content_sha256 = hashlib.sha256(text.encode("utf-8")).hexdigest()
    return {
        "schema_version": 2,
        "org_id": org.org_id,
        "doc_id": sha256_parts(
            org.org_id, page_source, canonical_url, fetched_at
        ),
        "dedupe_key": sha256_parts(
            org.org_id, page_source, canonical_url, content_sha256
        ),
        "run_id": run_id,
        "source": page_source,
        "query": org.query,
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


def bfs_crawl(browser, seed_entries, sink, run_id, org):
    keywords = [kw.lower() for kw in org.keywords]
    print(
        f"\n  BFS crawl (max_depth={MAX_DEPTH}, max_pages={MAX_PAGES} per engine)",
        flush=True,
    )
    print(
        f"  Keywords filter: {keywords if keywords else 'NONE (saving all)'}\n",
        flush=True,
    )

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
            page_source, outcome = fetch_page(browser.driver, url)

            if outcome == "queued":
                queued_pages += 1
                print("    SKIPPED: still in the site's access queue", flush=True)
                continue
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
            has_match, matched_keywords = keyword_match(text, keywords)

        except Exception as e:
            failed_pages += 1
            print(f"    FAILED: {type(e).__name__}: {str(e)[:100]}", flush=True)
            if is_session_dead(e):
                # The renderer died, taking the session with it. Without a
                # rebuild every remaining URL would fail the same way.
                browser.restart()
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
                org=org,
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
            print("    NO KEYWORD MATCH - skipped (links still followed)", flush=True)

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
    }


def crawl_organization(browser, org, started_at):
    """Search and crawl for one organization. Returns its completed manifest."""
    print(f"\n{'=' * 60}", flush=True)
    print(f"  ORGANIZATION: {org.org_id}"
          + (f" ({org.canonical_name})" if org.canonical_name else ""), flush=True)
    print(f"  Query: {org.query}", flush=True)
    print(f"  Keywords: {org.keywords if org.keywords else 'None (save all)'}", flush=True)
    print("=" * 60, flush=True)

    # One sink per organization: the GCS layout partitions on org_id, so each
    # organization's pages and manifest land under their own prefix.
    sink = create_output_sink(OUTPUT_DIR, org_id=org.org_id)
    run_id = getattr(
        sink,
        "run_id",
        os.getenv("CLOUD_RUN_EXECUTION")
        or f"local-{started_at.strftime('%Y%m%dT%H%M%SZ')}-{uuid.uuid4().hex[:8]}",
    )

    print(f"\n  Searching: {', '.join(SEARCH_ENGINES)}", flush=True)
    discovered, engine_statuses = run_search_engines(org.query, browser)

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
        raise RuntimeError(f"Every search engine failed: {engine_statuses}")

    print(f"\n  Entry points ({len(seed_entries)}):", flush=True)
    for index, (url, source) in enumerate(seed_entries[:20], 1):
        print(f"    {index}. [{source}] {url}", flush=True)
    if len(seed_entries) > 20:
        print(f"    ... and {len(seed_entries) - 20} more", flush=True)

    if not seed_entries:
        print("\n  No results for this query; nothing to crawl.", flush=True)

    scraped_data, crawl_counts = bfs_crawl(browser, seed_entries, sink, run_id, org)

    manifest = {
        "schema_version": 2,
        "status": "succeeded",
        "org_id": org.org_id,
        "run_id": run_id,
        "started_at": format_utc(started_at),
        "completed_at": format_utc(utc_now()),
        "config": {
            "org_id": org.org_id,
            "search_engines": SEARCH_ENGINES,
            "search_pages": SEARCH_PAGES,
            "dread_base_url": DREAD_BASE_URL if "dread" in SEARCH_ENGINES else None,
            "query": org.query,
            "keywords": org.keywords,
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
    storage = completed_manifest["storage"]
    output_location = storage.get("manifest_uri", storage.get("output_dir", OUTPUT_DIR))

    print(f"\n  {org.org_id}: {len(scraped_data)} page(s) saved -> {output_location}",
          flush=True)
    return len(scraped_data)


def main():
    started_at = utc_now()
    print("=" * 60, flush=True)
    print("  DARK WEB BFS CRAWLER", flush=True)
    print("=" * 60, flush=True)
    print("\n  Config:", flush=True)
    print(
        "    Search engines: " + ", ".join(SEARCH_ENGINES),
        flush=True,
    )
    if "dread" in SEARCH_ENGINES:
        print(f"    Dread base URL: {DREAD_BASE_URL}", flush=True)
    print(f"    Search pages per engine: {SEARCH_PAGES}", flush=True)
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
    print(f"    Output backend: {os.getenv('OUTPUT_BACKEND', 'local')}", flush=True)

    browser = TorBrowser()
    try:
        organizations = resolve_organizations(config)
        print(
            f"    Organizations to crawl: "
            f"{', '.join(o.org_id for o in organizations)}",
            flush=True,
        )

        # Tor comes up once and is shared across organizations: Dread's access
        # queue is cleared per browser session, so reusing the session means it
        # is cleared once rather than once per organization.
        print("\nWaiting for Tor...", flush=True)
        wait_for_tor()
        print("Starting Tor browser...", flush=True)
        driver = browser.start()

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

        results = {}
        failures = {}
        for org in organizations:
            try:
                results[org.org_id] = crawl_organization(browser, org, utc_now())
            except Exception as exc:
                # One organization's outage must not discard the others' work,
                # which is already uploaded by the time this is reached.
                failures[org.org_id] = f"{type(exc).__name__}: {exc}"[:300]
                print(
                    f"\n  FAILED {org.org_id}: {type(exc).__name__}: {exc}",
                    file=sys.stderr,
                    flush=True,
                )
                if is_session_dead(exc):
                    # Leave a working session for the organizations that follow.
                    browser.restart()

        print(f"\n{'=' * 60}", flush=True)
        print("  CRAWL COMPLETE", flush=True)
        for org_id, count in results.items():
            print(f"    {org_id}: {count} page(s)", flush=True)
        for org_id, error in failures.items():
            print(f"    {org_id}: FAILED - {error}", flush=True)
        print(f"  Total pages saved: {sum(results.values())}", flush=True)
        print("=" * 60, flush=True)

        # A run where every organization failed is a failed run; a partial
        # failure still produced data and should not fail the job.
        if failures and not results:
            return 1
        return 0
    except Exception as exc:
        print(
            f"\nFATAL: {type(exc).__name__}: {exc}",
            file=sys.stderr,
            flush=True,
        )
        return 1
    finally:
        browser.quit()


if __name__ == "__main__":
    sys.exit(main())
