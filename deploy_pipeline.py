"""
Nocturne Pipeline Deployer

Deploys the Snowflake classification pipeline by executing SQL files in order.
Handles multi-statement SQL files, logs progress, and verifies each step.

Usage:
    # Existing storage integration/IAM: deploy and go live with steps 02-16
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
    9: "09_dt_l2_extraction_ai.sql",
    10: "10_dt_l2_grounding_routing.sql",
    11: "11_dt_leak_type_severity.sql",
    12: "12_dt_l3_knowledge_graph.sql",
    13: "13_dt_l4_severity.sql",
    14: "14_ai_incident_insights.sql",
    15: "15_seed_validate_golive.sql",
    16: "16_dashboard_interface.sql",
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
    9: "Cached evidence-only L2 extraction",
    10: "L2 grounding, target resolution, and routing",
    11: "Cached target-confirmed leak types",
    12: "Target-scoped L3 knowledge graph",
    13: "L4 impact, confidence, and triage priority",
    14: "Cached per-incident AI insights",
    15: "Seed, validate, and go live",
    16: "Organization-scoped dashboard interface",
}

RELATIONSHIP_LABELS = (
    "target_data_leak",
    "target_mentioned_no_leak",
    "other_organization_leak",
    "no_leak",
)

# Replacing a configured storage integration can change its Snowflake-generated
# GCS identity and invalidate the bucket IAM grant. Existing environments only
# need steps 02-16, so step 01 requires an explicit CLI option.
DEFAULT_DEPLOY_STEPS = tuple(range(2, 17))

AI_STAGES = {
    "relationship": {
        "results": "NOCTURNE.RAW.RELATIONSHIP_AI_RESULTS",
        "candidates": "NOCTURNE.RAW.DT_RELATIONSHIP_AI_CANDIDATES",
        "task": "RELATIONSHIP_AI_TASK",
        "query_tag": "NOCTURNE_RELATIONSHIP_AI",
    },
    "l2_extraction": {
        "results": "NOCTURNE.RAW.L2_EXTRACTION_AI_RESULTS",
        "candidates": "NOCTURNE.RAW.DT_L2_EXTRACTION_CANDIDATES",
        "task": "L2_EXTRACTION_AI_TASK",
        "query_tag": "NOCTURNE_L2_EXTRACTION_AI",
    },
    "leak_type": {
        "results": "NOCTURNE.RAW.LEAK_TYPE_AI_RESULTS",
        "candidates": "NOCTURNE.RAW.DT_LEAK_TYPE_AI_CANDIDATES",
        "task": "LEAK_TYPE_AI_TASK",
        "query_tag": "NOCTURNE_LEAK_TYPE_AI",
    },
    "incident_insight": {
        "results": "NOCTURNE.RAW.INCIDENT_INSIGHT_AI_RESULTS",
        "candidates": "NOCTURNE.RAW.INCIDENT_INSIGHT_AI_CANDIDATES",
        "missing_candidates": (
            "NOCTURNE.RAW."
            "VW_INCIDENT_INSIGHT_AI_MISSING_CANDIDATES"
        ),
        "task": "INCIDENT_INSIGHT_AI_TASK",
        "query_tag": "NOCTURNE_L4_INCIDENT_INSIGHT_AI",
    },
}

INGEST_TASK_NAME = "CRAWL_INGEST_TASK"
INCIDENT_DISCOVERY_TASK_NAME = "INCIDENT_INSIGHT_CANDIDATE_DISCOVERY_TASK"
L2_MODEL_NAME = "claude-sonnet-4-5"
EXPECTED_CROSS_REGION_POLICY = "AWS_APJ"


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
        r"(STORAGE INTEGRATION|DATABASE|FILE FORMAT|STAGE|SCHEMA|TABLE|TASK|FUNCTION|"
        r"DYNAMIC TABLE|STREAM|VIEW)\s+"
        r"(IF\s+NOT\s+EXISTS\s+)?([A-Z0-9_.$]+)",
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

    drop_match = re.match(
        r"DROP\s+(DYNAMIC TABLE|TABLE|VIEW|STREAM|TASK|FUNCTION)\s+"
        r"(?:IF\s+EXISTS\s+)?([A-Z0-9_.$]+)",
        normalized,
    )
    if drop_match:
        return [
            f"Removed obsolete {drop_match.group(1).lower()}: "
            f"{drop_match.group(2)}"
        ]

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
            schedule = row.get("SCHEDULE")
            condition = row.get("CONDITION")
            trigger = schedule or condition or "manual"
            messages.append(
                "Task "
                f"{row.get('NAME', 'unknown')}: "
                f"state={row.get('STATE', 'unknown')}, "
                f"trigger={trigger}."
            )
        return messages

    if normalized.startswith("SHOW DYNAMIC TABLES"):
        incremental = sum(
            1
            for row in rows
            if str(row.get("REFRESH_MODE", "")).upper() == "INCREMENTAL"
        )
        return [
            f"Dynamic tables: {len(rows)} total, "
            f"{incremental} incremental."
        ]

    if normalized.startswith("SHOW STREAMS"):
        stale = sum(
            1
            for row in rows
            if str(row.get("STALE", "")).lower() == "true"
        )
        return [f"Streams: {len(rows)} total, {stale} stale."]

    if normalized.startswith("EXECUTE IMMEDIATE"):
        if "GO-LIVE BLOCKED" in normalized:
            result = next(iter(rows[0].values()), "passed") if rows else "passed"
            return [f"Organization-isolation validation: {result}"]
        return ["Executed Snowflake validation block."]

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
        return [
            "Raw validation: "
            f"org_id={row.get('ORG_ID')}, "
            f"path_org_id={row.get('_PATH_ORG_ID')}, "
            f"schema={row.get('SCHEMA_VERSION')}, "
            f"pages={row.get('RAW_PAGE_COUNT')}, "
            f"distinct_doc_ids={row.get('DISTINCT_DOC_ID_COUNT')}, "
            f"distinct_dedupe_keys={row.get('DISTINCT_DEDUPE_KEY_COUNT')}, "
            f"manifest_rows={row.get('MANIFEST_ROW_COUNT')}."
            for row in rows
        ]

    if "CACHED_RESULT_COUNT" in normalized:
        return [
            "AI cache: "
            f"stage={row.get('AI_STAGE')}, org_id={row.get('ORG_ID')}, "
            f"status={row.get('STATUS')}, rows={row.get('CACHED_RESULT_COUNT')}."
            for row in rows
        ] or ["AI caches are empty before go-live."]

    if "MISSING_CANDIDATE_COUNT" in normalized:
        return [
            "AI candidates: "
            f"stage={row.get('AI_STAGE')}, org_id={row.get('ORG_ID')}, "
            f"missing={row.get('MISSING_CANDIDATE_COUNT')}."
            for row in rows
        ] or ["No missing AI candidates before go-live."]

    if (
        "FROM NOCTURNE.INFORMATION_SCHEMA.VIEWS" in normalized
        and "TABLE_SCHEMA = 'DASHBOARD'" in normalized
    ):
        view_names = ", ".join(
            str(row.get("TABLE_NAME"))
            for row in rows
            if row.get("TABLE_NAME")
        )
        return [
            f"Dashboard interface views available: {view_names}."
            if view_names
            else "Dashboard interface has no views."
        ]

    if "FROM NOCTURNE.DASHBOARD.VW_COMMAND_CENTER" in normalized:
        return [
            "Dashboard organization: "
            f"{row.get('ORGANIZATION_NAME')} "
            f"(org_id={row.get('ORG_ID')}, "
            f"collected={row.get('PAGES_COLLECTED')}, "
            f"L1={row.get('PAGES_RELEVANCE_CHECKED')}, "
            f"L2={row.get('PAGES_EVIDENCE_EXTRACTED')}, "
            f"confirmed={row.get('PAGES_OWNERSHIP_VERIFIED')}, "
            f"incidents={row.get('INCIDENTS_RAISED')})."
            for row in rows
        ] or ["Dashboard interface contains no enabled organizations."]

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
    if isinstance(value, tuple):
        return list(value)
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
    if isinstance(value, str):
        if value.lower() in {"true", "yes", "1"}:
            return "true"
        if value.lower() in {"false", "no", "0"}:
            return "false"
    return str(bool(value)).lower()


def _truncated(value: Any, limit: int = 240) -> str:
    if value is None:
        return ""
    text = " ".join(str(value).split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _check_ai_readiness(
    conn: snowflake.connector.SnowflakeConnection,
    strict: bool = False,
) -> bool:
    """Check model and residency policy without invoking a Cortex function."""
    region = _fetch_dicts(
        conn,
        "SELECT CURRENT_REGION() AS REGION",
    )[0]["REGION"]
    parameter_rows = _fetch_dicts(
        conn,
        "SHOW PARAMETERS LIKE 'CORTEX_ENABLED_CROSS_REGION' IN ACCOUNT",
    )
    policy = str(
        parameter_rows[0].get("VALUE", "DISABLED")
        if parameter_rows
        else "DISABLED"
    ).upper()
    model_rows = _fetch_dicts(
        conn,
        f"SHOW CORTEX BASE MODELS LIKE '{L2_MODEL_NAME}' "
        "IN SNOWFLAKE.MODELS",
    )

    availability = ""
    lifecycle = "not_visible"
    if model_rows:
        availability = str(model_rows[0].get("AVAILABLE_REGIONS", "")).upper()
        lifecycle = str(
            model_rows[0].get("LIFECYCLE_STATUS", "unknown")
        ).lower()

    region_upper = str(region).upper()
    local_available = region_upper in availability
    policy_prefixes = {
        "AWS_APJ": ("AWS_AP_", "AWS_ASIA_", "AWS_APJ"),
        "AWS_US": ("AWS_US_", "AWS_CA_", "AWS_US"),
        "AWS_EU": ("AWS_EU_", "AWS_EU"),
        "AWS_AU": ("AWS_AP_SOUTHEAST_2", "AWS_AU"),
        "AZURE_US": ("AZURE_US",),
        "AZURE_EU": ("AZURE_EU",),
        "GCP_US": ("GCP_US",),
    }
    cross_region_available = (
        policy == "ANY_REGION" and bool(model_rows)
    ) or any(
        prefix in availability for prefix in policy_prefixes.get(policy, ())
    )
    ready = (
        bool(model_rows)
        and lifecycle.upper() != "EOL"
        and (local_available or cross_region_available)
    )

    log.info(
        "AI residency: account_region=%s, cross_region_policy=%s, "
        "expected_policy=%s",
        region,
        policy,
        EXPECTED_CROSS_REGION_POLICY,
    )
    log.info(
        "AI model readiness: model=%s, lifecycle=%s, ready=%s",
        L2_MODEL_NAME,
        lifecycle,
        _display_bool(ready),
    )
    if policy != EXPECTED_CROSS_REGION_POLICY:
        log.warning(
            "  Cross-region policy is %s; the documented hackathon policy is %s. "
            "The deployer will not change this account setting.",
            policy,
            EXPECTED_CROSS_REGION_POLICY,
        )
    if not ready:
        message = (
            f"Model {L2_MODEL_NAME} is not available to the current role in "
            f"account region {region} under cross-region policy {policy}. "
            "No synthetic Cortex preflight was executed."
        )
        if strict:
            raise RuntimeError(message)
        log.warning("  %s", message)
    return ready


def _log_task_health(
    conn: snowflake.connector.SnowflakeConnection,
) -> None:
    task_names = {INGEST_TASK_NAME} | {
        str(config["task"]) for config in AI_STAGES.values()
    }
    task_names.add(INCIDENT_DISCOVERY_TASK_NAME)
    tasks = _fetch_dicts(
        conn,
        "SHOW TASKS IN SCHEMA NOCTURNE.RAW",
    )
    log.info("Task state:")
    for task in sorted(
        (row for row in tasks if row.get("NAME") in task_names),
        key=lambda row: str(row.get("NAME")),
    ):
        trigger = task.get("SCHEDULE") or task.get("CONDITION") or "manual"
        log.info(
            "  %s: state=%s, trigger=%s",
            task.get("NAME"),
            task.get("STATE", "unknown"),
            trigger,
        )

    failures = _fetch_dicts(
        conn,
        """
        SELECT NAME, STATE, SCHEDULED_TIME, QUERY_ID, ERROR_MESSAGE
        FROM TABLE(SNOWFLAKE.INFORMATION_SCHEMA.TASK_HISTORY(
          SCHEDULED_TIME_RANGE_START => DATEADD('hour', -24, CURRENT_TIMESTAMP()),
          SCHEDULED_TIME_RANGE_END => CURRENT_TIMESTAMP(),
          RESULT_LIMIT => 500,
          ERROR_ONLY => TRUE
        ))
        WHERE DATABASE_NAME = 'NOCTURNE'
          AND SCHEMA_NAME = 'RAW'
          AND NAME IN (
            'CRAWL_INGEST_TASK',
            'RELATIONSHIP_AI_TASK',
            'L2_EXTRACTION_AI_TASK',
            'LEAK_TYPE_AI_TASK',
            'INCIDENT_INSIGHT_AI_TASK',
            'INCIDENT_INSIGHT_CANDIDATE_DISCOVERY_TASK'
          )
        ORDER BY SCHEDULED_TIME DESC
        LIMIT 10
        """,
    )
    if not failures:
        log.info("  Recent task failures: none in the last 24 hours.")
    for failure in failures:
        log.warning(
            "  Task failure: %s at %s — %s (query_id=%s)",
            failure.get("NAME"),
            failure.get("SCHEDULED_TIME"),
            _truncated(failure.get("ERROR_MESSAGE"), 320),
            failure.get("QUERY_ID"),
        )


def _suspend_existing_pipeline_tasks(
    conn: snowflake.connector.SnowflakeConnection,
) -> None:
    """Pause existing work before a complete redeploy mutates upstream state."""
    task_names = {INGEST_TASK_NAME} | {
        str(config["task"]) for config in AI_STAGES.values()
    }
    task_names.add(INCIDENT_DISCOVERY_TASK_NAME)
    try:
        tasks = _fetch_dicts(
            conn,
            "SHOW TASKS IN SCHEMA NOCTURNE.RAW",
        )
    except snowflake.connector.errors.ProgrammingError:
        log.info("No existing NOCTURNE tasks were found to suspend.")
        return

    existing_names = sorted(
        str(row["NAME"])
        for row in tasks
        if row.get("NAME") in task_names
    )
    for task_name in existing_names:
        cur = conn.cursor()
        try:
            cur.execute(f"ALTER TASK NOCTURNE.RAW.{task_name} SUSPEND")
        finally:
            cur.close()
        log.info("Pre-deployment pause: suspended %s", task_name)
    if not existing_names:
        log.info("No existing NOCTURNE tasks were found to suspend.")


def _log_ai_cache_health(
    conn: snowflake.connector.SnowflakeConnection,
    affected_since: datetime | None,
) -> None:
    log.info("Persistent AI caches:")
    for stage, config in AI_STAGES.items():
        result_table = str(config["results"])
        candidate_table = str(config["candidates"])
        if affected_since is None:
            result_rows = _fetch_dicts(
                conn,
                f"""
                SELECT ORG_ID, STATUS, COUNT(*) AS CACHE_ROWS,
                  0 AS NEW_ROWS
                FROM {result_table}
                GROUP BY ORG_ID, STATUS
                ORDER BY ORG_ID, STATUS
                """,
            )
        else:
            result_rows = _fetch_dicts(
                conn,
                f"""
                SELECT ORG_ID, STATUS, COUNT(*) AS CACHE_ROWS,
                  COUNT_IF(CALLED_AT >= %s) AS NEW_ROWS
                FROM {result_table}
                GROUP BY ORG_ID, STATUS
                ORDER BY ORG_ID, STATUS
                """,
                (affected_since,),
            )
        if not result_rows:
            log.info("  %s: empty", stage)
        for row in result_rows:
            log.info(
                "  %s/%s: status=%s, cached=%s, new_since_start=%s",
                stage,
                row.get("ORG_ID"),
                row.get("STATUS"),
                row.get("CACHE_ROWS"),
                row.get("NEW_ROWS"),
            )

        missing_candidate_view = config.get("missing_candidates")
        if missing_candidate_view:
            candidate_rows = _fetch_dicts(
                conn,
                f"""
                SELECT ORG_ID, COUNT(*) AS MISSING_ROWS
                FROM (
                  SELECT ORG_ID, INCIDENT_KEY
                  FROM {missing_candidate_view}
                  UNION ALL
                  SELECT QUEUED.ORG_ID, QUEUED.INCIDENT_KEY
                  FROM {candidate_table} AS QUEUED
                  LEFT JOIN {result_table} AS RESULT
                    ON RESULT.ORG_ID = QUEUED.ORG_ID
                    AND RESULT.INCIDENT_KEY = QUEUED.INCIDENT_KEY
                  WHERE RESULT.INCIDENT_KEY IS NULL
                ) AS PENDING
                GROUP BY ORG_ID
                ORDER BY ORG_ID
                """,
            )
        else:
            candidate_rows = _fetch_dicts(
                conn,
                f"""
                SELECT ORG_ID, COUNT(*) AS MISSING_ROWS
                FROM {candidate_table}
                GROUP BY ORG_ID
                ORDER BY ORG_ID
                """,
            )
        if not candidate_rows:
            log.info("  %s: missing_candidates=0", stage)
        for row in candidate_rows:
            log.info(
                "  %s/%s: missing_candidates=%s",
                stage,
                row.get("ORG_ID"),
                row.get("MISSING_ROWS"),
            )


def _log_recent_cortex_costs(
    conn: snowflake.connector.SnowflakeConnection,
) -> None:
    tags = ", ".join(
        f"'{config['query_tag']}'" for config in AI_STAGES.values()
    )
    rows = _fetch_dicts(
        conn,
        f"""
        SELECT
          QUERY_TAG,
          FUNCTION_NAME,
          MODEL_NAME,
          COUNT(DISTINCT QUERY_ID) AS QUERY_COUNT,
          SUM(CREDITS) AS CREDITS
        FROM SNOWFLAKE.ACCOUNT_USAGE.CORTEX_AI_FUNCTIONS_USAGE_HISTORY
        WHERE START_TIME >= DATEADD('hour', -24, CURRENT_TIMESTAMP())
          AND QUERY_TAG IN ({tags})
        GROUP BY QUERY_TAG, FUNCTION_NAME, MODEL_NAME
        ORDER BY QUERY_TAG, FUNCTION_NAME, MODEL_NAME
        """,
    )
    if not rows:
        log.info(
            "Cortex usage: no tagged usage visible in the last 24 hours "
            "(account-usage reporting can lag)."
        )
        return
    log.info("Cortex usage in the last 24 hours:")
    for row in rows:
        log.info(
            "  tag=%s, function=%s, model=%s, queries=%s, credits=%s",
            row.get("QUERY_TAG"),
            row.get("FUNCTION_NAME"),
            row.get("MODEL_NAME"),
            row.get("QUERY_COUNT"),
            row.get("CREDITS"),
        )


def _log_relationship_groups(
    conn: snowflake.connector.SnowflakeConnection,
    affected_since: datetime | None,
) -> None:
    counts = _fetch_dicts(
        conn,
        """
        SELECT ORG_ID, RELATIONSHIP_LABEL, COUNT(*) AS PAGE_COUNT
        FROM NOCTURNE.RAW.DT_PAGE_RELATIONSHIP_CLASSIFICATION
        GROUP BY ORG_ID, RELATIONSHIP_LABEL
        ORDER BY ORG_ID, RELATIONSHIP_LABEL
        """,
    )
    log.info("Relationship labels:")
    organizations = sorted({row.get("ORG_ID") for row in counts})
    for org_id in organizations:
        count_by_label = {
            row["RELATIONSHIP_LABEL"]: row["PAGE_COUNT"]
            for row in counts
            if row.get("ORG_ID") == org_id
        }
        for label in RELATIONSHIP_LABELS:
            log.info(
                "  %s/%-28s %s page(s)",
                org_id,
                label,
                count_by_label.get(label, 0),
            )

    if affected_since is None:
        return

    affected = _fetch_dicts(
        conn,
        """
        SELECT ORG_ID, RELATIONSHIP_LABEL, _SOURCE_FILE, TITLE
        FROM NOCTURNE.RAW.DT_PAGE_RELATIONSHIP_CLASSIFICATION
        WHERE _INGESTED_AT >= %s
        ORDER BY ORG_ID, RELATIONSHIP_LABEL, _SOURCE_FILE, TITLE
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
                "    %s/%s — %s",
                row["ORG_ID"],
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
        filters.append("INPUT._INGESTED_AT >= %s")
        params = (affected_since,)
    if target_leaks_only:
        filters.append("RELATIONSHIP.RELATIONSHIP_LABEL = 'target_data_leak'")

    where_clause = f"WHERE {' AND '.join(filters)}" if filters else ""
    classification_input_column = (
        "INPUT.CLASSIFICATION_INPUT" if log_ai_inputs else "NULL::STRING"
    )
    evidence_input_column = (
        "INPUT.EVIDENCE_INPUT" if log_ai_inputs else "NULL::STRING"
    )

    pages = _fetch_dicts(
        conn,
        f"""
        SELECT
          INPUT.ORG_ID,
          INPUT.DOC_ID,
          INPUT.DEDUPE_KEY,
          INPUT.CONTENT_SHA256,
          INPUT._SOURCE_FILE,
          INPUT.TITLE,
          INPUT.INDICATOR_SUMMARY,
          INPUT.STRONG_INDICATOR_COUNT,
          INPUT.MEDIUM_INDICATOR_COUNT,
          INPUT.WEAK_INDICATOR_COUNT,
          INPUT.EVIDENCE_SCORE,
          INPUT.SOURCE_TEXT_LENGTH,
          INPUT.CLASSIFICATION_INPUT_LENGTH,
          INPUT.EVIDENCE_INPUT_LENGTH,
          INPUT.INPUT_TRUNCATED,
          INPUT.EVIDENCE_INPUT_TRUNCATED,
          INPUT.INPUT_METHOD_VERSION,
          INPUT.FALLBACK_USED,
          INPUT.FALLBACK_REASON,
          INPUT.SELECTED_WINDOWS,
          {classification_input_column} AS CLASSIFICATION_INPUT,
          {evidence_input_column} AS EVIDENCE_INPUT,
          RELATIONSHIP.TARGET_ANCHOR_TYPE,
          RELATIONSHIP.TARGET_MATCH_SCORE,
          RELATIONSHIP.RELATIONSHIP_AI_STATUS,
          RELATIONSHIP.RELATIONSHIP_LABEL,
          RELATIONSHIP.IS_RELEVANT,
          ROUTING.L2_GATE_REASON,
          ROUTING.EXTRACTION_STATUS,
          ROUTING.CLAIM_COUNT,
          ROUTING.ACCEPTED_CLAIM_COUNT,
          ROUTING.ENTITY_COUNT,
          ROUTING.ACCEPTED_ENTITY_COUNT,
          ROUTING.RELATIONSHIP_COUNT,
          ROUTING.ACCEPTED_RELATIONSHIP_COUNT,
          ROUTING.L2_ROUTE,
          ROUTING.ROUTING_REASON,
          CLASSIFICATION.LEAK_TYPE_AI_STATUS,
          CLASSIFICATION.LEAK_TYPE_LABELS,
          SEVERITY.INCIDENT_KEY,
          SEVERITY.IMPACT_SEVERITY_SCORE,
          SEVERITY.IMPACT_SEVERITY_BAND,
          SEVERITY.EVIDENCE_CONFIDENCE_SCORE,
          SEVERITY.EVIDENCE_CONFIDENCE_BAND,
          SEVERITY.TRIAGE_PRIORITY_SCORE,
          SEVERITY.TRIAGE_PRIORITY_BAND,
          SEVERITY.SCORE_METHOD_VERSION,
          INSIGHT.INSIGHT_AI_STATUS,
          INSIGHT.INSIGHT_HEADLINE,
          INSIGHT.EXECUTIVE_SUMMARY
        FROM NOCTURNE.RAW.DT_L1_CLASSIFICATION_INPUT AS INPUT
        LEFT JOIN NOCTURNE.RAW.DT_PAGE_RELATIONSHIP_CLASSIFICATION
          AS RELATIONSHIP
          ON RELATIONSHIP.ORG_ID = INPUT.ORG_ID
          AND RELATIONSHIP.DEDUPE_KEY = INPUT.DEDUPE_KEY
        LEFT JOIN NOCTURNE.RAW.DT_L2_ROUTING AS ROUTING
          ON ROUTING.ORG_ID = INPUT.ORG_ID
          AND ROUTING.DEDUPE_KEY = INPUT.DEDUPE_KEY
        LEFT JOIN NOCTURNE.RAW.DT_PAGE_CLASSIFICATION AS CLASSIFICATION
          ON CLASSIFICATION.ORG_ID = INPUT.ORG_ID
          AND CLASSIFICATION.DEDUPE_KEY = INPUT.DEDUPE_KEY
        LEFT JOIN NOCTURNE.RAW.DT_L4_DOCUMENT_SEVERITY AS SEVERITY
          ON SEVERITY.ORG_ID = INPUT.ORG_ID
          AND SEVERITY.DEDUPE_KEY = INPUT.DEDUPE_KEY
        LEFT JOIN NOCTURNE.RAW.VW_L4_INCIDENT_INSIGHTS AS INSIGHT
          ON INSIGHT.ORG_ID = SEVERITY.ORG_ID
          AND INSIGHT.INCIDENT_KEY = SEVERITY.INCIDENT_KEY
        {where_clause}
          {"AND" if where_clause else "WHERE"} (
            RELATIONSHIP.RELATIONSHIP_LABEL = 'target_data_leak'
            OR ROUTING.DEDUPE_KEY IS NOT NULL
          )
        ORDER BY
          SEVERITY.TRIAGE_PRIORITY_SCORE DESC NULLS LAST,
          INPUT.ORG_ID,
          INPUT._SOURCE_FILE,
          INPUT.TITLE
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
        entities = []
        claims = []
        affects_edges = []
        if page["EXTRACTION_STATUS"] is not None:
            entities = _fetch_dicts(
                conn,
                """
                SELECT ENTITY_TYPE, ENTITY_NAME, RESOLVED_ORG_ID,
                  ENTITY_MATCH_STATUS, ENTITY_MATCH_METHOD,
                  ENTITY_MATCH_CONFIDENCE, GROUNDING_LEVEL
                FROM NOCTURNE.RAW.DT_L2_ENTITIES
                WHERE ORG_ID = %s AND DEDUPE_KEY = %s
                  AND ENTITY_TYPE IN ('organization', 'domain')
                ORDER BY
                  IS_MONITORED_ORG DESC,
                  ENTITY_MATCH_CONFIDENCE DESC,
                  ENTITY_NAME
                LIMIT 5
                """,
                (page["ORG_ID"], page["DEDUPE_KEY"]),
            )
            claims = _fetch_dicts(
                conn,
                """
                SELECT LEFT(STATEMENT, 240) AS STATEMENT,
                  CLAIM_STATUS_EXTRACTED, GROUNDING_LEVEL
                FROM NOCTURNE.RAW.DT_L2_CLAIMS
                WHERE ORG_ID = %s AND DEDUPE_KEY = %s
                  AND IS_ACCEPTED AND IS_GROUNDED
                ORDER BY CLAIM_LOCAL_ID
                LIMIT 3
                """,
                (page["ORG_ID"], page["DEDUPE_KEY"]),
            )
            affects_edges = _fetch_dicts(
                conn,
                """
                SELECT LEFT(CLAIM.STATEMENT, 160) AS CLAIM_STATEMENT,
                  ENTITY.ENTITY_NAME AS AFFECTED_ENTITY,
                  ENTITY.ENTITY_TYPE AS AFFECTED_ENTITY_TYPE,
                  EDGE.GROUNDING_LEVEL
                FROM NOCTURNE.RAW.DT_L2_EDGES AS EDGE
                LEFT JOIN NOCTURNE.RAW.DT_L2_CLAIMS AS CLAIM
                  ON CLAIM.ORG_ID = EDGE.ORG_ID
                  AND CLAIM.DEDUPE_KEY = EDGE.DEDUPE_KEY
                  AND CLAIM.CLAIM_LOCAL_ID = EDGE.SOURCE_LOCAL_ID
                LEFT JOIN NOCTURNE.RAW.DT_L2_ENTITIES AS ENTITY
                  ON ENTITY.ORG_ID = EDGE.ORG_ID
                  AND ENTITY.DEDUPE_KEY = EDGE.DEDUPE_KEY
                  AND ENTITY.ENTITY_LOCAL_ID = EDGE.TARGET_LOCAL_ID
                WHERE EDGE.ORG_ID = %s AND EDGE.DEDUPE_KEY = %s
                  AND EDGE.IS_ACCEPTED AND EDGE.IS_GROUNDED
                  AND EDGE.EDGE_TYPE = 'ALLEGEDLY_AFFECTS'
                ORDER BY EDGE.RELATIONSHIP_LOCAL_ID
                LIMIT 5
                """,
                (page["ORG_ID"], page["DEDUPE_KEY"]),
            )

        lines = [
            "",
            "=" * 72,
            f"Organization: {page['ORG_ID']}",
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
                f"  Evidence-only L2 input length: {page['EVIDENCE_INPUT_LENGTH']}",
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
                    "",
                    "Exact masked evidence-only input sent to L2 AI_COMPLETE:",
                    "-" * 72,
                    str(page["EVIDENCE_INPUT"] or "not available"),
                    "-" * 72,
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
                "L2 extraction and ownership routing:",
                f"  Gate: {page['L2_GATE_REASON'] or 'not eligible/pending'}",
                f"  Extraction status: {page['EXTRACTION_STATUS'] or 'pending'}",
                "  Elements: "
                f"claims={page['CLAIM_COUNT'] or 0} "
                f"(accepted={page['ACCEPTED_CLAIM_COUNT'] or 0}), "
                f"entities={page['ENTITY_COUNT'] or 0} "
                f"(accepted={page['ACCEPTED_ENTITY_COUNT'] or 0}), "
                f"relationships={page['RELATIONSHIP_COUNT'] or 0} "
                f"(accepted={page['ACCEPTED_RELATIONSHIP_COUNT'] or 0})",
            ]
        )
        if entities:
            lines.append("  Extracted organization/domain entities:")
            for entity in entities:
                resolved = entity.get("RESOLVED_ORG_ID") or "not resolved"
                lines.append(
                    "    "
                    f"{_truncated(entity.get('ENTITY_NAME'), 100)} "
                    f"({entity.get('ENTITY_TYPE')}) → {resolved}; "
                    f"match={entity.get('ENTITY_MATCH_METHOD')}/"
                    f"{entity.get('ENTITY_MATCH_CONFIDENCE')}; "
                    f"status={entity.get('ENTITY_MATCH_STATUS')}; "
                    f"grounding={entity.get('GROUNDING_LEVEL')}"
                )
        if claims:
            lines.append("  Grounded claims:")
            for claim in claims:
                lines.append(
                    "    "
                    f"[{claim.get('CLAIM_STATUS_EXTRACTED')}; "
                    f"{claim.get('GROUNDING_LEVEL')}] "
                    f"{_truncated(claim.get('STATEMENT'), 240)}"
                )
        if affects_edges:
            lines.append("  Accepted ALLEGEDLY_AFFECTS relationships:")
            for edge in affects_edges:
                lines.append(
                    "    claim → "
                    f"{_truncated(edge.get('AFFECTED_ENTITY'), 100)} "
                    f"({edge.get('AFFECTED_ENTITY_TYPE')}); "
                    f"grounding={edge.get('GROUNDING_LEVEL')}"
                )
        lines.extend(
            [
                f"  Route: {page['L2_ROUTE'] or 'pending/not applicable'}",
                f"  Reason: {page['ROUTING_REASON'] or 'not available'}",
                "",
                "Leak-type classification:",
                f"  Status: {page['LEAK_TYPE_AI_STATUS'] or 'not available'}",
                "  Labels: "
                + (", ".join(str(label) for label in leak_types) or "none"),
                "",
                "L4 scoring:",
                f"  Impact severity: {page['IMPACT_SEVERITY_SCORE']} "
                f"({page['IMPACT_SEVERITY_BAND'] or 'not available'})",
                f"  Evidence confidence: {page['EVIDENCE_CONFIDENCE_SCORE']} "
                f"({page['EVIDENCE_CONFIDENCE_BAND'] or 'not available'})",
                f"  Triage priority: {page['TRIAGE_PRIORITY_SCORE']} "
                f"({page['TRIAGE_PRIORITY_BAND'] or 'not available'})",
                f"  Method: {page['SCORE_METHOD_VERSION'] or 'not available'}",
            ]
        )
        lines.extend(
            [
                "",
                "Incident insight:",
                f"  Incident key: {page['INCIDENT_KEY'] or 'not available'}",
                f"  Status: {page['INSIGHT_AI_STATUS'] or 'pending/not applicable'}",
                f"  Headline: {page['INSIGHT_HEADLINE'] or 'not available'}",
                "  Summary: "
                f"{_truncated(page['EXECUTIVE_SUMMARY'], 600) or 'not available'}",
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
    """Read pipeline state without invoking Cortex or advancing streams."""
    log.info("Pipeline verification")

    try:
        _check_ai_readiness(conn, strict=False)
    except Exception as error:
        log.warning("  AI residency/model readiness unavailable: %s", error)

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
        _log_task_health(conn)
    except Exception as error:
        log.warning("  Task health unavailable: %s", error)

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
        raw_rows = _fetch_dicts(
            conn,
            """
            SELECT ORG_ID, _PATH_ORG_ID, COUNT(*) AS PAGE_COUNT,
              COUNT_IF(SCHEMA_VERSION <> 2) AS INVALID_SCHEMA_ROWS,
              COUNT_IF(ORG_ID <> _PATH_ORG_ID) AS PATH_MISMATCH_ROWS
            FROM NOCTURNE.RAW.CRAWL_PAGES
            GROUP BY ORG_ID, _PATH_ORG_ID
            ORDER BY ORG_ID, _PATH_ORG_ID
            """,
        )
        for row in raw_rows:
            log.info(
                "Raw pages: org_id=%s, path_org_id=%s, pages=%s, "
                "invalid_schema=%s, path_mismatch=%s",
                row.get("ORG_ID"),
                row.get("_PATH_ORG_ID"),
                row.get("PAGE_COUNT"),
                row.get("INVALID_SCHEMA_ROWS"),
                row.get("PATH_MISMATCH_ROWS"),
            )
    except Exception as error:
        log.warning("Raw pages count unavailable: %s", error)

    try:
        l0_rows = _fetch_dicts(
            conn,
            """
            SELECT ORG_ID, COUNT(*) AS PAGE_COUNT
            FROM NOCTURNE.RAW.DT_REGEX_INDICATORS
            GROUP BY ORG_ID ORDER BY ORG_ID
            """,
        )
        for row in l0_rows:
            log.info(
                "L0 pages: org_id=%s, pages=%s",
                row.get("ORG_ID"),
                row.get("PAGE_COUNT"),
            )
    except Exception as error:
        log.warning("L0 pages count unavailable: %s", error)

    try:
        summary_rows = _fetch_dicts(
            conn,
            """
            SELECT
              PAGE.ORG_ID,
              PAGE.RELATIONSHIP_AI_STATUS,
              PAGE.RELATIONSHIP_LABEL,
              PAGE.L2_ROUTE,
              PAGE.LEAK_TYPE_AI_STATUS,
              SEVERITY.IMPACT_SEVERITY_BAND,
              COUNT(*) AS PAGE_COUNT
            FROM NOCTURNE.RAW.DT_PAGE_CLASSIFICATION AS PAGE
            LEFT JOIN NOCTURNE.RAW.DT_L4_DOCUMENT_SEVERITY AS SEVERITY
              ON SEVERITY.ORG_ID = PAGE.ORG_ID
              AND SEVERITY.DEDUPE_KEY = PAGE.DEDUPE_KEY
            GROUP BY
              PAGE.ORG_ID,
              PAGE.RELATIONSHIP_AI_STATUS,
              PAGE.RELATIONSHIP_LABEL,
              PAGE.L2_ROUTE,
              PAGE.LEAK_TYPE_AI_STATUS,
              SEVERITY.IMPACT_SEVERITY_BAND
            ORDER BY PAGE.ORG_ID, PAGE_COUNT DESC
            """,
        )
        classification_results = [
            (
                row["ORG_ID"],
                row["RELATIONSHIP_AI_STATUS"],
                row["RELATIONSHIP_LABEL"],
                row["L2_ROUTE"],
                row["LEAK_TYPE_AI_STATUS"],
                row["IMPACT_SEVERITY_BAND"],
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

    try:
        routes = _fetch_dicts(
            conn,
            """
            SELECT ORG_ID, L2_ROUTE, COUNT(*) AS PAGE_COUNT
            FROM NOCTURNE.RAW.DT_L2_ROUTING
            GROUP BY ORG_ID, L2_ROUTE
            ORDER BY ORG_ID, L2_ROUTE
            """,
        )
        log.info(
            "L2 routes: %s",
            [
                (row["ORG_ID"], row["L2_ROUTE"], row["PAGE_COUNT"])
                for row in routes
            ],
        )
    except Exception as error:
        log.warning("L2 routing results unavailable: %s", error)

    try:
        incidents = _fetch_dicts(
            conn,
            """
            SELECT ORG_ID, INSIGHT_AI_STATUS,
              INCIDENT_IMPACT_SEVERITY_BAND,
              COUNT(*) AS INCIDENT_COUNT
            FROM NOCTURNE.RAW.VW_L4_INCIDENT_INSIGHTS
            GROUP BY ORG_ID, INSIGHT_AI_STATUS,
              INCIDENT_IMPACT_SEVERITY_BAND
            ORDER BY ORG_ID, INCIDENT_IMPACT_SEVERITY_BAND,
              INSIGHT_AI_STATUS
            """,
        )
        log.info(
            "L4 incidents: %s",
            [
                (
                    row["ORG_ID"],
                    row["INSIGHT_AI_STATUS"],
                    row["INCIDENT_IMPACT_SEVERITY_BAND"],
                    row["INCIDENT_COUNT"],
                )
                for row in incidents
            ],
        )
    except Exception as error:
        log.warning("L4 incident results unavailable: %s", error)

    try:
        _log_ai_cache_health(conn, affected_since)
    except Exception as error:
        log.warning("AI cache/candidate health unavailable: %s", error)

    try:
        _log_recent_cortex_costs(conn)
    except Exception as error:
        log.warning("Cortex cost visibility unavailable: %s", error)


def generate_report(
    conn: snowflake.connector.SnowflakeConnection,
    output_path: Path,
) -> None:
    """Write metadata, deterministic scores, and cached incident insights."""
    log.info("Generating report -> %s", output_path)
    raw_counts = _fetch_dicts(
        conn,
        """
        SELECT ORG_ID, COUNT(*) AS PAGE_COUNT
        FROM NOCTURNE.RAW.CRAWL_PAGES
        GROUP BY ORG_ID ORDER BY ORG_ID
        """,
    )
    summary_rows = _fetch_dicts(
        conn,
        """
        SELECT
          PAGE.ORG_ID,
          PAGE.RELATIONSHIP_AI_STATUS,
          PAGE.RELATIONSHIP_LABEL,
          PAGE.L2_ROUTE,
          PAGE.LEAK_TYPE_AI_STATUS,
          SEVERITY.IMPACT_SEVERITY_BAND,
          COUNT(*) AS PAGE_COUNT
        FROM NOCTURNE.RAW.DT_PAGE_CLASSIFICATION AS PAGE
        LEFT JOIN NOCTURNE.RAW.DT_L4_DOCUMENT_SEVERITY AS SEVERITY
          ON SEVERITY.ORG_ID = PAGE.ORG_ID
          AND SEVERITY.DEDUPE_KEY = PAGE.DEDUPE_KEY
        GROUP BY
          PAGE.ORG_ID,
          PAGE.RELATIONSHIP_AI_STATUS,
          PAGE.RELATIONSHIP_LABEL,
          PAGE.L2_ROUTE,
          PAGE.LEAK_TYPE_AI_STATUS,
          SEVERITY.IMPACT_SEVERITY_BAND
        ORDER BY PAGE.ORG_ID, PAGE_COUNT DESC
        """,
    )

    # RAW_TEXT, exact indicator matches, evidence quotes, and prompts are omitted.
    pages = _fetch_dicts(
        conn,
        """
        SELECT
          PAGE.ORG_ID,
          PAGE.DOC_ID,
          PAGE.TITLE,
          PAGE.URL,
          PAGE.RELATIONSHIP_AI_STATUS,
          PAGE.RELATIONSHIP_LABEL,
          PAGE.L2_ROUTE,
          PAGE.ROUTING_REASON,
          PAGE.INDICATOR_SUMMARY,
          PAGE.EVIDENCE_SCORE,
          PAGE.TARGET_MATCH_SCORE,
          PAGE.LEAK_TYPE_LABELS,
          PAGE.LEAK_TYPE_AI_STATUS,
          SEVERITY.INCIDENT_KEY,
          SEVERITY.IMPACT_SEVERITY_SCORE,
          SEVERITY.IMPACT_SEVERITY_BAND,
          SEVERITY.EVIDENCE_CONFIDENCE_SCORE,
          SEVERITY.EVIDENCE_CONFIDENCE_BAND,
          SEVERITY.TRIAGE_PRIORITY_SCORE,
          SEVERITY.TRIAGE_PRIORITY_BAND
        FROM NOCTURNE.RAW.DT_PAGE_CLASSIFICATION AS PAGE
        LEFT JOIN NOCTURNE.RAW.DT_L4_DOCUMENT_SEVERITY AS SEVERITY
          ON SEVERITY.ORG_ID = PAGE.ORG_ID
          AND SEVERITY.DEDUPE_KEY = PAGE.DEDUPE_KEY
        ORDER BY
          SEVERITY.TRIAGE_PRIORITY_SCORE DESC NULLS LAST,
          PAGE.ORG_ID,
          PAGE.TITLE
        """,
    )
    incidents = _fetch_dicts(
        conn,
        """
        SELECT
          ORG_ID,
          INCIDENT_KEY,
          TOP_TITLE,
          INCIDENT_IMPACT_SEVERITY_SCORE,
          INCIDENT_IMPACT_SEVERITY_BAND,
          INCIDENT_EVIDENCE_CONFIDENCE_SCORE,
          INCIDENT_EVIDENCE_CONFIDENCE_BAND,
          INCIDENT_TRIAGE_PRIORITY_SCORE,
          INCIDENT_TRIAGE_PRIORITY_BAND,
          INSIGHT_AI_STATUS,
          INSIGHT_HEADLINE,
          EXECUTIVE_SUMMARY,
          WHAT_HAPPENED,
          BUSINESS_IMPACT,
          RECOMMENDED_ACTIONS,
          CONFIDENCE_ASSESSMENT,
          INSIGHT_CAVEATS,
          INSIGHT_CALLED_AT
        FROM NOCTURNE.RAW.VW_L4_INCIDENT_INSIGHTS
        ORDER BY
          INCIDENT_TRIAGE_PRIORITY_SCORE DESC NULLS LAST,
          ORG_ID,
          INCIDENT_KEY
        """,
    )

    lines = [
        "=" * 80,
        "NOCTURNE ORGANIZATION-SCOPED INCIDENT REPORT",
        "Generated: "
        + datetime.now().astimezone().isoformat(timespec="seconds"),
        "=" * 80,
        "",
        "SUMMARY",
        "-" * 40,
    ]
    for row in raw_counts:
        lines.append(
            f"  org_id={row['ORG_ID']}: raw_pages={row['PAGE_COUNT']}"
        )
    for row in summary_rows:
        lines.append(
            "  "
            f"org_id={row['ORG_ID']}, "
            f"relationship_status={row['RELATIONSHIP_AI_STATUS']}, "
            f"relationship={row['RELATIONSHIP_LABEL']}, "
            f"l2_route={row['L2_ROUTE']}, "
            f"leak_type_status={row['LEAK_TYPE_AI_STATUS']}, "
            f"impact_band={row['IMPACT_SEVERITY_BAND']}: "
            f"{row['PAGE_COUNT']}"
        )

    lines.extend(["", "PAGE METADATA", "-" * 40])
    for index, page in enumerate(pages, 1):
        leak_types = ", ".join(
            str(value) for value in _variant_array(page["LEAK_TYPE_LABELS"])
        )
        lines.extend(
            [
                "",
                f"--- [{index}] {page['ORG_ID']} / {page['TITLE']} ---",
                f"  URL: {page['URL']}",
                f"  DOC_ID: {page['DOC_ID']}",
                "  RELATIONSHIP: "
                f"{page['RELATIONSHIP_LABEL']} "
                f"(status={page['RELATIONSHIP_AI_STATUS']})",
                "  L2 ROUTE: "
                f"{page['L2_ROUTE'] or 'not applicable/pending'} "
                f"({page['ROUTING_REASON'] or 'no routing result'})",
                "  INDICATOR SUMMARY: "
                f"{page['INDICATOR_SUMMARY'] or 'none'}",
                "  LEAK TYPES: "
                f"{leak_types or 'not applicable'} "
                f"(status={page['LEAK_TYPE_AI_STATUS']})",
                "  SCORES: "
                f"impact={page['IMPACT_SEVERITY_SCORE']} "
                f"({page['IMPACT_SEVERITY_BAND']}), "
                f"confidence={page['EVIDENCE_CONFIDENCE_SCORE']} "
                f"({page['EVIDENCE_CONFIDENCE_BAND']}), "
                f"triage={page['TRIAGE_PRIORITY_SCORE']} "
                f"({page['TRIAGE_PRIORITY_BAND']})",
                f"  INCIDENT KEY: {page['INCIDENT_KEY'] or 'not applicable'}",
            ]
        )

    lines.extend(["", "TARGET INCIDENT DETAILS", "-" * 40])
    if not incidents:
        lines.append("  No L2-confirmed target incidents are available.")
    for index, incident in enumerate(incidents, 1):
        actions = _variant_array(incident["RECOMMENDED_ACTIONS"])
        caveats = _variant_array(incident["INSIGHT_CAVEATS"])
        lines.extend(
            [
                "",
                f"--- Incident [{index}] {incident['ORG_ID']} ---",
                f"  INCIDENT KEY: {incident['INCIDENT_KEY']}",
                f"  TITLE: {incident['TOP_TITLE']}",
                "  IMPACT: "
                f"{incident['INCIDENT_IMPACT_SEVERITY_SCORE']} "
                f"({incident['INCIDENT_IMPACT_SEVERITY_BAND']})",
                "  EVIDENCE CONFIDENCE: "
                f"{incident['INCIDENT_EVIDENCE_CONFIDENCE_SCORE']} "
                f"({incident['INCIDENT_EVIDENCE_CONFIDENCE_BAND']})",
                "  TRIAGE PRIORITY: "
                f"{incident['INCIDENT_TRIAGE_PRIORITY_SCORE']} "
                f"({incident['INCIDENT_TRIAGE_PRIORITY_BAND']})",
                f"  INSIGHT STATUS: {incident['INSIGHT_AI_STATUS']}",
                f"  HEADLINE: {incident['INSIGHT_HEADLINE'] or 'pending'}",
                "  EXECUTIVE SUMMARY: "
                f"{incident['EXECUTIVE_SUMMARY'] or 'pending'}",
                f"  WHAT HAPPENED: {incident['WHAT_HAPPENED'] or 'pending'}",
                f"  BUSINESS IMPACT: {incident['BUSINESS_IMPACT'] or 'pending'}",
                "  CONFIDENCE ASSESSMENT: "
                f"{incident['CONFIDENCE_ASSESSMENT'] or 'pending'}",
            ]
        )
        if actions:
            lines.append("  RECOMMENDED ACTIONS:")
            lines.extend(f"    - {action}" for action in actions)
        if caveats:
            lines.append("  CAVEATS:")
            lines.extend(f"    - {caveat}" for caveat in caveats)

    report_text = "\n".join(lines)
    output_path.write_text(report_text, encoding="utf-8")
    log.info(
        "Report saved: %s (%d pages, %d incidents, %d bytes)",
        output_path,
        len(pages),
        len(incidents),
        len(report_text),
    )
    print(f"Metadata-only report saved to: {output_path}")


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
        help="Run only the SQL file with this step number (1-16)",
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
            "Log masked L1 CLASSIFICATION_INPUT and evidence-only L2 input "
            "for eligible documents; unmatched sensitive text may remain"
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
    missing_files = [
        SQL_DIR / filename
        for filename in files_to_run
        if not (SQL_DIR / filename).exists()
    ]
    if missing_files:
        for filepath in missing_files:
            log.error("Missing: %s", filepath)
        return

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
                target_leaks_only=False,
            )
            log.info("Verification complete. Log saved to %s", log_path)
            return

        log.info("Deploying %d pipeline step file(s).", len(files_to_run))
        if 1 not in selected_steps:
            log.info(
                "Preserving existing NOCTURNE_GCS_INT; "
                "step 01 is excluded from this deployment."
            )
        if 15 in selected_steps:
            _suspend_existing_pipeline_tasks(conn)

        readiness_checked = False
        for step in selected_steps:
            filename = DEPLOY_STEPS[step]
            if step in {9, 14, 15} and not readiness_checked:
                try:
                    _check_ai_readiness(conn, strict=True)
                except RuntimeError as error:
                    log.error("AI readiness check failed: %s", error)
                    log.error(
                        "No paid AI task was resumed. Any existing pipeline "
                        "tasks remain suspended; review model access and "
                        "CORTEX_ENABLED_CROSS_REGION, then retry."
                    )
                    return
                readiness_checked = True
            filepath = SQL_DIR / filename
            execute_file(conn, filepath)

        verify_pipeline(
            conn,
            affected_since=deployment_started_at,
            include_all_details=(
                args.step is not None and args.step in range(5, 17)
            ),
            log_ai_inputs=args.log_ai_inputs,
        )
        log.info("Pipeline deployment complete.")
        if 15 in selected_steps:
            log.info(
                "AI tasks run asynchronously. Use --verify-only after the "
                "triggered tasks finish to see final L2/L4 results."
            )
        log.info("Log saved to %s", log_path)

    finally:
        conn.close()


if __name__ == "__main__":
    main()
