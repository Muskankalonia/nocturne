import sys
import time
import json
import os
import re
from collections import deque
from selenium import webdriver
from selenium.webdriver.chrome.options import Options as ChromeOptions
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from bs4 import BeautifulSoup
from urllib.parse import urlparse, parse_qs


OUTPUT_DIR = "/tmp/scraped_pages"
MAX_DEPTH = 2
MAX_PAGES = 30


def create_tor_driver():
    """Chrome routed through Tor for .onion sites."""
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
    """Chrome with anti-detection flags for Ahmia."""
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
    """Step 1: Get seed URLs from Ahmia by submitting the search form."""
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

                # Extract actual .onion URL from Ahmia redirect links
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

    # Deduplicate
    seed_urls = list(dict.fromkeys(seed_urls))
    print(f"\n  Ahmia returned {len(seed_urls)} seed URLs", flush=True)

    if not seed_urls:
        print("\n" + "!" * 60, flush=True)
        print("  WARNING: AHMIA SEARCH FAILED", flush=True)
        print("  Reason: Ahmia requires JavaScript that did not render.", flush=True)
        print("  Action: Falling back to pre-defined seed URLs.", flush=True)
        print("  Note: Results will NOT be based on your search query.", flush=True)
        print("!" * 60 + "\n", flush=True)
        seed_urls = [
            "http://rnsm777cdsjrsdlbs4v5qoeppu3px6sb2igmh53jzrx7ipcrbjz5b2ad.onion/",
            "http://xmh57jrknzkhv6y3ls3ubitzfqnkrwxhopf5aygthi7d6rplyvk3noyd.onion/",
            "https://duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion/",
            "https://www.bbcnewsd73hkzno2ini43t4gblxvycyac5aw4gnv7t2rccijh7745uqd.onion/",
        ]

    return seed_urls


def sanitize_filename(url):
    name = re.sub(r'https?://', '', url)
    name = re.sub(r'[^\w\-.]', '_', name)
    return name[:100] + ".txt"


def save_page(url, title, text, depth, page_num):
    filename = f"{page_num:03d}_depth{depth}_{sanitize_filename(url)}"
    filepath = os.path.join(OUTPUT_DIR, filename)

    with open(filepath, "w", encoding="utf-8") as f:
        f.write(f"URL: {url}\n")
        f.write(f"Title: {title}\n")
        f.write(f"Depth: {depth}\n")
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


def bfs_crawl(driver, seed_urls, max_depth=MAX_DEPTH, max_pages=MAX_PAGES):
    """Step 2 & 3: BFS crawl through .onion sites."""
    print(f"\n[STEP 2 & 3] BFS Crawl (max_depth={max_depth}, max_pages={max_pages})\n", flush=True)

    queue = deque()
    for url in seed_urls:
        if not url.startswith("http"):
            url = "http://" + url
        queue.append((url, 0))

    visited = set()
    scraped_data = []
    page_count = 0

    while queue and page_count < max_pages:
        url, depth = queue.popleft()

        if url in visited or depth > max_depth:
            continue
        visited.add(url)

        print(f"  [{page_count + 1}/{max_pages}] Depth {depth} | {url}", flush=True)

        try:
            driver.get(url)
            time.sleep(10)

            soup = BeautifulSoup(driver.page_source, "html.parser")

            for tag in soup(["script", "style"]):
                tag.decompose()

            title = soup.title.string.strip() if soup.title and soup.title.string else "N/A"
            text = soup.get_text(separator="\n", strip=True)

            page_count += 1
            filepath = save_page(url, title, text, depth, page_count)
            print(f"    Title: {title}", flush=True)
            print(f"    Content: {len(text)} chars | Saved: {os.path.basename(filepath)}", flush=True)

            new_links = extract_onion_links(soup, url)
            added = 0
            for link in new_links:
                if link not in visited:
                    queue.append((link, depth + 1))
                    added += 1
            print(f"    New links found: {len(new_links)} | Added to queue: {added}", flush=True)

            scraped_data.append({
                "url": url,
                "title": title,
                "depth": depth,
                "content_length": len(text),
                "links_found": len(new_links),
                "file": os.path.basename(filepath),
            })

        except Exception as e:
            print(f"    FAILED: {type(e).__name__}: {str(e)[:100]}", flush=True)

        time.sleep(5)

    return scraped_data


if __name__ == "__main__":
    print("=" * 60, flush=True)
    print("  DARK WEB BFS CRAWLER", flush=True)
    print("=" * 60, flush=True)

    os.makedirs(OUTPUT_DIR, exist_ok=True)

    # Take search query from user
    query = input("\nEnter search query: ")
    print(f"  Searching for: '{query}'\n", flush=True)

    # Step 1
    seed_urls = search_ahmia(query, pages=2)

    print(f"\nSeed URLs ({len(seed_urls)}):", flush=True)
    for i, url in enumerate(seed_urls, 1):
        print(f"  {i}. {url}", flush=True)

    # Step 2 & 3
    print("\nStarting Tor browser...", flush=True)
    driver = create_tor_driver()

    print("Verifying Tor connection...", flush=True)
    driver.get("https://check.torproject.org")
    time.sleep(5)
    if "Congratulations" in driver.page_source:
        print("Tor verified!\n", flush=True)
    else:
        print("WARNING: Tor may not be connected\n", flush=True)

    scraped_data = bfs_crawl(driver, seed_urls, max_depth=MAX_DEPTH, max_pages=MAX_PAGES)
    driver.quit()

    # Save summary
    summary = {
        "query": query,
        "seed_urls": seed_urls,
        "total_pages_scraped": len(scraped_data),
        "max_depth": MAX_DEPTH,
        "pages": scraped_data,
    }
    summary_path = os.path.join(OUTPUT_DIR, "crawl_summary.json")
    with open(summary_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2, ensure_ascii=False)

    print(f"\n{'=' * 60}", flush=True)
    print(f"  CRAWL COMPLETE", flush=True)
    print(f"  Pages scraped: {len(scraped_data)}", flush=True)
    print(f"  Output directory: {OUTPUT_DIR}", flush=True)
    print(f"  Summary: crawl_summary.json", flush=True)
    print(f"{'=' * 60}", flush=True)