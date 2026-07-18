import sys
import time
import json
import os
import re
import yaml
from collections import deque
from urllib.parse import urlparse, parse_qs
from selenium import webdriver
from selenium.webdriver.chrome.options import Options as ChromeOptions
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from bs4 import BeautifulSoup


# Load config
with open("/app/config.yaml", "r") as f:
    config = yaml.safe_load(f)

OUTPUT_DIR = "/tmp/scraped_pages"
MAX_DEPTH = config.get("max_depth", 2)
MAX_PAGES = config.get("max_pages", 30)
KEYWORDS = [kw.lower() for kw in config.get("keywords", [])]
SEARCH_ENGINE = config.get("search_engine", "ahmia")
QUERY = config.get("query", "security research")


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
    driver = create_direct_driver()
    seed_urls = []

    try:
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

    driver.quit()

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


def sanitize_filename(url):
    name = re.sub(r'https?://', '', url)
    name = re.sub(r'[^\w\-.]', '_', name)
    return name[:100] + ".txt"


def save_page(url, title, text, depth, page_num, matched_keywords):
    filename = f"{page_num:03d}_depth{depth}_{sanitize_filename(url)}"
    filepath = os.path.join(OUTPUT_DIR, filename)

    with open(filepath, "w", encoding="utf-8") as f:
        f.write(f"URL: {url}\n")
        f.write(f"Title: {title}\n")
        f.write(f"Depth: {depth}\n")
        f.write(f"Keywords matched: {', '.join(matched_keywords)}\n")
        f.write(f"Scraped at: {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime())}\n")
        f.write(f"{'=' * 80}\n\n")
        f.write(text)

    return filepath


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


def bfs_crawl(driver, seed_urls):
    print(f"\n[STEP 2 & 3] BFS Crawl (max_depth={MAX_DEPTH}, max_pages={MAX_PAGES})", flush=True)
    print(f"  Keywords filter: {KEYWORDS if KEYWORDS else 'NONE (saving all)'}\n", flush=True)

    queue = deque()
    for url in seed_urls:
        if not url.startswith("http"):
            url = "http://" + url
        queue.append((url, 0))

    visited = set()
    scraped_data = []
    page_count = 0
    skipped_no_keyword = 0

    while queue and page_count < MAX_PAGES:
        url, depth = queue.popleft()

        if url in visited or depth > MAX_DEPTH:
            continue
        visited.add(url)

        print(f"  [{page_count + 1}/{MAX_PAGES}] Depth {depth} | {url}", flush=True)

        try:
            driver.get(url)
            time.sleep(10)

            # Skip Chrome error pages
            page_source = driver.page_source
            if any(err in page_source for err in [
                "ERR_TIMED_OUT", "ERR_CONNECTION_REFUSED", "ERR_SOCKS_CONNECTION_FAILED",
                "ERR_NAME_NOT_RESOLVED", "This site can't be reached",
                "took too long to respond", "net::ERR_", "about:neterror"
            ]):
                print(f"    SKIPPED: Site unreachable", flush=True)
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
                if link not in visited:
                    queue.append((link, depth + 1))
                    added += 1

            # Keyword filtering - only save if keywords match
            has_match, matched_keywords = keyword_match(text)

            if has_match:
                page_count += 1
                filepath = save_page(url, title, text, depth, page_count, matched_keywords)
                print(f"    SAVED | Title: {title}", flush=True)
                print(f"    Keywords: {matched_keywords}", flush=True)
                print(f"    Content: {len(text)} chars | File: {os.path.basename(filepath)}", flush=True)

                scraped_data.append({
                    "url": url,
                    "title": title,
                    "depth": depth,
                    "content_length": len(text),
                    "keywords_matched": matched_keywords,
                    "links_found": len(new_links),
                    "file": os.path.basename(filepath),
                })
            else:
                skipped_no_keyword += 1
                print(f"    NO KEYWORD MATCH - skipped (links still followed)", flush=True)

            print(f"    Links: {len(new_links)} found, {added} added to queue", flush=True)

        except Exception as e:
            print(f"    FAILED: {type(e).__name__}: {str(e)[:100]}", flush=True)

        time.sleep(5)

    print(f"\n  Pages saved: {page_count}", flush=True)
    print(f"  Pages skipped (no keyword): {skipped_no_keyword}", flush=True)
    return scraped_data


if __name__ == "__main__":
    print("=" * 60, flush=True)
    print("  DARK WEB BFS CRAWLER", flush=True)
    print("=" * 60, flush=True)
    print(f"\n  Config:", flush=True)
    print(f"    Search engine: {SEARCH_ENGINE}", flush=True)
    print(f"    Query: {QUERY}", flush=True)
    print(f"    Keywords: {KEYWORDS if KEYWORDS else 'None (save all)'}", flush=True)
    print(f"    Max depth: {MAX_DEPTH}", flush=True)
    print(f"    Max pages: {MAX_PAGES}", flush=True)

    os.makedirs(OUTPUT_DIR, exist_ok=True)

    # Step 1: Search
    if SEARCH_ENGINE == "ahmia":
        seed_urls = search_ahmia(QUERY, pages=2)
    else:
        print(f"  Unknown search engine: {SEARCH_ENGINE}", flush=True)
        sys.exit(1)

    print(f"\nSeed URLs ({len(seed_urls)}):", flush=True)
    for i, url in enumerate(seed_urls[:20], 1):
        print(f"  {i}. {url}", flush=True)
    if len(seed_urls) > 20:
        print(f"  ... and {len(seed_urls) - 20} more", flush=True)

    # Step 2 & 3: BFS crawl
    print("\nStarting Tor browser...", flush=True)
    driver = create_tor_driver()

    print("Verifying Tor connection...", flush=True)
    driver.get("https://check.torproject.org")
    time.sleep(5)
    if "Congratulations" in driver.page_source:
        print("Tor verified!\n", flush=True)
    else:
        print("WARNING: Tor may not be connected\n", flush=True)

    scraped_data = bfs_crawl(driver, seed_urls)
    driver.quit()

    # Save summary
    summary = {
        "config": config,
        "seed_urls": seed_urls,
        "total_pages_scraped": len(scraped_data),
        "pages": scraped_data,
    }
    summary_path = os.path.join(OUTPUT_DIR, "crawl_summary.json")
    with open(summary_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2, ensure_ascii=False)

    print(f"\n{'=' * 60}", flush=True)
    print(f"  CRAWL COMPLETE", flush=True)
    print(f"  Pages saved (keyword match): {len(scraped_data)}", flush=True)
    print(f"  Output: {OUTPUT_DIR}", flush=True)
    print(f"{'=' * 60}", flush=True)