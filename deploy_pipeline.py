"""
Nocturne Pipeline Deployer

Deploys the Snowflake classification pipeline by executing SQL files in order.
Handles multi-statement SQL files, logs progress, and verifies each step.

Usage:
    # Existing storage integration/IAM: deploy and go live with steps 02-14
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
import json
import logging
import os
import re
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

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

log = logging.getLogger("nocturne_deploy")

PROJECT_ROOT = Path(__file__).parent
SQL_DIR = PROJECT_ROOT / "snowflake"
LOG_DIR = PROJECT_ROOT / "logs"

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
    11: "11_dt_l2_extraction_ai.sql",
    12: "12_dt_l2_graph_elements.sql",
    13: "13_dt_l3_knowledge_graph.sql",
    14: "14_dt_l4_severity.sql",
}

STEP_TITLES = {
    1: "GCS storage integration",
    2: "GCS stage and raw ingestion",
    3: "Monitored organization configuration",
    4: "Structured indicator detector",
    5: "L0 regex indicators",
    6: "Evidence-window input builder",
    7: "Deduplicated L1 input",
    8: "Target relationship classification",
    9: "Leak type and severity",
    10: "Seed, validate, and go live",
    11: "L2 claim and entity extraction",
    12: "L2 grounding and graph elements",
    13: "L3 knowledge graph",
    14: "L4 final severity and insights",
}

RELATIONSHIP_LABELS = (
    "target_data_leak",
    "target_mentioned_no_leak",
    "other_organization_leak",
    "no_leak",
)

# Replacing a configured storage integration can change its Snowflake-generated
# GCS identity and invalidate the bucket IAM grant. Existing environments only
# need steps 02-14, so step 01 requires an explicit CLI option.
DEFAULT_DEPLOY_STEPS = tuple(range(2, 15))


def configure_logging() -> Path:
    """Write each run's concise console output to a timestamped log file."""
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().astimezone().strftime("%Y%m%d_%H%M%S_%z")
    log_path = LOG_DIR / f"pipeline_{timestamp}.log"

    formatter = logging.Formatter(
        "%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    console_handler = logging.StreamHandler()
    console_handler.setFormatter(formatter)
    file_handler = logging.FileHandler(log_path, encoding="utf-8")
    file_handler.setFormatter(formatter)

    log.handlers.clear()
    log.setLevel(logging.INFO)
    log.propagate = False
    log.addHandler(console_handler)
    log.addHandler(file_handler)

    # The connector's connection-discovery messages overwhelm deployment output.
    for logger_name in ("snowflake.connector", "botocore", "boto3"):
        logging.getLogger(logger_name).setLevel(logging.WARNING)

    log.info("Log file: %s", log_path)
    return log_path


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


def _normalized_row(row: dict[str, Any]) -> dict[str, Any]:
    return {str(key).upper(): value for key, value in row.items()}


def _object_from_statement(statement: str, object_kind: str) -> str | None:
    match = re.search(
        rf"\b{object_kind}\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Z0-9_.$]+)",
        " ".join(statement.upper().split()),
    )
    return match.group(1) if match else None


def _statement_messages(
    statement: str,
    rows: list[dict[str, Any]],
) -> list[str]:
    """Convert raw Snowflake results into concise, human-readable effects."""
    normalized = " ".join(statement.upper().split())

    if normalized.startswith("USE "):
        return []

    create_match = re.match(
        r"CREATE\s+(OR\s+REPLACE\s+)?"
        r"(STORAGE INTEGRATION|FILE FORMAT|STAGE|SCHEMA|TABLE|TASK|FUNCTION|"
        r"DYNAMIC TABLE)\s+(IF\s+NOT\s+EXISTS\s+)?([A-Z0-9_.$]+)",
        normalized,
    )
    if create_match:
        replace = bool(create_match.group(1))
        if_not_exists = bool(create_match.group(3))
        object_kind = create_match.group(2).lower()
        object_name = create_match.group(4)
        if if_not_exists:
            action = "Ensured"
        elif replace:
            action = "Created/replaced"
        else:
            action = "Created"
        return [f"{action} {object_kind}: {object_name}"]

    if normalized.startswith("GRANT "):
        return ["Applied required role grant."]

    if normalized.startswith("MERGE INTO "):
        object_name = normalized.split()[2]
        affected = sum(
            int(row.get("NUMBER OF ROWS INSERTED", 0) or 0)
            + int(row.get("NUMBER OF ROWS UPDATED", 0) or 0)
            for row in rows
        )
        return [
            f"Ensured monitored-organization configuration in {object_name}"
            + (f" ({affected} row(s) changed)." if affected else " (no changes).")
        ]

    if normalized.startswith("ALTER TASK "):
        object_name = _object_from_statement(normalized, "TASK") or "task"
        if " SUSPEND" in normalized:
            return [f"Suspended task: {object_name}"]
        if " RESUME" in normalized:
            return [f"Resumed task: {object_name}"]
        return [f"Updated task: {object_name}"]

    if normalized.startswith("ALTER DYNAMIC TABLE "):
        object_name = (
            _object_from_statement(normalized, "DYNAMIC TABLE")
            or "dynamic table"
        )
        if " REFRESH" in normalized:
            return [f"Refreshed dynamic table and dependencies: {object_name}"]
        return [f"Updated dynamic table: {object_name}"]

    if normalized.startswith("ALTER TABLE "):
        object_name = _object_from_statement(normalized, "TABLE") or "table"
        return [f"Updated table: {object_name}"]

    if normalized.startswith("LIST @"):
        return [f"Stage contains {len(rows)} matching crawler part file(s)."]

    if normalized.startswith("COPY INTO "):
        if not rows:
            return ["COPY found no new staged files to load."]
        messages = []
        for row in rows:
            file_name = row.get("FILE") or row.get("FILE_NAME") or "staged file"
            status = row.get("STATUS", "unknown")
            rows_loaded = row.get("ROWS_LOADED", row.get("ROW_COUNT", 0))
            errors = row.get("ERRORS_SEEN", row.get("ERROR_COUNT", 0))
            messages.append(
                f"COPY {status}: {file_name} "
                f"(rows loaded={rows_loaded}, errors={errors})."
            )
        return messages

    if normalized.startswith("SHOW TASKS"):
        messages = []
        for row in rows:
            messages.append(
                "Task "
                f"{row.get('NAME', 'unknown')}: "
                f"state={row.get('STATE', 'unknown')}, "
                f"schedule={row.get('SCHEDULE', 'none')}."
            )
        return messages

    if "OBJECT_KEYS($1)" in normalized:
        if not rows:
            return ["No staged crawler record was available for schema validation."]
        source_file = rows[0].get("SOURCE_FILE", "staged record")
        return [f"Validated staged crawler schema: {source_file}"]

    if "FROM NOCTURNE.CONFIG.MONITORED_ORGANIZATIONS" in normalized:
        return [
            "Monitored organization: "
            f"{row.get('CANONICAL_NAME')} "
            f"(org_id={row.get('ORG_ID')}, enabled={row.get('ENABLED')})."
            for row in rows
        ]

    if "COUNT(*) AS RAW_PAGE_COUNT" in normalized and rows:
        row = rows[0]
        return [
            "Raw validation: "
            f"pages={row.get('RAW_PAGE_COUNT')}, "
            f"distinct_doc_ids={row.get('DISTINCT_DOC_ID_COUNT')}, "
            f"distinct_dedupe_keys={row.get('DISTINCT_DEDUPE_KEY_COUNT')}, "
            f"unexpected_schema_versions="
            f"{row.get('UNEXPECTED_SCHEMA_VERSION_COUNT')}, "
            f"manifest_rows={row.get('MANIFEST_ROW_COUNT')}."
        ]

    if (
        "RELATIONSHIP_AI_STATUS" in normalized
        and "COUNT(*) AS PAGE_COUNT" in normalized
    ):
        return ["Classification smoke query completed."]

    return []


def execute_file(
    conn: snowflake.connector.SnowflakeConnection,
    filepath: Path,
    dry_run: bool = False,
):
    """Execute one SQL file while logging object-level effects only."""
    step_number = next(
        (step for step, name in DEPLOY_STEPS.items() if name == filepath.name),
        None,
    )
    step_label = STEP_TITLES.get(step_number, filepath.stem)
    prefix = "[DRY RUN] " if dry_run else ""
    log.info("%sStep %s — %s", prefix, step_number or "?", step_label)
    statements = parse_sql_statements(filepath)

    for stmt in statements:
        if dry_run:
            continue

        try:
            cur = conn.cursor(snowflake.connector.DictCursor)
            cur.execute(stmt)
            rows = (
                [_normalized_row(row) for row in cur.fetchall()]
                if cur.description
                else []
            )
            cur.close()
            for message in _statement_messages(stmt, rows):
                log.info("  %s", message)
        except snowflake.connector.errors.ProgrammingError as e:
            log.error("  Failed: %s", e.msg)
            raise

    action = "Validated" if dry_run else "Completed"
    log.info("  %s %s (%d statements).", action, filepath.name, len(statements))


def _fetch_dicts(
    conn: snowflake.connector.SnowflakeConnection,
    query: str,
    params: tuple[Any, ...] | None = None,
) -> list[dict[str, Any]]:
    cur = conn.cursor(snowflake.connector.DictCursor)
    try:
        cur.execute(query, params)
        return [_normalized_row(row) for row in cur.fetchall()]
    finally:
        cur.close()


def _variant_array(value: Any) -> list[Any]:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, list) else []
        except json.JSONDecodeError:
            return []
    return []


def _display_bool(value: Any) -> str:
    if value is None:
        return "unknown"
    return str(bool(value)).lower()


def _log_relationship_groups(
    conn: snowflake.connector.SnowflakeConnection,
    affected_since: datetime | None,
) -> None:
    counts = _fetch_dicts(
        conn,
        """
        SELECT RELATIONSHIP_LABEL, COUNT(*) AS PAGE_COUNT
        FROM NOCTURNE.RAW.DT_PAGE_CLASSIFICATION
        GROUP BY RELATIONSHIP_LABEL
        """,
    )
    count_by_label = {
        row["RELATIONSHIP_LABEL"]: row["PAGE_COUNT"] for row in counts
    }
    log.info("Relationship labels:")
    for label in RELATIONSHIP_LABELS:
        log.info("  %-28s %s page(s)", label, count_by_label.get(label, 0))

    if affected_since is None:
        return

    affected = _fetch_dicts(
        conn,
        """
        SELECT RELATIONSHIP_LABEL, _SOURCE_FILE, TITLE
        FROM NOCTURNE.RAW.DT_PAGE_CLASSIFICATION
        WHERE _INGESTED_AT >= %s
        ORDER BY RELATIONSHIP_LABEL, _SOURCE_FILE, TITLE
        """,
        (affected_since,),
    )
    if not affected:
        log.info("No newly ingested files were classified during this run.")
        return

    log.info("Newly classified files:")
    for label in RELATIONSHIP_LABELS:
        label_rows = [
            row for row in affected if row["RELATIONSHIP_LABEL"] == label
        ]
        if not label_rows:
            continue
        log.info("  %s:", label)
        for row in label_rows:
            log.info(
                "    %s — %s",
                Path(row["_SOURCE_FILE"]).name,
                row["TITLE"],
            )


def _log_document_details(
    conn: snowflake.connector.SnowflakeConnection,
    affected_since: datetime | None,
    include_all: bool = False,
    log_ai_inputs: bool = False,
    target_leaks_only: bool = False,
) -> None:
    filters = []
    params: tuple[Any, ...] | None = None
    if not include_all:
        if affected_since is None:
            return
        filters.append("PAGE._INGESTED_AT >= %s")
        params = (affected_since,)
    if target_leaks_only:
        filters.append("RESULT.RELATIONSHIP_LABEL = 'target_data_leak'")

    where_clause = f"WHERE {' AND '.join(filters)}" if filters else ""
    classification_input_column = (
        "INPUT.CLASSIFICATION_INPUT"
        if log_ai_inputs
        else "NULL::STRING"
    )

    pages = _fetch_dicts(
        conn,
        f"""
        SELECT
          PAGE.DOC_ID,
          PAGE._SOURCE_FILE,
          PAGE.TITLE,
          PAGE.INDICATORS_FOUND:summary_text::STRING AS INDICATOR_SUMMARY,
          PAGE.INDICATORS_FOUND:strong_count::NUMBER
            AS STRONG_INDICATOR_COUNT,
          PAGE.INDICATORS_FOUND:medium_count::NUMBER
            AS MEDIUM_INDICATOR_COUNT,
          PAGE.INDICATORS_FOUND:weak_count::NUMBER
            AS WEAK_INDICATOR_COUNT,
          PAGE.INDICATORS_FOUND:evidence_score::NUMBER AS EVIDENCE_SCORE,
          INPUT.SOURCE_TEXT_LENGTH,
          INPUT.CLASSIFICATION_INPUT_LENGTH,
          INPUT.INPUT_TRUNCATED,
          INPUT.INPUT_METHOD_VERSION,
          INPUT.FALLBACK_USED,
          INPUT.FALLBACK_REASON,
          INPUT.SELECTED_WINDOWS,
          {classification_input_column} AS CLASSIFICATION_INPUT,
          RESULT.TARGET_ANCHOR_TYPE,
          RESULT.TARGET_MATCH_SCORE,
          RESULT.RELATIONSHIP_AI_STATUS,
          RESULT.RELATIONSHIP_LABEL,
          RESULT.IS_RELEVANT,
          RESULT.LEAK_TYPE_AI_STATUS,
          RESULT.LEAK_TYPE_LABELS,
          RESULT.IMPACT_SCORE,
          RESULT.TARGET_RELEVANCE_SCORE,
          RESULT.PRELIMINARY_SEVERITY_SCORE,
          RESULT.PRELIMINARY_SEVERITY_BAND,
          RESULT.SEVERITY_INPUT_COMPLETE
        FROM NOCTURNE.RAW.DT_REGEX_INDICATORS AS PAGE
        LEFT JOIN NOCTURNE.RAW.DT_L1_CLASSIFICATION_INPUT AS INPUT
          ON PAGE.DOC_ID = INPUT.DOC_ID
          AND PAGE.DEDUPE_KEY = INPUT.DEDUPE_KEY
        LEFT JOIN NOCTURNE.RAW.DT_PAGE_CLASSIFICATION AS RESULT
          ON INPUT.DOC_ID = RESULT.DOC_ID
          AND INPUT.DEDUPE_KEY = RESULT.DEDUPE_KEY
          AND INPUT.ORG_ID = RESULT.ORG_ID
        {where_clause}
        ORDER BY
          RESULT.PRELIMINARY_SEVERITY_SCORE DESC NULLS LAST,
          PAGE._SOURCE_FILE,
          PAGE.TITLE
        """,
        params,
    )
    if not pages:
        return

    for page in pages:
        indicator_lines = (
            str(page["INDICATOR_SUMMARY"]).splitlines()
            if page["INDICATOR_SUMMARY"]
            else ["none"]
        )
        leak_types = _variant_array(page["LEAK_TYPE_LABELS"])
        windows = _variant_array(page["SELECTED_WINDOWS"])

        lines = [
            "",
            "=" * 72,
            f"File: {page['_SOURCE_FILE']}",
            f"Title: {page['TITLE']}",
            f"Document ID: {page['DOC_ID']}",
            "",
            "L0 indicators:",
        ]
        lines.extend(f"  {item}" for item in indicator_lines)
        lines.extend(
            [
                f"  Strong indicators: {page['STRONG_INDICATOR_COUNT']}",
                f"  Medium indicators: {page['MEDIUM_INDICATOR_COUNT']}",
                f"  Weak indicators: {page['WEAK_INDICATOR_COUNT']}",
                f"  Evidence score: {page['EVIDENCE_SCORE']}",
                "",
                "L1 input selection:",
                f"  Method: {page['INPUT_METHOD_VERSION'] or 'not available'}",
                "  Input length: "
                f"{page['CLASSIFICATION_INPUT_LENGTH']} of "
                f"{page['SOURCE_TEXT_LENGTH']} source characters",
                f"  Truncated: {_display_bool(page['INPUT_TRUNCATED'])}",
                f"  Fallback used: {_display_bool(page['FALLBACK_USED'])}",
            ]
        )
        if page["FALLBACK_REASON"]:
            lines.append(f"  Fallback reason: {page['FALLBACK_REASON']}")
        if windows:
            lines.append("  Selected evidence windows:")
            for index, window in enumerate(windows, 1):
                if not isinstance(window, dict):
                    continue
                reasons = ", ".join(window.get("reasons", [])) or "unspecified"
                lines.append(
                    f"    {index}. characters {window.get('start')}–"
                    f"{window.get('end')}; score={window.get('score')}; "
                    f"reasons={reasons}; "
                    f"included={window.get('included_characters')}"
                )
        elif page["FALLBACK_USED"]:
            lines.append(
                "  Selected evidence: beginning plus non-overlapping end."
            )
        else:
            lines.append(
                "  Selected evidence: whole short document, or introduction/end "
                "without an additional middle window."
            )
        if (
            log_ai_inputs
            and page["RELATIONSHIP_LABEL"] == "target_data_leak"
            and page["CLASSIFICATION_INPUT"]
        ):
            lines.extend(
                [
                    "",
                    "Exact masked input sent to relationship AI_CLASSIFY:",
                    "-" * 72,
                    str(page["CLASSIFICATION_INPUT"]),
                    "-" * 72,
                    "  Note: indicator spans are masked by the input builder; "
                    "unmatched sensitive text may still appear.",
                ]
            )

        lines.extend(
            [
                "",
                "Target match:",
                f"  Anchor: {page['TARGET_ANCHOR_TYPE'] or 'none'}",
                "  Match score: "
                f"{page['TARGET_MATCH_SCORE'] if page['TARGET_MATCH_SCORE'] is not None else 'not available'}",
                "",
                "Relationship classification:",
                f"  Status: {page['RELATIONSHIP_AI_STATUS'] or 'not available'}",
                f"  Label: {page['RELATIONSHIP_LABEL'] or 'not available'}",
                f"  Relevant: {_display_bool(page['IS_RELEVANT'])}",
                "",
                "Leak-type classification:",
                f"  Status: {page['LEAK_TYPE_AI_STATUS'] or 'not available'}",
                "  Labels: "
                + (", ".join(str(label) for label in leak_types) or "none"),
                "",
                "Severity:",
                f"  Impact score: {page['IMPACT_SCORE']}",
                f"  Target relevance: {page['TARGET_RELEVANCE_SCORE']}",
            ]
        )
        if (
            page["IMPACT_SCORE"] is not None
            and page["TARGET_RELEVANCE_SCORE"] is not None
            and page["PRELIMINARY_SEVERITY_SCORE"] is not None
        ):
            lines.append(
                "  Final preliminary score: "
                f"{page['IMPACT_SCORE']} × "
                f"{page['TARGET_RELEVANCE_SCORE']} / 100 = "
                f"{page['PRELIMINARY_SEVERITY_SCORE']}"
            )
        else:
            lines.append("  Final preliminary score: not available")
        lines.extend(
            [
                f"  Band: {page['PRELIMINARY_SEVERITY_BAND']}",
                "  Severity input complete: "
                f"{_display_bool(page['SEVERITY_INPUT_COMPLETE'])}",
                "=" * 72,
            ]
        )
        log.info("\n%s", "\n".join(lines))


def verify_pipeline(
    conn: snowflake.connector.SnowflakeConnection,
    affected_since: datetime | None = None,
    include_all_details: bool = False,
    log_ai_inputs: bool = False,
    target_leaks_only: bool = False,
):
    """Log concise health checks and safe, human-readable affected-page details."""
    log.info("Pipeline verification")

    try:
        organizations = _fetch_dicts(
            conn,
            """
            SELECT ORG_ID, CANONICAL_NAME, ENABLED
            FROM NOCTURNE.CONFIG.MONITORED_ORGANIZATIONS
            ORDER BY ORG_ID
            """,
        )
        for organization in organizations:
            log.info(
                "  Monitored organization: %s "
                "(org_id=%s, enabled=%s)",
                organization["CANONICAL_NAME"],
                organization["ORG_ID"],
                _display_bool(organization["ENABLED"]),
            )
    except Exception as error:
        log.warning("  Monitored organizations unavailable: %s", error)

    try:
        tasks = _fetch_dicts(
            conn,
            "SHOW TASKS LIKE 'CRAWL_INGEST_TASK' IN SCHEMA NOCTURNE.RAW",
        )
        for task in tasks:
            log.info(
                "  Ingestion task: state=%s, schedule=%s",
                task.get("STATE", "unknown"),
                task.get("SCHEDULE", "unknown"),
            )
    except Exception as error:
        log.warning("  Ingestion task unavailable: %s", error)

    try:
        dynamic_tables = _fetch_dicts(
            conn,
            "SHOW DYNAMIC TABLES IN SCHEMA NOCTURNE.RAW",
        )
        active_count = sum(
            1
            for table in dynamic_tables
            if str(table.get("SCHEDULING_STATE", "")).upper() == "ACTIVE"
        )
        log.info(
            "  Dynamic tables: %d total, %d active",
            len(dynamic_tables),
            active_count,
        )
    except Exception as error:
        log.warning("  Dynamic-table status unavailable: %s", error)

    try:
        raw_count = _fetch_dicts(
            conn,
            "SELECT COUNT(*) AS CNT FROM NOCTURNE.RAW.CRAWL_PAGES",
        )[0]["CNT"]
        log.info("Raw pages count: %s", raw_count)
    except Exception as error:
        log.warning("Raw pages count unavailable: %s", error)

    try:
        l0_count = _fetch_dicts(
            conn,
            "SELECT COUNT(*) AS CNT FROM NOCTURNE.RAW.DT_REGEX_INDICATORS",
        )[0]["CNT"]
        log.info("L0 pages count: %s", l0_count)
    except Exception as error:
        log.warning("L0 pages count unavailable: %s", error)

    try:
        summary_rows = _fetch_dicts(
            conn,
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
        )
        classification_results = [
            (
                row["RELATIONSHIP_AI_STATUS"],
                row["RELATIONSHIP_LABEL"],
                row["LEAK_TYPE_AI_STATUS"],
                row["PRELIMINARY_SEVERITY_BAND"],
                row["PAGE_COUNT"],
            )
            for row in summary_rows
        ]
        log.info("Classification results: %s", classification_results)
        _log_relationship_groups(conn, affected_since)
        _log_document_details(
            conn,
            affected_since,
            include_all=include_all_details,
            log_ai_inputs=log_ai_inputs,
            target_leaks_only=target_leaks_only,
        )
    except Exception as error:
        log.warning("Classification results unavailable: %s", error)


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
    log_path = configure_logging()
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
        "--log-ai-inputs",
        action="store_true",
        help=(
            "Log the exact masked CLASSIFICATION_INPUT for target-data-leak "
            "documents; may still contain sensitive unmatched text"
        ),
    )
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
        log.info("Dry run: validating SQL files without a Snowflake connection.")
        for filename in files_to_run:
            filepath = SQL_DIR / filename
            if not filepath.exists():
                log.error(f"Missing: {filepath}")
                sys.exit(1)
            execute_file(None, filepath, dry_run=True)
        log.info("Dry run complete. Log saved to %s", log_path)
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
        deployment_started_at = _fetch_dicts(
            conn,
            "SELECT CURRENT_TIMESTAMP() AS STARTED_AT",
        )[0]["STARTED_AT"]

        if args.report:
            report_path = Path(args.report)
            report_path.parent.mkdir(parents=True, exist_ok=True)
            generate_report(conn, report_path)
            return

        if args.verify_only:
            verify_pipeline(
                conn,
                include_all_details=args.log_ai_inputs,
                log_ai_inputs=args.log_ai_inputs,
                target_leaks_only=args.log_ai_inputs,
            )
            log.info("Verification complete. Log saved to %s", log_path)
            return

        log.info("Deploying %d pipeline step file(s).", len(files_to_run))
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

        verify_pipeline(
            conn,
            affected_since=deployment_started_at,
            include_all_details=(
                args.step is not None and args.step in range(5, 10)
            ),
            log_ai_inputs=args.log_ai_inputs,
        )
        log.info("Pipeline deployment complete.")
        log.info("Log saved to %s", log_path)

    finally:
        conn.close()


if __name__ == "__main__":
    main()
