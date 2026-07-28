"""
Nocturne Pipeline Deployer

Deploys the Snowflake classification pipeline by executing SQL files in order.
Handles multi-statement SQL files, logs progress, and verifies each step.

Usage:
    # Existing storage integration/IAM: deploy and go live with steps 02-10
    python deploy_pipeline.py

    # Fresh environment: also create step 01's storage integration
    python deploy_pipeline.py --include-storage-integration

    # Run one numbered SQL step
    python deploy_pipeline.py --step 7

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

DEPLOY_STEPS = {
    1: "01_storage_integration.sql",
    2: "02_ingestion_layer.sql",
    3: "03_target_configuration.sql",
    4: "04_detect_indicators_udf.sql",
    5: "05_dt_regex_indicators.sql",
    6: "06_build_classification_input_udf.sql",
    7: "07_dt_l1_classification_input.sql",
    8: "08_dt_relationship_classification.sql",
    9: "09_dt_leak_type_severity.sql",
    10: "10_seed_validate_golive.sql",
}

# Replacing a configured storage integration can change its Snowflake-generated
# GCS identity and invalidate the bucket IAM grant. Existing environments only
# need steps 02-10, so step 01 requires an explicit CLI option.
DEFAULT_DEPLOY_STEPS = tuple(range(2, 11))


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
        (
            "Monitored organizations",
            """
            SELECT ORG_ID, CANONICAL_NAME, ENABLED
            FROM NOCTURNE.CONFIG.MONITORED_ORGANIZATIONS
            ORDER BY ORG_ID
            """,
        ),
        ("Tasks", "SHOW TASKS IN SCHEMA NOCTURNE.RAW"),
        ("Dynamic Tables", "SHOW DYNAMIC TABLES IN SCHEMA NOCTURNE.RAW"),
        ("Raw pages count", "SELECT COUNT(*) AS cnt FROM NOCTURNE.RAW.CRAWL_PAGES"),
        (
            "L0 pages count",
            "SELECT COUNT(*) AS cnt FROM NOCTURNE.RAW.DT_REGEX_INDICATORS",
        ),
        (
            "Classification results",
            """
            SELECT
              RELATIONSHIP_AI_STATUS,
              RELATIONSHIP_LABEL,
              LEAK_TYPE_AI_STATUS,
              PRELIMINARY_SEVERITY_BAND,
              COUNT(*) AS PAGE_COUNT
            FROM NOCTURNE.RAW.DT_PAGE_CLASSIFICATION
            GROUP BY
              RELATIONSHIP_AI_STATUS,
              RELATIONSHIP_LABEL,
              LEAK_TYPE_AI_STATUS,
              PRELIMINARY_SEVERITY_BAND
            ORDER BY PAGE_COUNT DESC
            """,
        ),
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
    """Generate a metadata-only classification report and save it to a file."""
    from datetime import datetime

    log.info(f"Generating report -> {output_path}")
    cur = conn.cursor(snowflake.connector.DictCursor)

    cur.execute("SELECT COUNT(*) AS total FROM NOCTURNE.RAW.CRAWL_PAGES")
    total = cur.fetchone()["TOTAL"]

    cur.execute("""
        SELECT
          RELATIONSHIP_AI_STATUS,
          RELATIONSHIP_LABEL,
          PRELIMINARY_SEVERITY_BAND,
          COUNT(*) AS CNT
        FROM NOCTURNE.RAW.DT_PAGE_CLASSIFICATION
        GROUP BY
          RELATIONSHIP_AI_STATUS,
          RELATIONSHIP_LABEL,
          PRELIMINARY_SEVERITY_BAND
        ORDER BY CNT DESC
    """)
    summary_rows = cur.fetchall()

    # Do not write RAW_TEXT or exact indicator matches into a local report.
    cur.execute("""
        SELECT
          DOC_ID,
          TITLE,
          URL,
          RELATIONSHIP_AI_STATUS,
          RELATIONSHIP_LABEL,
          IS_RELEVANT,
          INDICATOR_SUMMARY,
          EVIDENCE_SCORE,
          TARGET_MATCH_SCORE,
          TARGET_RELEVANCE_SCORE,
          LEAK_TYPE_LABELS,
          LEAK_TYPE_AI_STATUS,
          IMPACT_SCORE,
          PRELIMINARY_SEVERITY_SCORE,
          PRELIMINARY_SEVERITY_BAND
        FROM NOCTURNE.RAW.DT_PAGE_CLASSIFICATION
        ORDER BY PRELIMINARY_SEVERITY_SCORE DESC NULLS LAST, TITLE
    """)
    pages = cur.fetchall()
    cur.close()

    lines = []
    lines.append("=" * 80)
    lines.append("NOCTURNE CLASSIFICATION REPORT")
    lines.append(f"Generated: {datetime.now().astimezone().isoformat(timespec='seconds')}")
    lines.append("=" * 80)
    lines.append("")
    lines.append("SUMMARY")
    lines.append("-" * 40)
    lines.append(f"  Total pages ingested: {total}")
    for row in summary_rows:
        lines.append(
            "  "
            f"relationship_status={row['RELATIONSHIP_AI_STATUS']}, "
            f"relationship={row['RELATIONSHIP_LABEL']}, "
            f"severity={row['PRELIMINARY_SEVERITY_BAND']}: "
            f"{row['CNT']}"
        )

    lines.append("")
    lines.append("PAGE METADATA")
    lines.append("-" * 40)
    for i, page in enumerate(pages, 1):
        lines.append("")
        lines.append(f"--- [{i}] {page['TITLE']} ---")
        lines.append(f"  URL: {page['URL']}")
        lines.append(f"  DOC_ID: {page['DOC_ID']}")
        lines.append(
            "  RELATIONSHIP: "
            f"{page['RELATIONSHIP_LABEL']} "
            f"(status={page['RELATIONSHIP_AI_STATUS']}, "
            f"relevant={page['IS_RELEVANT']})"
        )
        lines.append(f"  INDICATOR SUMMARY: {page['INDICATOR_SUMMARY'] or 'none'}")
        lines.append(
            "  SCORES: "
            f"evidence={page['EVIDENCE_SCORE']}, "
            f"target_match={page['TARGET_MATCH_SCORE']}, "
            f"target_relevance={page['TARGET_RELEVANCE_SCORE']}, "
            f"impact={page['IMPACT_SCORE']}, "
            f"severity={page['PRELIMINARY_SEVERITY_SCORE']} "
            f"({page['PRELIMINARY_SEVERITY_BAND']})"
        )
        lines.append(
            "  LEAK TYPES: "
            f"{page['LEAK_TYPE_LABELS'] or 'not applicable'} "
            f"(status={page['LEAK_TYPE_AI_STATUS']})"
        )

    report_text = "\n".join(lines)

    output_path.write_text(report_text, encoding="utf-8")
    log.info(f"Report saved: {output_path} ({len(pages)} pages, {len(report_text)} bytes)")

    print()
    print("=" * 60)
    print("  NOCTURNE CLASSIFICATION SUMMARY")
    print("=" * 60)
    print(f"  Total pages: {total}")
    for row in summary_rows:
        print(
            "  "
            f"{row['RELATIONSHIP_AI_STATUS']} / "
            f"{row['RELATIONSHIP_LABEL']} / "
            f"{row['PRELIMINARY_SEVERITY_BAND']}: "
            f"{row['CNT']}"
        )
    print()
    print(f"  Metadata-only report saved to: {output_path}")
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
    deployment_scope = parser.add_mutually_exclusive_group()
    deployment_scope.add_argument(
        "--step",
        type=int,
        choices=DEPLOY_STEPS,
        help="Run only the SQL file with this step number (1-10)",
    )
    deployment_scope.add_argument(
        "--include-storage-integration",
        action="store_true",
        help="Also run step 01; omit for an existing Snowflake/GCS integration",
    )
    parser.add_argument("--verify-only", action="store_true", help="Only run verification checks")
    parser.add_argument(
        "--report",
        nargs="?",
        const="output/report.txt",
        help="Generate a metadata-only classification report (default: output/report.txt)",
    )
    args = parser.parse_args()

    if args.step:
        selected_steps = (args.step,)
    elif args.include_storage_integration:
        selected_steps = tuple(DEPLOY_STEPS)
    else:
        selected_steps = DEFAULT_DEPLOY_STEPS
    files_to_run = [DEPLOY_STEPS[step] for step in selected_steps]

    if not args.dry_run:
        if not args.account:
            parser.error("--account is required (or set SNOWFLAKE_ACCOUNT)")
        if not args.token and not args.password:
            if not args.user:
                parser.error("--user is required when not using --token (or set SNOWFLAKE_USER)")
            import getpass
            args.password = getpass.getpass("Snowflake password: ")

    if args.dry_run:
        log.info("=== DRY RUN MODE (no Snowflake connection) ===")
        for filename in files_to_run:
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

        log.info(f"Deploying {len(files_to_run)} file(s)...")
        if 1 not in selected_steps:
            log.info(
                "Preserving existing NOCTURNE_GCS_INT; "
                "step 01 is excluded from this deployment."
            )
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
