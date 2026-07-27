"""
Nocturne Pipeline Deployer

Deploys the Snowflake classification pipeline by executing SQL files in order.
Handles multi-statement SQL files, logs progress, and verifies each step.

Usage:
    # With .env file (recommended for local dev)
    python deploy_pipeline.py

    # With explicit args
    python deploy_pipeline.py --account <account> --user <user> --warehouse COMPUTE_WH

    # Dry run (no connection needed)
    python deploy_pipeline.py --dry-run

Credentials (checked in this order):
    1. CLI arguments (--account, --user, --password)
    2. .env file in project root (auto-loaded)
    3. Environment variables: SNOWFLAKE_ACCOUNT, SNOWFLAKE_USER, SNOWFLAKE_PASSWORD, SNOWFLAKE_WAREHOUSE
"""

import argparse
import os
import sys
import logging
from pathlib import Path

import snowflake.connector


def load_dotenv():
    """Load .env file from project root if it exists."""
    env_path = Path(__file__).parent / ".env"
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


load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("nocturne_deploy")

SQL_DIR = Path(__file__).parent / "snowflake"

DEPLOY_ORDER = [
    "01_storage_integration.sql",
    "02_ingestion_layer.sql",
    "03_detect_indicators_udf.sql",
    "04_dt_regex_indicators.sql",
    "05_dt_classification.sql",
    "06_seed_verify_golive.sql",
]


def parse_sql_statements(filepath: Path) -> list[str]:
    """Split a SQL file into individual statements, handling $$ delimited blocks."""
    content = filepath.read_text(encoding="utf-8")
    statements = []
    current = []
    in_dollar_block = False

    for line in content.splitlines():
        stripped = line.strip()

        # Skip full-line comments (but not inside $$ blocks)
        if stripped.startswith("--") and not in_dollar_block:
            continue

        # Track $$ delimiters (toggle on each occurrence)
        dollar_count = line.count("$$")
        if dollar_count % 2 == 1:
            in_dollar_block = not in_dollar_block

        current.append(line)

        # Only split on ; when NOT inside a $$ block
        if stripped.endswith(";") and not in_dollar_block:
            stmt = "\n".join(current).strip().rstrip(";").strip()
            if stmt:
                statements.append(stmt)
            current = []

    # Handle final statement without trailing semicolon
    remaining = "\n".join(current).strip().rstrip(";").strip()
    if remaining:
        statements.append(remaining)

    return statements


def execute_file(conn: snowflake.connector.SnowflakeConnection, filepath: Path, dry_run: bool = False):
    """Execute all statements in a SQL file."""
    log.info(f"{'[DRY RUN] ' if dry_run else ''}Executing: {filepath.name}")
    statements = parse_sql_statements(filepath)

    for i, stmt in enumerate(statements, 1):
        # Truncate for display
        preview = stmt.replace("\n", " ")[:80]
        log.info(f"  [{i}/{len(statements)}] {preview}...")

        if dry_run:
            continue

        try:
            cur = conn.cursor()
            cur.execute(stmt)
            result = cur.fetchone()
            if result:
                log.info(f"    -> {result[0] if len(result) == 1 else result}")
            cur.close()
        except snowflake.connector.errors.ProgrammingError as e:
            log.error(f"    FAILED: {e.msg}")
            raise

    log.info(f"  Completed {filepath.name} ({len(statements)} statements)")


def verify_pipeline(conn: snowflake.connector.SnowflakeConnection):
    """Run verification queries after deployment."""
    log.info("Verifying pipeline...")

    checks = [
        ("Streams", "SHOW STREAMS IN SCHEMA NOCTURNE.RAW"),
        ("Tasks", "SHOW TASKS IN SCHEMA NOCTURNE.RAW"),
        ("Dynamic Tables", "SHOW DYNAMIC TABLES IN SCHEMA NOCTURNE.RAW"),
        ("Raw pages count", "SELECT COUNT(*) AS cnt FROM NOCTURNE.RAW.CRAWL_PAGES"),
        ("Classification results", "SELECT CATEGORY, COUNT(*) AS cnt FROM NOCTURNE.RAW.DT_PAGE_CLASSIFICATION GROUP BY CATEGORY ORDER BY cnt DESC"),
    ]

    cur = conn.cursor()
    for name, query in checks:
        try:
            cur.execute(query)
            rows = cur.fetchall()
            if rows:
                log.info(f"  {name}: {rows}")
            else:
                log.warning(f"  {name}: no results (may still be refreshing)")
        except Exception as e:
            log.warning(f"  {name}: {e}")
    cur.close()


def generate_report(conn: snowflake.connector.SnowflakeConnection, output_path: Path):
    """Generate a full classification report and save to file."""
    import json
    from datetime import datetime

    log.info(f"Generating report -> {output_path}")
    cur = conn.cursor(snowflake.connector.DictCursor)

    # Summary stats
    cur.execute("SELECT COUNT(*) AS total FROM NOCTURNE.RAW.CRAWL_PAGES")
    total = cur.fetchone()["TOTAL"]

    cur.execute("SELECT CATEGORY, COUNT(*) AS CNT FROM NOCTURNE.RAW.DT_PAGE_CLASSIFICATION GROUP BY CATEGORY ORDER BY CNT DESC")
    categories = cur.fetchall()

    # Full classification details
    cur.execute("""
        SELECT DOC_ID, TITLE, URL, CATEGORY, INDICATORS_FOUND, RAW_TEXT
        FROM NOCTURNE.RAW.DT_PAGE_CLASSIFICATION
        ORDER BY CATEGORY, TITLE
    """)
    pages = cur.fetchall()
    cur.close()

    # Build report
    lines = []
    lines.append("=" * 80)
    lines.append("NOCTURNE CLASSIFICATION REPORT")
    lines.append(f"Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    lines.append("=" * 80)
    lines.append("")
    lines.append("SUMMARY")
    lines.append("-" * 40)
    lines.append(f"  Total pages ingested: {total}")
    for cat in categories:
        lines.append(f"  {cat['CATEGORY']:12s}: {cat['CNT']}")
    lines.append("")
    lines.append("")

    # Group by category
    for category_name in ["malware", "violation", "benign"]:
        category_pages = [p for p in pages if p["CATEGORY"] == category_name]
        if not category_pages:
            continue

        lines.append("=" * 80)
        lines.append(f"  CATEGORY: {category_name.upper()} ({len(category_pages)} pages)")
        lines.append("=" * 80)

        for i, page in enumerate(category_pages, 1):
            lines.append("")
            lines.append(f"--- [{i}] {page['TITLE']} ---")
            lines.append(f"  URL: {page['URL']}")
            lines.append(f"  DOC_ID: {page['DOC_ID']}")
            if page["INDICATORS_FOUND"]:
                lines.append(f"  INDICATORS: {page['INDICATORS_FOUND']}")
            lines.append("")
            lines.append("  CONTENT:")
            # Full content, indented
            text = page["RAW_TEXT"] or ""
            for line in text.splitlines():
                lines.append(f"    {line}")
            lines.append("")

    report_text = "\n".join(lines)

    # Write to file
    output_path.write_text(report_text, encoding="utf-8")
    log.info(f"Report saved: {output_path} ({len(pages)} pages, {len(report_text)} bytes)")

    # Also print summary to terminal
    print()
    print("=" * 60)
    print("  NOCTURNE CLASSIFICATION SUMMARY")
    print("=" * 60)
    print(f"  Total pages: {total}")
    for cat in categories:
        print(f"  {cat['CATEGORY']:12s}: {cat['CNT']}")
    print()
    print(f"  Full report saved to: {output_path}")
    print("=" * 60)
    print()


def main():
    parser = argparse.ArgumentParser(description="Deploy Nocturne Snowflake pipeline")
    parser.add_argument("--account", default=os.environ.get("SNOWFLAKE_ACCOUNT"), help="Snowflake account identifier")
    parser.add_argument("--user", default=os.environ.get("SNOWFLAKE_USER"), help="Snowflake username")
    parser.add_argument("--password", default=os.environ.get("SNOWFLAKE_PASSWORD"), help="Snowflake password")
    parser.add_argument("--token", default=os.environ.get("SNOWFLAKE_TOKEN"), help="Snowflake PAT (programmatic access token) — no password needed")
    parser.add_argument("--warehouse", default=os.environ.get("SNOWFLAKE_WAREHOUSE", "COMPUTE_WH"), help="Warehouse name")
    parser.add_argument("--role", default=os.environ.get("SNOWFLAKE_ROLE", "ACCOUNTADMIN"), help="Role to use")
    parser.add_argument("--dry-run", action="store_true", help="Parse and display SQL without executing")
    parser.add_argument("--step", type=int, help="Run only a specific step (1-6)")
    parser.add_argument("--verify-only", action="store_true", help="Only run verification checks")
    parser.add_argument("--report", nargs="?", const="output/report.txt", help="Generate full classification report (default: output/report.txt)")
    args = parser.parse_args()

    if not args.dry_run and not args.verify_only:
        if not args.account:
            parser.error("--account is required (or set SNOWFLAKE_ACCOUNT)")
        if not args.token and not args.password:
            if not args.user:
                parser.error("--user is required when not using --token (or set SNOWFLAKE_USER)")
            import getpass
            args.password = getpass.getpass("Snowflake password: ")

    if args.dry_run:
        log.info("=== DRY RUN MODE (no Snowflake connection) ===")
        for filename in DEPLOY_ORDER:
            filepath = SQL_DIR / filename
            if not filepath.exists():
                log.error(f"Missing: {filepath}")
                sys.exit(1)
            execute_file(None, filepath, dry_run=True)
        log.info("Dry run complete. All SQL files parsed successfully.")
        return

    # Connect using PAT (token) or password
    if args.token:
        pat_user = args.user or os.environ.get("SNOWFLAKE_USER", "")
        log.info(f"Connecting to {args.account} via PAT (user={pat_user}, role={args.role}, warehouse={args.warehouse})")
        conn = snowflake.connector.connect(
            account=args.account,
            user=pat_user,
            token=args.token,
            authenticator="programmatic_access_token",
            warehouse=args.warehouse,
            role=args.role,
        )
    else:
        log.info(f"Connecting to {args.account} as {args.user} (role={args.role}, warehouse={args.warehouse})")
        conn = snowflake.connector.connect(
            account=args.account,
            user=args.user,
            password=args.password,
            warehouse=args.warehouse,
            role=args.role,
        )

    try:
        if args.report:
            report_path = Path(args.report)
            report_path.parent.mkdir(parents=True, exist_ok=True)
            generate_report(conn, report_path)
            return

        if args.verify_only:
            verify_pipeline(conn)
            return

        files_to_run = DEPLOY_ORDER
        if args.step:
            if args.step < 1 or args.step > len(DEPLOY_ORDER):
                parser.error(f"--step must be 1-{len(DEPLOY_ORDER)}")
            files_to_run = [DEPLOY_ORDER[args.step - 1]]

        log.info(f"Deploying {len(files_to_run)} file(s)...")
        for filename in files_to_run:
            filepath = SQL_DIR / filename
            if not filepath.exists():
                log.error(f"Missing: {filepath}")
                sys.exit(1)
            execute_file(conn, filepath)

        log.info("")
        verify_pipeline(conn)
        log.info("Pipeline deployment complete.")

    finally:
        conn.close()


if __name__ == "__main__":
    main()
