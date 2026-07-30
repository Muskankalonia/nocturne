"""Run the destructive Nocturne Snowflake cleanup with explicit confirmation."""

import argparse
import logging
import os
import sys
from datetime import datetime
from pathlib import Path

import snowflake.connector

from deploy_pipeline import load_dotenv, parse_sql_statements


PROJECT_ROOT = Path(__file__).resolve().parent
CLEANUP_SQL = PROJECT_ROOT / "snowflake" / "99_cleanup.sql"
LOG_DIR = PROJECT_ROOT / "logs"
REQUIRED_CONFIRMATION = "DROP_NOCTURNE"

log = logging.getLogger("nocturne_cleanup")


def configure_logging() -> Path:
    """Log cleanup progress to the terminal and a timestamped local file."""
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().astimezone().strftime("%Y%m%d_%H%M%S_%z")
    log_path = LOG_DIR / f"cleanup_{timestamp}.log"
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

    for logger_name in ("snowflake.connector", "botocore", "boto3"):
        logging.getLogger(logger_name).setLevel(logging.WARNING)

    log.info("Cleanup log: %s", log_path)
    return log_path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Permanently remove the Nocturne Snowflake environment."
    )
    parser.add_argument(
        "--account",
        default=os.environ.get("SNOWFLAKE_ACCOUNT"),
        help="Snowflake account identifier",
    )
    parser.add_argument(
        "--user",
        default=os.environ.get("SNOWFLAKE_USER"),
        help="Snowflake username",
    )
    parser.add_argument(
        "--password",
        default=os.environ.get("SNOWFLAKE_PASSWORD"),
        help="Snowflake password",
    )
    parser.add_argument(
        "--token",
        default=os.environ.get("SNOWFLAKE_TOKEN"),
        help="Snowflake programmatic access token",
    )
    parser.add_argument(
        "--warehouse",
        default=os.environ.get("SNOWFLAKE_WAREHOUSE", "COMPUTE_WH"),
        help="Snowflake warehouse",
    )
    parser.add_argument(
        "--role",
        default=os.environ.get("SNOWFLAKE_ROLE", "ACCOUNTADMIN"),
        help="Snowflake role; cleanup requires ACCOUNTADMIN-level privileges",
    )
    parser.add_argument(
        "--confirm",
        help=(
            f"Non-interactive confirmation; must equal {REQUIRED_CONFIRMATION}. "
            "When omitted, confirmation is requested interactively."
        ),
    )
    return parser.parse_args()


def require_confirmation(provided_confirmation: str | None) -> None:
    """Require an exact destructive-action confirmation."""
    confirmation = provided_confirmation
    if confirmation is None:
        print(
            "WARNING: This permanently deletes the NOCTURNE database and "
            "NOCTURNE_GCS_INT."
        )
        confirmation = input(
            f"Type {REQUIRED_CONFIRMATION} to continue: "
        ).strip()

    if confirmation != REQUIRED_CONFIRMATION:
        raise SystemExit("Cleanup cancelled: confirmation did not match.")


def connect(args: argparse.Namespace) -> snowflake.connector.SnowflakeConnection:
    """Connect using a PAT when configured, otherwise use a password."""
    if not args.account:
        raise SystemExit(
            "SNOWFLAKE_ACCOUNT is required in .env or through --account."
        )

    connection_args = {
        "account": args.account,
        "user": args.user or "",
        "warehouse": args.warehouse,
        "role": args.role,
    }

    if args.token:
        connection_args.update(
            token=args.token,
            authenticator="programmatic_access_token",
        )
    else:
        if not args.user or not args.password:
            raise SystemExit(
                "SNOWFLAKE_USER and SNOWFLAKE_PASSWORD are required when "
                "SNOWFLAKE_TOKEN is not configured."
            )
        connection_args["password"] = args.password

    log.info(
        "Connecting to %s (user=%s, role=%s, warehouse=%s)",
        args.account,
        args.user or "",
        args.role,
        args.warehouse,
    )
    return snowflake.connector.connect(**connection_args)


def run_cleanup(conn: snowflake.connector.SnowflakeConnection) -> None:
    """Execute the reviewed cleanup SQL sequentially and stop on any failure."""
    if not CLEANUP_SQL.exists():
        raise FileNotFoundError(f"Cleanup SQL not found: {CLEANUP_SQL}")

    statements = parse_sql_statements(CLEANUP_SQL)
    log.info("Executing %d cleanup statements.", len(statements))

    for index, statement in enumerate(statements, start=1):
        summary = " ".join(statement.split())[:160]
        log.info("[%d/%d] %s", index, len(statements), summary)
        cursor = conn.cursor()
        try:
            cursor.execute(statement)
            if cursor.description:
                rows = cursor.fetchall()
                log.info("  Result rows: %s", rows)
            else:
                log.info("  Completed.")
        finally:
            cursor.close()


def main() -> None:
    load_dotenv()
    args = parse_args()
    require_confirmation(args.confirm)
    log_path = configure_logging()

    conn = None
    try:
        conn = connect(args)
        run_cleanup(conn)
    except Exception:
        log.exception("Cleanup failed.")
        raise
    finally:
        if conn is not None:
            conn.close()

    log.info("Nocturne Snowflake cleanup completed.")
    log.info("Log saved to %s", log_path)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("Cleanup cancelled.")
        sys.exit(130)

