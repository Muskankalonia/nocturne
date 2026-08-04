#!/usr/bin/env python3
"""Emit crawler settings for one monitored organization.

The crawler deliberately has no Snowflake dependency — it only needs a slug and
a search query, both of which it already reads from the environment. This script
is the bridge: it reads the organization profile that the Monitored Assets page
writes to NOCTURNE.CONFIG.MONITORED_ORGANIZATIONS and prints the environment a
crawl should run with, so what an analyst types in the UI is what gets searched.

    # inspect
    python scripts/org_crawl_config.py --org-id palo_alto_networks

    # run a crawl with it
    set -a && eval "$(python scripts/org_crawl_config.py --org-id att)" && set +a
    python -m nocturne_crawler.scraper

Credentials come from the same environment variables deploy_pipeline.py uses.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import sys
from pathlib import Path

import snowflake.connector

PROJECT_ROOT = Path(__file__).resolve().parent.parent
ORG_ID_PATTERN = re.compile(r"^[a-z0-9]+(?:_[a-z0-9]+)*$")


def load_env_file(path: Path) -> None:
    """Mirror deploy_pipeline.py: a local .env is a convenience, not required."""
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, _, value = stripped.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise SystemExit(f"Missing required environment variable: {name}")
    return value


def connect() -> snowflake.connector.SnowflakeConnection:
    token = os.environ.get("SNOWFLAKE_TOKEN", "").strip()
    password = os.environ.get("SNOWFLAKE_PASSWORD", "").strip()
    if not token and not password:
        raise SystemExit("Set SNOWFLAKE_TOKEN or SNOWFLAKE_PASSWORD.")

    auth = (
        {"token": token, "authenticator": "PROGRAMMATIC_ACCESS_TOKEN"}
        if token
        else {"password": password}
    )
    return snowflake.connector.connect(
        account=required_env("SNOWFLAKE_ACCOUNT"),
        user=required_env("SNOWFLAKE_USER"),
        warehouse=os.environ.get("SNOWFLAKE_WAREHOUSE", "COMPUTE_WH"),
        role=os.environ.get("SNOWFLAKE_ROLE", "ACCOUNTADMIN"),
        database=os.environ.get("SNOWFLAKE_DATABASE", "NOCTURNE"),
        schema="CONFIG",
        session_parameters={"QUERY_TAG": "NOCTURNE_CRAWLER_CONFIG_READ"},
        **auth,
    )


def fetch_organization(conn, org_id: str) -> dict:
    cur = conn.cursor(snowflake.connector.DictCursor)
    try:
        cur.execute(
            """
            SELECT ORG_ID, CANONICAL_NAME, ALIASES, DOMAINS, PRODUCTS, ENABLED
            FROM NOCTURNE.CONFIG.MONITORED_ORGANIZATIONS
            WHERE ORG_ID = %s
            """,
            (org_id,),
        )
        row = cur.fetchone()
    finally:
        cur.close()
    if not row:
        raise SystemExit(f"No monitored organization with org_id={org_id!r}.")
    return row


def as_list(value) -> list[str]:
    """Snowflake ARRAY columns come back as JSON text through the connector."""
    if isinstance(value, list):
        return [str(item) for item in value]
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return [value]
        return [str(item) for item in parsed] if isinstance(parsed, list) else [str(parsed)]
    return []


def build_query(row: dict, max_terms: int) -> str:
    """Canonical name first, then aliases, then domains — most to least specific.

    Ahmia matches on plain text, so the terms are quoted and OR-joined rather
    than concatenated; an unquoted multi-word name would otherwise match pages
    containing only one of its words.
    """
    terms: list[str] = []
    seen: set[str] = set()
    for value in [row.get("CANONICAL_NAME"), *as_list(row.get("ALIASES")), *as_list(row.get("DOMAINS"))]:
        term = str(value or "").strip()
        if not term:
            continue
        key = term.lower()
        if key in seen:
            continue
        seen.add(key)
        terms.append(term)
        if len(terms) >= max_terms:
            break
    if not terms:
        raise SystemExit(
            f"{row.get('ORG_ID')} has no canonical name, aliases, or domains to search for."
        )
    return " OR ".join(f'"{term}"' for term in terms)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--org-id", required=True, help="lowercase slug, e.g. palo_alto_networks")
    parser.add_argument(
        "--max-terms",
        type=int,
        default=6,
        help="cap on OR'd search terms (default: 6)",
    )
    parser.add_argument(
        "--format",
        choices=("env", "json"),
        default="env",
        help="env prints shell-quoted KEY=VALUE lines; json prints the resolved profile",
    )
    parser.add_argument(
        "--allow-disabled",
        action="store_true",
        help="emit config even when monitoring is paused for the organization",
    )
    args = parser.parse_args()

    if not ORG_ID_PATTERN.fullmatch(args.org_id):
        raise SystemExit("--org-id must be a lowercase slug of letters, numbers and single underscores.")
    if args.max_terms < 1:
        raise SystemExit("--max-terms must be at least 1.")

    load_env_file(PROJECT_ROOT / ".env")
    load_env_file(PROJECT_ROOT / "nocturne_dashboard" / ".env.local")

    conn = connect()
    try:
        row = fetch_organization(conn, args.org_id)
    finally:
        conn.close()

    enabled = str(row.get("ENABLED")).strip().lower() in {"true", "1"}
    if not enabled and not args.allow_disabled:
        # Paused monitoring is a deliberate state; crawling anyway would spend
        # money collecting pages the pipeline is configured to ignore.
        raise SystemExit(
            f"Monitoring is paused for {args.org_id}. Re-enable it in Monitored Assets, "
            f"or pass --allow-disabled to override."
        )

    query = build_query(row, args.max_terms)

    if args.format == "json":
        print(json.dumps({
            "org_id": row["ORG_ID"],
            "canonical_name": row.get("CANONICAL_NAME"),
            "aliases": as_list(row.get("ALIASES")),
            "domains": as_list(row.get("DOMAINS")),
            "products": as_list(row.get("PRODUCTS")),
            "enabled": enabled,
            "query": query,
        }, indent=2))
    else:
        print(f"ORG_ID={shlex.quote(str(row['ORG_ID']))}")
        print(f"QUERY={shlex.quote(query)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
