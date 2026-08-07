"""Resolve which organizations to crawl, and what to search for each.

The Monitored Assets page writes organization profiles to
NOCTURNE.CONFIG.MONITORED_ORGANIZATIONS. Reading them here at run time makes
that table the single source of truth: what an analyst types in the UI is what
the next crawl searches for, with no image rebuild and no environment variables
to keep in sync.

Falls back to the environment and config.yaml when Snowflake is not configured,
which keeps local development and one-off runs working without credentials.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field

ORG_ID_PATTERN = re.compile(r"^[a-z0-9]+(?:_[a-z0-9]+)*$")


@dataclass(frozen=True)
class OrgCrawl:
    """Everything one organization's crawl needs. No module-level state."""

    org_id: str
    query: str
    keywords: list[str] = field(default_factory=list)
    canonical_name: str = ""

    def __post_init__(self):
        if not ORG_ID_PATTERN.fullmatch(self.org_id):
            raise ValueError(
                f"org_id must be a lowercase slug of letters, numbers and "
                f"single underscores; got {self.org_id!r}"
            )
        if not self.query.strip():
            raise ValueError(f"{self.org_id} resolved to an empty search query")


def _as_list(value) -> list[str]:
    """Snowflake ARRAY columns arrive as JSON text through the connector."""
    if isinstance(value, list):
        return [str(item) for item in value]
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return [value]
        return [str(item) for item in parsed] if isinstance(parsed, list) else [str(parsed)]
    return []


def build_query(canonical_name, aliases, domains) -> str:
    """Search for the organization's name alone, quoted.

    Do not OR-join the aliases and domains: neither engine treats OR as a
    boolean operator, so extra terms narrowed the results instead of widening
    them, and Ahmia returned nothing at all. Relevance comes from the keyword
    filter, not the query.
    """
    for value in [canonical_name, *aliases, *domains]:
        term = str(value or "").strip()
        if term:
            # Quoted so a multi-word name cannot match on one of its words.
            return f'"{term}"'
    return ""


def build_keywords(canonical_name, aliases, domains, products) -> list[str]:
    """Terms that mark a fetched page as being about this organization.

    Products belong here but not in the query: they identify a page once
    fetched, while searching for them alone surfaces unrelated product chatter.
    """
    keywords: list[str] = []
    seen: set[str] = set()
    for value in [canonical_name, *aliases, *domains, *products]:
        term = str(value or "").strip()
        if term and term.lower() not in seen:
            seen.add(term.lower())
            keywords.append(term)
    return keywords


def _snowflake_connection():
    import snowflake.connector

    account = os.getenv("SNOWFLAKE_ACCOUNT", "").strip()
    token = os.getenv("SNOWFLAKE_TOKEN", "").strip()
    password = os.getenv("SNOWFLAKE_PASSWORD", "").strip()
    user = os.getenv("SNOWFLAKE_USER", "").strip()

    common = dict(
        account=account,
        user=user,
        warehouse=os.getenv("SNOWFLAKE_WAREHOUSE", "COMPUTE_WH"),
        role=os.getenv("SNOWFLAKE_ROLE", "ACCOUNTADMIN"),
        database=os.getenv("SNOWFLAKE_DATABASE", "NOCTURNE"),
        schema="CONFIG",
        session_parameters={"QUERY_TAG": "NOCTURNE_CRAWLER_CONFIG_READ"},
    )
    if token:
        return snowflake.connector.connect(
            token=token, authenticator="PROGRAMMATIC_ACCESS_TOKEN", **common
        )
    return snowflake.connector.connect(password=password, **common)


def snowflake_configured() -> bool:
    has_account = bool(os.getenv("SNOWFLAKE_ACCOUNT", "").strip())
    has_auth = bool(
        os.getenv("SNOWFLAKE_TOKEN", "").strip()
        or os.getenv("SNOWFLAKE_PASSWORD", "").strip()
    )
    return has_account and has_auth


def fetch_enabled_organizations(org_id: str | None = None) -> list[OrgCrawl]:
    """Read enabled organizations from the table the UI maintains.

    A disabled organization is a deliberate state, so it is never crawled:
    collecting pages the pipeline is configured to ignore costs money for
    nothing.
    """
    query = """
        SELECT ORG_ID, CANONICAL_NAME, ALIASES, DOMAINS, PRODUCTS
        FROM NOCTURNE.CONFIG.MONITORED_ORGANIZATIONS
        WHERE ENABLED = TRUE
    """
    params: tuple = ()
    if org_id:
        query += " AND ORG_ID = %s"
        params = (org_id,)
    query += " ORDER BY ORG_ID"

    connection = _snowflake_connection()
    try:
        cursor = connection.cursor()
        try:
            cursor.execute(query, params or None)
            rows = cursor.fetchall()
        finally:
            cursor.close()
    finally:
        connection.close()

    organizations = []
    for row in rows:
        slug, canonical_name, aliases, domains, products = row
        aliases, domains, products = _as_list(aliases), _as_list(domains), _as_list(products)
        search_query = build_query(canonical_name, aliases, domains)
        if not search_query:
            # Nothing to search for is a profile problem, not a crawl failure:
            # skip it and let the other organizations proceed.
            print(
                f"  SKIP {slug}: no canonical name, aliases, or domains to "
                f"search for; fill them in on the Monitored Assets page",
                flush=True,
            )
            continue
        organizations.append(
            OrgCrawl(
                org_id=str(slug),
                query=search_query,
                keywords=build_keywords(canonical_name, aliases, domains, products),
                canonical_name=str(canonical_name or ""),
            )
        )
    return organizations


def from_environment(config: dict) -> OrgCrawl:
    """Single-organization fallback for local runs without Snowflake."""
    organization = config.get("organization") or {}
    org_id = str(os.getenv("ORG_ID", organization.get("org_id", ""))).strip()
    if not org_id:
        raise ValueError(
            "organization.org_id is required in config.yaml or through ORG_ID"
        )

    raw_keywords = os.getenv("KEYWORDS")
    if raw_keywords is None:
        keywords = [str(k).strip() for k in (config.get("keywords") or []) if str(k).strip()]
    else:
        keywords = [k.strip() for k in re.split(r"[,\n]+", raw_keywords) if k.strip()]

    return OrgCrawl(
        org_id=org_id,
        query=os.getenv("QUERY", config.get("query", "security research")),
        keywords=keywords,
    )


def resolve_organizations(config: dict) -> list[OrgCrawl]:
    """Snowflake when configured, otherwise the environment.

    ORG_ID narrows a Snowflake-driven run to one organization, which keeps
    targeted re-crawls and debugging possible without disabling the others.
    """
    org_id = os.getenv("ORG_ID", "").strip() or None

    if not snowflake_configured():
        print(
            "  Organization source: environment/config.yaml "
            "(SNOWFLAKE_ACCOUNT and credentials not set)",
            flush=True,
        )
        return [from_environment(config)]

    scope = f"ORG_ID={org_id}" if org_id else "all enabled organizations"
    print(f"  Organization source: Snowflake ({scope})", flush=True)
    organizations = fetch_enabled_organizations(org_id)

    if not organizations:
        raise RuntimeError(
            f"No enabled monitored organization matched {scope}. Enable one on "
            f"the Monitored Assets page, or unset ORG_ID to crawl them all."
        )
    return organizations
