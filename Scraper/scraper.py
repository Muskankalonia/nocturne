import sys
import requests
from bs4 import BeautifulSoup
import time
import json

def create_session():
    session = requests.Session()
    session.proxies = {
        "http": "socks5h://127.0.0.1:9050",
        "https": "socks5h://127.0.0.1:9050",
    }
    session.headers.update({
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; rv:109.0) Gecko/20100101 Firefox/115.0"
    })
    return session

def search_ahmia(session, query, pages=1):
    results = []
    for page in range(pages):
        url = f"https://ahmia.fi/search/?q={query}&p={page}"
        print(f"Searching page {page + 1} for: {query}", flush=True)

        try:
            resp = session.get(url, timeout=60)
            soup = BeautifulSoup(resp.text, "html.parser")

            # Try multiple possible selectors
            items = soup.select("li.result") or soup.select(".result") or soup.select("ol li")

            if not items:
                # Dump all links as fallback
                for a in soup.find_all("a", href=True):
                    href = a["href"]
                    if ".onion" in href:
                        results.append({
                            "title": a.get_text(strip=True),
                            "url": href,
                            "description": "",
                        })
            else:
                for item in items:
                    title_tag = item.find(["h4", "h3", "a"])
                    link_tag = item.find("a", href=True)
                    desc_tag = item.find("p")

                    if link_tag:
                        results.append({
                            "title": title_tag.get_text(strip=True) if title_tag else "N/A",
                            "url": link_tag["href"],
                            "description": desc_tag.get_text(strip=True) if desc_tag else "",
                        })

            time.sleep(5)
        except Exception as e:
            print(f"Error on page {page + 1}: {e}", flush=True)

    return results

if __name__ == "__main__":
    print("Python script started", flush=True)
    session = create_session()

    # Verify Tor
    resp = session.get("https://check.torproject.org/api/ip", timeout=60)
    data = resp.json()
    print(f"Tor: {data}", flush=True)

    if not data.get("IsTor"):
        sys.exit("Not on Tor!")

    # Search
    query = "hacking tools"
    results = search_ahmia(session, query, pages=2)

    print(f"\nFound {len(results)} results:\n", flush=True)
    for i, r in enumerate(results[:20], 1):
        print(f"{i}. {r['title']}", flush=True)
        print(f"   {r['url']}", flush=True)
        if r['description']:
            print(f"   {r['description'][:100]}", flush=True)
        print(flush=True)

    # Save results
    with open("/tmp/results.json", "w") as f:
        json.dump(results, f, indent=2)
    print(f"Saved {len(results)} results to /tmp/results.json", flush=True)