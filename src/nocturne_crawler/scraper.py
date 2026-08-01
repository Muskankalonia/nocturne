import hashlib
import os
import re
import socket
import sys
import time
import uuid
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlparse, urlsplit, urlunsplit

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
MAX_PAGES = env_int("MAX_PAGES", config.get("max_pages", 30), 1)
MAX_VISITED_URLS = env_int("MAX_VISITED_URLS", 1000, 1)
MAX_QUEUE_SIZE = env_int("MAX_QUEUE_SIZE", 2000, 1)
KEYWORDS = [kw.lower() for kw in config.get("keywords", [])]
SEARCH_ENGINE = config.get("search_engine", "ahmia")
QUERY = os.getenv("QUERY", config.get("query", "security research"))
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


def create_tor_driver():
    options = ChromeOptions()
    options.add_argument("--headless=new")
    options.add_argument("--no-sandbox")
    options.add_argument("--disable-dev-shm-usage")
    options.add_argument("--proxy-server=socks5://127.0.0.1:9050")
    options.add_argument("--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1")
    options.binary_location = "/usr/bin/chromium"
    driver = webdriver.Chrome(service=Service("/usr/bin/chromedriver"), options=options)
    driver.set_page_load_timeout(120)
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
    print(f"\n[STEP 1] Searching Ahmia for: '{query}'\n", flush=True)
    seed_urls = []
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
                            seed_urls.append(actual_url)
                elif ".onion" in href and "ahmia" not in href and "juhanu" not in href:
                    if href.startswith("http"):
                        seed_urls.append(href)

            print(f"  Page {page + 1}: found {len(seed_urls)} URLs so far", flush=True)

            if page < pages - 1:
                try:
                    next_link = driver.find_element(By.PARTIAL_LINK_TEXT, "Next")
                    next_link.click()
                    time.sleep(10)
                except Exception:
                    print("  No more pages available.", flush=True)
                    break

    except Exception as e:
        print(f"  Error: {e}", flush=True)
    finally:
        if driver is not None:
            try:
                driver.quit()
            except Exception as exc:
                print(f"  Warning: failed to close Ahmia browser: {exc}", flush=True)

    seed_urls = list(dict.fromkeys(seed_urls))
    print(f"\n  Ahmia returned {len(seed_urls)} seed URLs", flush=True)

    if not seed_urls:
        print("\n" + "!" * 60, flush=True)
        print("  WARNING: AHMIA SEARCH FAILED", flush=True)
        print("  Reason: Ahmia requires JavaScript that did not render.", flush=True)
        print("  Action: Falling back to pre-defined seed URLs.", flush=True)
        print("!" * 60 + "\n", flush=True)
        seed_urls = [
            "http://rnsm777cdsjrsdlbs4v5qoeppu3px6sb2igmh53jzrx7ipcrbjz5b2ad.onion/",
            "http://xmh57jrknzkhv6y3ls3ubitzfqnkrwxhopf5aygthi7d6rplyvk3noyd.onion/",
            "https://duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion/",
        ]

    return seed_urls


def keyword_match(text):
    """Check if text contains any of the configured keywords."""
    if not KEYWORDS:
        return True, []  # No keywords = save everything
    text_lower = text.lower()
    matched = [kw for kw in KEYWORDS if kw in text_lower]
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
):
    fetched_at = format_utc(utc_now())
    canonical_url = canonicalize_url(url)
    content_sha256 = hashlib.sha256(text.encode("utf-8")).hexdigest()
    return {
        "schema_version": 2,
        "org_id": ORG_ID,
        "doc_id": sha256_parts(
            ORG_ID, SEARCH_ENGINE, canonical_url, fetched_at
        ),
        "dedupe_key": sha256_parts(
            ORG_ID, SEARCH_ENGINE, canonical_url, content_sha256
        ),
        "run_id": run_id,
        "source": SEARCH_ENGINE,
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


def extract_onion_links(soup, current_url):
    links = set()
    for a in soup.find_all("a", href=True):
        href = a["href"]
        if ".onion" in href:
            if href.startswith("http"):
                links.add(href)
            elif href.startswith("/"):
                base = re.match(r'(https?://[^/]+)', current_url)
                if base:
                    links.add(base.group(1) + href)
    return links


def bfs_crawl(driver, seed_urls, sink, run_id):
    print(
        f"\n[STEP 2 & 3] BFS Crawl "
        f"(max_depth={MAX_DEPTH}, max_pages={MAX_PAGES})",
        flush=True,
    )
    print(
        f"  Keywords filter: {KEYWORDS if KEYWORDS else 'NONE (saving all)'}\n",
        flush=True,
    )

    queue = deque()
    scheduled_urls = set()
    links_dropped_queue_limit = 0

    def enqueue_url(candidate_url, depth):
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
        queue.append((candidate_url, depth))
        return True

    for url in seed_urls:
        enqueue_url(url, 0)

    scraped_data = []
    page_count = 0
    visited_count = 0
    skipped_no_keyword = 0
    unreachable_pages = 0
    failed_pages = 0

    while (
        queue
        and page_count < MAX_PAGES
        and visited_count < MAX_VISITED_URLS
    ):
        url, depth = queue.popleft()
        visited_count += 1

        print(f"  [{page_count + 1}/{MAX_PAGES}] Depth {depth} | {url}", flush=True)

        try:
            driver.get(url)
            time.sleep(10)

            # Skip Chrome error pages
            page_source = driver.page_source
            error_markers = [
                "ERR_TIMED_OUT",
                "ERR_CONNECTION_REFUSED",
                "ERR_SOCKS_CONNECTION_FAILED",
                "ERR_NAME_NOT_RESOLVED",
                "This site can't be reached",
                "took too long to respond",
                "net::ERR_",
                "about:neterror",
            ]
            if any(marker in page_source for marker in error_markers):
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
                if enqueue_url(link, depth + 1):
                    added += 1

            # Keyword filtering determines whether this page enters the raw dump.
            has_match, matched_keywords = keyword_match(text)

        except Exception as e:
            failed_pages += 1
            print(f"    FAILED: {type(e).__name__}: {str(e)[:100]}", flush=True)
            time.sleep(5)
            continue

        if has_match:
            record = build_page_record(
                run_id=run_id,
                url=url,
                title=title,
                text=text,
                depth=depth,
                matched_keywords=matched_keywords,
                links_found=len(new_links),
            )

            # Storage failures are deliberately not swallowed as crawl failures.
            # A failed GCS upload must fail the Cloud Run Job.
            storage_reference = sink.write(record)
            page_count += 1
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

    print(f"\n  Pages saved: {page_count}", flush=True)
    print(f"  Pages skipped (no keyword): {skipped_no_keyword}", flush=True)
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
        "pages_unreachable": unreachable_pages,
        "pages_failed": failed_pages,
        "visited_limit_reached": visited_limit_reached,
        "links_dropped_queue_limit": links_dropped_queue_limit,
    }


def main():
    started_at = utc_now()
    print("=" * 60, flush=True)
    print("  DARK WEB BFS CRAWLER", flush=True)
    print("=" * 60, flush=True)
    print("\n  Config:", flush=True)
    print(f"    Organization ID: {ORG_ID}", flush=True)
    print(f"    Search engine: {SEARCH_ENGINE}", flush=True)
    print(f"    Query: {QUERY}", flush=True)
    print(f"    Keywords: {KEYWORDS if KEYWORDS else 'None (save all)'}", flush=True)
    print(f"    Max depth: {MAX_DEPTH}", flush=True)
    print(f"    Max pages: {MAX_PAGES}", flush=True)
    print(f"    Max visited URLs: {MAX_VISITED_URLS}", flush=True)
    print(f"    Max queue size: {MAX_QUEUE_SIZE}", flush=True)
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

        # Step 1: Search
        if SEARCH_ENGINE == "ahmia":
            seed_urls = search_ahmia(QUERY, pages=2)
        else:
            raise ValueError(f"Unknown search engine: {SEARCH_ENGINE}")

        print(f"\nSeed URLs ({len(seed_urls)}):", flush=True)
        for index, url in enumerate(seed_urls[:20], 1):
            print(f"  {index}. {url}", flush=True)
        if len(seed_urls) > 20:
            print(f"  ... and {len(seed_urls) - 20} more", flush=True)

        # Step 2 & 3: BFS crawl
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

        scraped_data, crawl_counts = bfs_crawl(
            driver,
            seed_urls,
            sink,
            run_id,
        )

        manifest = {
            "schema_version": 2,
            "status": "succeeded",
            "org_id": ORG_ID,
            "run_id": run_id,
            "started_at": format_utc(started_at),
            "completed_at": format_utc(utc_now()),
            "config": {
                "org_id": ORG_ID,
                "search_engine": SEARCH_ENGINE,
                "query": QUERY,
                "keywords": KEYWORDS,
                "max_depth": MAX_DEPTH,
                "max_pages": MAX_PAGES,
                "max_visited_urls": MAX_VISITED_URLS,
                "max_queue_size": MAX_QUEUE_SIZE,
            },
            "seed_urls": seed_urls,
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
