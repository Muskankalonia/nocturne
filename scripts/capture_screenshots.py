#!/usr/bin/env python3
"""Capture needs-review pages over Tor so an admin can look at them safely.

The console cannot do this itself. It runs on Cloud Run with no route to an
onion service and with privileged Snowflake credentials in its environment, and
it is the last process that should be rendering an adversary's page. So the
console only ever writes a request row, and this worker — a separate process,
behind Tor, holding nothing but its own credentials — does the fetching.

    NOCTURNE.CONFIG.PAGE_SCREENSHOTS
        console: INSERT status='requested'
        worker:  claim -> 'capturing' -> upload PNG -> 'captured' | 'failed'
        worker:  reap  -> 'capturing' abandoned past the stale window goes back
                          to 'requested', or to 'failed' once attempts run out
        console: reads status, streams the image back through an authed route

The reaper exists because 'capturing' is the one state nothing else can leave.
The queue view only offers 'requested' rows, so a worker that dies mid-capture
strands its row where no worker will look at it again — and the console reports
"still queued" indefinitely for a capture nobody is attempting.

Requires a local Tor SOCKS proxy on 127.0.0.1:9050 — the same one the crawler
uses — and Playwright's Chromium:

    pip install -r requirements.txt
    playwright install chromium

Usage:
    python scripts/capture_screenshots.py                # drain and exit
    python scripts/capture_screenshots.py --watch        # poll continuously
    python scripts/capture_screenshots.py --max 5
"""

from __future__ import annotations

import argparse
import logging
import os
import re
import socket
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import snowflake.connector
from google.cloud import storage as gcs_storage

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

log = logging.getLogger("nocturne_capture")

TOR_HOST = os.environ.get("TOR_SOCKS_HOST", "127.0.0.1")
TOR_PORT = int(os.environ.get("TOR_SOCKS_PORT", "9050"))

# Onion services are slow and frequently half-dead. These are generous on
# purpose: the alternative to waiting is a "failed" row that tells the admin
# nothing about whether the page exists.
PAGE_TIMEOUT_MS = int(os.environ.get("NOCTURNE_CAPTURE_TIMEOUT_MS", "90000"))
SETTLE_MS = 2500

# Waiting-room and bot-check pages. Dread gates every request behind an access
# queue, and these pages return HTTP 200 with real markup — only the visible
# text distinguishes a queue from content. Screenshotting one produces a
# perfectly successful capture of a page that tells the admin nothing.
#
# Kept in sync with INTERSTITIAL_PATTERNS in src/nocturne_crawler/scraper.py.
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

# Same budget the crawler uses, and for the same reason: Dread's queue is
# routinely minutes long, and a capture that gives up early is a capture of the
# waiting room.
INTERSTITIAL_WAIT = int(
    os.environ.get("INTERSTITIAL_WAIT", os.environ.get("NOCTURNE_INTERSTITIAL_WAIT", "300"))
)
INTERSTITIAL_POLL = int(os.environ.get("INTERSTITIAL_POLL", "15"))

VIEWPORT = {"width": 1280, "height": 1600}

# How often an idle watcher says it is still alive. Long enough that a quiet
# week is a handful of lines, short enough that "nothing since yesterday" is
# unambiguously a fault rather than a quiet queue.
HEARTBEAT_SECONDS = int(os.environ.get("NOCTURNE_CAPTURE_HEARTBEAT_SECONDS", "900"))

# Where captures land. Separate prefix from raw/crawls/ so the Snowflake stage
# that COPYs crawl pages never sees a PNG.
OBJECT_PREFIX = "screenshots/needs-review"


def load_dotenv() -> None:
    """Load .env from the project root, matching deploy_pipeline.py."""
    env_path = PROJECT_ROOT / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" in line:
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value


def connect_snowflake() -> snowflake.connector.SnowflakeConnection:
    account = os.environ.get("SNOWFLAKE_ACCOUNT")
    if not account:
        raise SystemExit("SNOWFLAKE_ACCOUNT is required.")

    warehouse = os.environ.get("SNOWFLAKE_WAREHOUSE", "COMPUTE_WH")
    role = os.environ.get("SNOWFLAKE_ROLE", "ACCOUNTADMIN")
    token = os.environ.get("SNOWFLAKE_TOKEN")

    if token:
        return snowflake.connector.connect(
            account=account,
            user=os.environ.get("SNOWFLAKE_USER", ""),
            token=token,
            authenticator="programmatic_access_token",
            warehouse=warehouse,
            role=role,
        )

    password = os.environ.get("SNOWFLAKE_PASSWORD")
    if not password:
        raise SystemExit("Set SNOWFLAKE_TOKEN or SNOWFLAKE_PASSWORD.")
    return snowflake.connector.connect(
        account=account,
        user=os.environ.get("SNOWFLAKE_USER", ""),
        password=password,
        warehouse=warehouse,
        role=role,
    )


def require_bucket() -> str:
    bucket = (
        os.environ.get("NOCTURNE_SCREENSHOT_BUCKET")
        or os.environ.get("NOCTURNE_MANUAL_UPLOAD_BUCKET")
        or os.environ.get("GCS_BUCKET")
    )
    if not bucket:
        raise SystemExit(
            "Set NOCTURNE_SCREENSHOT_BUCKET (or NOCTURNE_MANUAL_UPLOAD_BUCKET) "
            "to the bucket captures should be written to."
        )
    return bucket


def wait_for_tor(timeout: int = 60) -> None:
    """Fail loudly rather than silently capturing over the clearnet.

    Without the proxy, Chromium would happily fetch an http:// URL directly —
    from the operator's own address. For a tool whose whole job is looking at
    criminal marketplaces, degrading to a direct connection is the one failure
    mode that must never be quiet.
    """
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection((TOR_HOST, TOR_PORT), timeout=2):
                log.info("Tor SOCKS proxy ready at %s:%s", TOR_HOST, TOR_PORT)
                return
        except OSError:
            time.sleep(2)
    raise SystemExit(
        f"No Tor SOCKS proxy at {TOR_HOST}:{TOR_PORT}. Start Tor before capturing; "
        "captures are never taken over a direct connection."
    )


# How long a claim may go unfinished before another worker may take the row.
#
# Derived from the timeouts rather than fixed, because the failure mode of
# guessing low is two workers rendering the same onion page at once. The floor
# is roughly twice the worst case a single capture can legitimately take: the
# interstitial wait, then a full page timeout, then settling and upload.
def stale_claim_seconds() -> int:
    worst_case = INTERSTITIAL_WAIT + (PAGE_TIMEOUT_MS / 1000) + (SETTLE_MS / 1000) + 60
    configured = int(os.environ.get("NOCTURNE_CAPTURE_STALE_SECONDS", "900"))
    return max(configured, int(worst_case * 2))


# Claims allowed before a row is called failed instead of being requeued. A page
# that kills its worker every time would otherwise be immortal: reaped, retried,
# crashed, forever, with the queue never draining past it.
MAX_CAPTURE_ATTEMPTS = int(os.environ.get("NOCTURNE_CAPTURE_MAX_ATTEMPTS", "3"))


def reap_stale_claims(conn) -> int:
    """Return abandoned 'capturing' rows to the queue.

    A worker that dies mid-capture — OOM, task timeout, a Cloud Run revision
    replaced under it — leaves its row in 'capturing'. VW_SCREENSHOT_QUEUE only
    offers rows in 'requested', so nothing would ever pick that row up again:
    the console polls for its eight-minute budget and then reports "still
    queued" forever, about a capture no process is attempting.

    This runs at the top of every pass, which means a restarted worker cleans up
    after the instance it replaced before it does anything else.
    """
    stale = stale_claim_seconds()
    cursor = conn.cursor()
    try:
        # Exhausted first, so a poison row cannot be handed back to the queue by
        # the branch below on the same pass.
        cursor.execute(
            """
            UPDATE NOCTURNE.CONFIG.PAGE_SCREENSHOTS
            SET STATUS = 'failed',
                CAPTURE_ERROR = %s
            WHERE STATUS = 'capturing'
              AND COALESCE(CAPTURE_ATTEMPTS, 0) >= %s
              AND COALESCE(CLAIMED_AT, REQUESTED_AT)
                  < DATEADD(second, -%s, CURRENT_TIMESTAMP())
            """,
            (
                f"Abandoned by {MAX_CAPTURE_ATTEMPTS} workers without completing. "
                "The page may be crashing the browser; capture it manually or retry later.",
                MAX_CAPTURE_ATTEMPTS,
                stale,
            ),
        )
        exhausted = cursor.rowcount or 0

        # COALESCE onto REQUESTED_AT covers rows claimed before CLAIMED_AT
        # existed; without it those would sit in 'capturing' permanently, which
        # is the very state this exists to clear.
        cursor.execute(
            """
            UPDATE NOCTURNE.CONFIG.PAGE_SCREENSHOTS
            SET STATUS = 'requested',
                CAPTURE_ERROR = 'Requeued after a worker abandoned the capture.',
                CLAIMED_AT = NULL
            WHERE STATUS = 'capturing'
              AND COALESCE(CLAIMED_AT, REQUESTED_AT)
                  < DATEADD(second, -%s, CURRENT_TIMESTAMP())
            """,
            (stale,),
        )
        requeued = cursor.rowcount or 0
    finally:
        cursor.close()

    if requeued or exhausted:
        log.warning(
            "Reaped stale claims older than %ss: %s requeued, %s gave up",
            stale,
            requeued,
            exhausted,
        )
    return requeued


def claim_next(conn, worker_id: str) -> dict[str, Any] | None:
    """Take exactly one queued request, or return None.

    The UPDATE is the claim and the WHERE clause is the lock: two workers on the
    same schedule race here, and only the one whose UPDATE matches a row still
    in 'requested' gets it. Nothing else in this script needs a transaction.
    """
    cursor = conn.cursor(snowflake.connector.DictCursor)
    try:
        cursor.execute(
            """
            SELECT ORG_ID, MONITOR_KEY, DEDUPE_KEY, URL
            FROM NOCTURNE.DASHBOARD.VW_SCREENSHOT_QUEUE
            LIMIT 1
            """
        )
        row = cursor.fetchone()
        if not row:
            return None

        cursor.execute(
            """
            UPDATE NOCTURNE.CONFIG.PAGE_SCREENSHOTS
            SET STATUS = 'capturing',
                CAPTURE_ERROR = %s,
                CLAIMED_AT = CURRENT_TIMESTAMP(),
                CAPTURE_ATTEMPTS = COALESCE(CAPTURE_ATTEMPTS, 0) + 1
            WHERE ORG_ID = %s AND MONITOR_KEY = %s AND STATUS = 'requested'
            """,
            (f"claimed by {worker_id}", row["ORG_ID"], row["MONITOR_KEY"]),
        )
        if cursor.rowcount != 1:
            # Lost the race. Returning None ends this pass; the next one picks
            # up whatever is still queued.
            return None
        return row
    finally:
        cursor.close()


def mark_captured(
    conn, org_id: str, monitor_key: str, object_uri: str, page_title: str
) -> None:
    cursor = conn.cursor()
    try:
        cursor.execute(
            """
            UPDATE NOCTURNE.CONFIG.PAGE_SCREENSHOTS
            SET STATUS = 'captured',
                OBJECT_URI = %s,
                PAGE_TITLE = %s,
                CAPTURE_ERROR = NULL,
                CAPTURED_AT = CURRENT_TIMESTAMP()
            WHERE ORG_ID = %s AND MONITOR_KEY = %s
            """,
            (object_uri, page_title[:300], org_id, monitor_key),
        )
    finally:
        cursor.close()


def mark_failed(conn, org_id: str, monitor_key: str, error: str) -> None:
    cursor = conn.cursor()
    try:
        cursor.execute(
            """
            UPDATE NOCTURNE.CONFIG.PAGE_SCREENSHOTS
            SET STATUS = 'failed', CAPTURE_ERROR = %s
            WHERE ORG_ID = %s AND MONITOR_KEY = %s
            """,
            (error[:500], org_id, monitor_key),
        )
    finally:
        cursor.close()


def upload_png(bucket_name: str, object_path: str, png: bytes) -> str:
    client = gcs_storage.Client()
    blob = client.bucket(bucket_name).blob(object_path)
    # Private by construction: this is an unmasked rendering of a dark-web page.
    # The console proxies it through an authenticated route; nothing about this
    # object should be reachable without one.
    blob.upload_from_string(png, content_type="image/png")
    return f"gs://{bucket_name}/{object_path}"


def looks_like_interstitial(page) -> bool:
    """True for a waiting room that will forward us on its own.

    Only the head of the visible text is inspected, mirroring the crawler: a
    forum thread quoting "please do not refresh" further down the page is
    content, not a queue, and treating it as one would stall every capture of
    the thread that actually matters.
    """
    try:
        text = (page.inner_text("body") or "")[:600].lower()
    except Exception:  # noqa: BLE001 - a page mid-navigation has no body yet
        return False
    return any(re.search(pattern, text) for pattern in INTERSTITIAL_PATTERNS)


def wait_out_interstitial(page, budget: int) -> bool:
    """Hold the tab open until the waiting room forwards us.

    Deliberately never re-navigates. These pages redirect themselves and warn
    explicitly that reloading forfeits your place in the queue, so a retry loop
    is slower than waiting and can lose the slot entirely.

    Returns True if the queue cleared, False if the budget ran out.
    """
    deadline = time.monotonic() + budget
    log.info("    queue: waiting up to %ss to be forwarded", budget)

    while time.monotonic() < deadline:
        page.wait_for_timeout(
            min(INTERSTITIAL_POLL, max(1, int(deadline - time.monotonic()))) * 1000
        )
        if not looks_like_interstitial(page):
            log.info("    queue: cleared after ~%ss", int(budget - (deadline - time.monotonic())))
            return True

    log.warning("    queue: still queued after %ss", budget)
    return False


def capture(page, url: str) -> tuple[bytes, str, bool]:
    """Render one page and return the PNG, its title, and whether it is content.

    The third value is False when the shot is of a waiting room rather than the
    page itself. The caller records that as a failure: an image the admin cannot
    rule on is worse than no image, because the row looks handled.
    """
    page.goto(url, wait_until="domcontentloaded", timeout=PAGE_TIMEOUT_MS)
    # Marketplace listings load their prices and tables late. A short settle
    # beats networkidle, which on an onion service frequently never fires.
    page.wait_for_timeout(SETTLE_MS)

    cleared = True
    if INTERSTITIAL_WAIT and looks_like_interstitial(page):
        cleared = wait_out_interstitial(page, INTERSTITIAL_WAIT)
        if cleared:
            # The forwarded page is a fresh document; give it the same settle.
            page.wait_for_timeout(SETTLE_MS)

    title = ""
    try:
        title = page.title() or ""
    except Exception:  # noqa: BLE001 - a title is nice to have, never required
        title = ""
    return page.screenshot(full_page=True, type="png"), title, cleared


def run_once(conn, bucket: str, worker_id: str, limit: int) -> int:
    from playwright.sync_api import sync_playwright

    processed = 0
    # Before claiming anything: a worker that has just replaced a dead one is
    # the only thing in a position to free the row that died with it.
    try:
        reap_stale_claims(conn)
    except Exception as error:  # noqa: BLE001
        # Never fatal. Reaping is maintenance; failing it must not stop the
        # worker from capturing the rows that are queued and healthy.
        log.warning("Reaping stale claims failed: %s", error)

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=True,
            proxy={"server": f"socks5://{TOR_HOST}:{TOR_PORT}"},
            args=["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
        )
        try:
            while processed < limit:
                request = claim_next(conn, worker_id)
                if not request:
                    break

                org_id = request["ORG_ID"]
                monitor_key = request["MONITOR_KEY"]
                url = request["URL"]
                log.info("Capturing %s for %s", url, org_id)

                # A fresh context per page: no cookies, storage, or cache
                # carried from one marketplace to the next, so two captures can
                # never be correlated through this worker.
                context = browser.new_context(
                    viewport=VIEWPORT,
                    java_script_enabled=True,
                    ignore_https_errors=True,
                    user_agent=(
                        "Mozilla/5.0 (Windows NT 10.0; rv:115.0) "
                        "Gecko/20100101 Firefox/115.0"
                    ),
                )
                page = context.new_page()
                try:
                    png, title, cleared = capture(page, url)
                    if not cleared:
                        # Still in the waiting room. Recording this as failed
                        # sends it back to the queue on the admin's next click,
                        # which is the right outcome: the site was reachable,
                        # just not yet willing to show us the page.
                        mark_failed(
                            conn,
                            org_id,
                            monitor_key,
                            f"Site held the request in an access queue for over "
                            f"{INTERSTITIAL_WAIT}s. Try again later.",
                        )
                        log.warning("  still queued, not captured")
                        processed += 1
                        continue

                    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
                    object_path = (
                        f"{OBJECT_PREFIX}/{org_id}/{monitor_key}-{stamp}.png"
                    )
                    object_uri = upload_png(bucket, object_path, png)
                    mark_captured(conn, org_id, monitor_key, object_uri, title)
                    log.info("  captured -> %s (%d KB)", object_uri, len(png) // 1024)
                except Exception as error:  # noqa: BLE001 - one page must not stop the drain
                    log.warning("  capture failed: %s", error)
                    mark_failed(conn, org_id, monitor_key, str(error))
                finally:
                    page.close()
                    context.close()
                processed += 1
        finally:
            browser.close()
    return processed


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--max", type=int, default=10, help="Captures per pass (default 10)"
    )
    parser.add_argument(
        "--watch", action="store_true", help="Keep polling instead of exiting"
    )
    parser.add_argument(
        "--interval", type=int, default=30, help="Seconds between polls with --watch"
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s  %(levelname)-7s %(message)s",
        datefmt="%H:%M:%S",
    )
    load_dotenv()

    bucket = require_bucket()
    wait_for_tor()
    worker_id = f"{socket.gethostname()}/{os.getpid()}"
    conn = connect_snowflake()

    # Say so once at startup. Without this the first evidence that the worker
    # reached Snowflake at all is its first capture, which may be days away.
    log.info(
        "Worker %s ready. Polling every %ss; heartbeat every %d minutes.",
        worker_id,
        args.interval,
        HEARTBEAT_SECONDS // 60,
    )
    idle_passes = 0
    last_heartbeat = time.monotonic()

    try:
        while True:
            try:
                processed = run_once(conn, bucket, worker_id, args.max)
            except KeyboardInterrupt:
                raise
            except Exception as error:  # noqa: BLE001 - see below
                # A watcher is meant to outlive the things it depends on. A
                # warehouse that suspended, a token that expired, or a schema
                # that has not been deployed yet are all states the next poll
                # may well find resolved, so they are logged and retried rather
                # than fatal. A one-shot run still exits non-zero, because
                # there is no next poll to recover in.
                log.error("Capture pass failed: %s", error)
                if not args.watch:
                    raise SystemExit(1) from error
                time.sleep(args.interval)
                continue

            if processed:
                log.info("Processed %d capture request(s).", processed)
                idle_passes = 0
                last_heartbeat = time.monotonic()
            elif not args.watch:
                log.info("Nothing queued.")
            else:
                # A watcher that only speaks when it works is indistinguishable
                # from a watcher that has died. Both produce silence, and the
                # silence lasts exactly as long as nobody happens to request a
                # capture — which on a quiet week is the whole week.
                #
                # Logging every idle pass would bury the lines that matter under
                # 4,320 nothing-happened entries a day, so this reports on a
                # fixed wall-clock interval instead of per pass.
                idle_passes += 1
                if time.monotonic() - last_heartbeat >= HEARTBEAT_SECONDS:
                    log.info(
                        "Idle: queue empty across %d poll(s) in the last %d minutes.",
                        idle_passes,
                        HEARTBEAT_SECONDS // 60,
                    )
                    idle_passes = 0
                    last_heartbeat = time.monotonic()

            if not args.watch:
                return
            time.sleep(args.interval)
    except KeyboardInterrupt:
        log.info("Stopped.")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
