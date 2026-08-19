"""
Transfer all NOCTURNE tables from source Snowflake account to destination account.

Usage:
  # With PAT token:
  python scripts/transfer_data.py --source-token "YOUR_PAT_TOKEN"

  # With username/password:
  python scripts/transfer_data.py --source-user VANICHITKARA --source-password "PASSWORD"

The script will:
  1. Connect to the source account and list all tables in NOCTURNE database
  2. Export each table to local Parquet files (in ./export/)
  3. Deduplicate: for tables with URL + timestamp, keep only the latest row per URL
  4. Connect to the destination account (your account)
  5. Recreate the schema structure and load all deduplicated tables
"""

import argparse
import os
import sys
from pathlib import Path

import pandas as pd
import snowflake.connector

# --- Configuration ---
SOURCE_ACCOUNT = "RJGWILX-TO66921"
SOURCE_WAREHOUSE = "COMPUTE_WH"
SOURCE_DATABASE = "NOCTURNE"

DEST_ACCOUNT = "SXPUVST-ON65878"
DEST_WAREHOUSE = "COMPUTE_WH"
DEST_DATABASE = "NOCTURNE"

EXPORT_DIR = Path("./export")

# Schemas to skip
SKIP_SCHEMAS = {"INFORMATION_SCHEMA"}

# Deduplication rules: table_name -> (partition_cols, order_col, order_ascending)
# Keep the latest row per partition key, ordered by order_col descending
DEDUP_RULES = {
    "CRAWL_PAGES": {
        "partition_by": ["URL"],
        "order_by": "FETCHED_AT",
        "keep": "last",  # keep latest
    },
    "RELATIONSHIP_AI_RESULTS": {
        "partition_by": ["ORG_ID", "DEDUPE_KEY"],
        "order_by": "CLASSIFIED_AT",
        "keep": "last",
    },
    "L2_EXTRACTION_AI_RESULTS": {
        "partition_by": ["ORG_ID", "DEDUPE_KEY"],
        "order_by": "EXTRACTED_AT",
        "keep": "last",
    },
    "INCIDENT_INSIGHT_AI_RESULTS": {
        "partition_by": ["ORG_ID", "INCIDENT_KEY"],
        "order_by": "GENERATED_AT",
        "keep": "last",
    },
}


def connect_source(args):
    """Connect to source account using provided credentials."""
    if args.source_token:
        return snowflake.connector.connect(
            account=SOURCE_ACCOUNT,
            token=args.source_token,
            authenticator="programmatic_access_token",
            warehouse=SOURCE_WAREHOUSE,
            database=SOURCE_DATABASE,
        )
    elif args.source_user and args.source_password:
        return snowflake.connector.connect(
            account=SOURCE_ACCOUNT,
            user=args.source_user,
            password=args.source_password,
            warehouse=SOURCE_WAREHOUSE,
            database=SOURCE_DATABASE,
        )
    else:
        print("ERROR: Provide either --source-token or --source-user + --source-password")
        sys.exit(1)


def connect_dest(args):
    """Connect to destination account."""
    if args.dest_token:
        return snowflake.connector.connect(
            account=DEST_ACCOUNT,
            token=args.dest_token,
            authenticator="programmatic_access_token",
            warehouse=DEST_WAREHOUSE,
        )
    elif args.dest_user and args.dest_password:
        return snowflake.connector.connect(
            account=DEST_ACCOUNT,
            user=args.dest_user,
            password=args.dest_password,
            warehouse=DEST_WAREHOUSE,
        )
    else:
        print("ERROR: Provide either --dest-token or --dest-user + --dest-password")
        sys.exit(1)


def get_all_tables(conn):
    """Get all tables across all schemas in NOCTURNE database."""
    cur = conn.cursor()
    cur.execute(f"SHOW SCHEMAS IN DATABASE {SOURCE_DATABASE}")
    schemas = [row[1] for row in cur.fetchall() if row[1] not in SKIP_SCHEMAS]

    tables = []
    for schema in schemas:
        cur.execute(f"SHOW TABLES IN {SOURCE_DATABASE}.{schema}")
        for row in cur.fetchall():
            tables.append((schema, row[1]))
        # Also get views (for export as tables)
        cur.execute(f"SHOW VIEWS IN {SOURCE_DATABASE}.{schema}")
        for row in cur.fetchall():
            tables.append((schema, row[1]))
    cur.close()
    return schemas, tables


def dedup_dataframe(df, table_name):
    """Deduplicate a DataFrame based on DEDUP_RULES. Keep latest per key."""
    rule = DEDUP_RULES.get(table_name)
    if rule is None:
        # Auto-detect: if table has URL + a timestamp column, dedup by URL
        cols = [c.upper() for c in df.columns]
        url_col = next((c for c in df.columns if c.upper() in ("URL", "PAGE_URL", "SOURCE_URL", "LINK")), None)
        time_col = next((c for c in df.columns if c.upper() in (
            "FETCHED_AT", "CREATED_AT", "UPDATED_AT", "CLASSIFIED_AT",
            "EXTRACTED_AT", "GENERATED_AT", "INSERTED_AT", "SCANNED_AT"
        )), None)
        if url_col and time_col:
            rule = {"partition_by": [url_col], "order_by": time_col, "keep": "last"}
        else:
            return df, 0  # No dedup possible

    partition_cols = rule["partition_by"]
    order_col = rule["order_by"]

    # Check columns exist in DataFrame (case-insensitive match)
    df_cols_upper = {c.upper(): c for c in df.columns}
    partition_actual = [df_cols_upper.get(c.upper()) for c in partition_cols]
    order_actual = df_cols_upper.get(order_col.upper())

    if not all(partition_actual) or not order_actual:
        return df, 0  # Columns not found, skip dedup

    original_count = len(df)
    df = df.sort_values(order_actual, ascending=True)
    df = df.drop_duplicates(subset=partition_actual, keep="last")
    removed = original_count - len(df)
    return df, removed


def export_table(conn, schema, table, batch_size=500000):
    """Export a single table to Parquet file(s), with deduplication."""
    fqn = f"{SOURCE_DATABASE}.{schema}.{table}"
    out_dir = EXPORT_DIR / schema
    out_dir.mkdir(parents=True, exist_ok=True)
    out_file = out_dir / f"{table}.parquet"

    print(f"  Exporting {fqn} ... ", end="", flush=True)

    cur = conn.cursor()
    try:
        cur.execute(f"SELECT COUNT(*) FROM {fqn}")
        row_count = cur.fetchone()[0]

        if row_count == 0:
            print("(empty, skipping)")
            # Write DDL only
            cur.execute(f"SELECT GET_DDL('TABLE', '{fqn}')")
            ddl = cur.fetchone()[0]
            ddl_file = out_dir / f"{table}.ddl.sql"
            ddl_file.write_text(ddl, encoding="utf-8")
            return 0

        # Fetch all data using pandas
        cur.execute(f"SELECT * FROM {fqn}")
        df = cur.fetch_pandas_all()

        # Deduplicate
        df, removed = dedup_dataframe(df, table)
        dedup_msg = f" (deduped: -{removed})" if removed > 0 else ""

        df.to_parquet(out_file, index=False)
        print(f"{row_count} rows -> {len(df)} rows{dedup_msg} -> {out_file.name}")

        # Also save DDL for schema recreation
        try:
            cur.execute(f"SELECT GET_DDL('TABLE', '{fqn}')")
            ddl = cur.fetchone()[0]
            ddl_file = out_dir / f"{table}.ddl.sql"
            ddl_file.write_text(ddl, encoding="utf-8")
        except Exception:
            pass  # Views may not support GET_DDL('TABLE', ...)

        return len(df)
    except Exception as e:
        print(f"ERROR: {e}")
        return -1
    finally:
        cur.close()


def import_table(conn, schema, table):
    """Import a Parquet file into the destination account."""
    parquet_file = EXPORT_DIR / schema / f"{table}.parquet"
    ddl_file = EXPORT_DIR / schema / f"{table}.ddl.sql"
    fqn = f"{DEST_DATABASE}.{schema}.{table}"

    cur = conn.cursor()
    try:
        # Create schema if not exists
        cur.execute(f"CREATE SCHEMA IF NOT EXISTS {DEST_DATABASE}.{schema}")

        # Create table from DDL if available
        if ddl_file.exists():
            ddl = ddl_file.read_text(encoding="utf-8")
            # Replace source database references
            ddl = ddl.replace(f"{SOURCE_DATABASE}.{schema}", f"{DEST_DATABASE}.{schema}")
            try:
                # Add OR REPLACE for idempotency
                ddl = ddl.replace("CREATE TABLE", "CREATE OR REPLACE TABLE", 1)
                ddl = ddl.replace("CREATE VIEW", "CREATE OR REPLACE VIEW", 1)
                cur.execute(ddl)
            except Exception as e:
                print(f"    DDL failed for {fqn}: {e}")
                # Fall through to pandas-based creation

        if not parquet_file.exists():
            print(f"  {fqn}: DDL only (no data)")
            return 0

        print(f"  Importing {fqn} ... ", end="", flush=True)

        # Read parquet and write using write_pandas
        df = pd.read_parquet(parquet_file)
        if df.empty:
            print("(empty)")
            return 0

        from snowflake.connector.pandas_tools import write_pandas

        # Ensure table exists (write_pandas can auto-create but DDL is better)
        success, num_chunks, num_rows, _ = write_pandas(
            conn, df, table, database=DEST_DATABASE, schema=schema,
            auto_create_table=True, overwrite=True
        )
        print(f"{num_rows} rows loaded")
        return num_rows

    except Exception as e:
        print(f"  ERROR importing {fqn}: {e}")
        return -1
    finally:
        cur.close()


def main():
    parser = argparse.ArgumentParser(description="Transfer NOCTURNE database between Snowflake accounts")
    # Source credentials
    parser.add_argument("--source-token", help="PAT token for source account")
    parser.add_argument("--source-user", help="Username for source account")
    parser.add_argument("--source-password", help="Password for source account")
    # Destination credentials
    parser.add_argument("--dest-token", help="PAT token for destination account")
    parser.add_argument("--dest-user", help="Username for destination account")
    parser.add_argument("--dest-password", help="Password for destination account")
    # Options
    parser.add_argument("--export-only", action="store_true", help="Only export, don't import")
    parser.add_argument("--import-only", action="store_true", help="Only import from existing export/")
    parser.add_argument("--schemas", nargs="*", help="Only process these schemas")

    args = parser.parse_args()

    # --- EXPORT phase ---
    if not args.import_only:
        print("=" * 60)
        print(f"EXPORT: Connecting to source account {SOURCE_ACCOUNT}...")
        print("=" * 60)
        src_conn = connect_source(args)
        print(f"Connected as: {src_conn.cursor().execute('SELECT CURRENT_USER()').fetchone()[0]}")

        schemas, tables = get_all_tables(src_conn)
        if args.schemas:
            tables = [(s, t) for s, t in tables if s in args.schemas]
            schemas = [s for s in schemas if s in args.schemas]

        print(f"\nFound {len(schemas)} schemas, {len(tables)} tables/views:")
        for schema in schemas:
            schema_tables = [t for s, t in tables if s == schema]
            print(f"  {schema}: {len(schema_tables)} objects")

        EXPORT_DIR.mkdir(parents=True, exist_ok=True)
        total_rows = 0
        for schema, table in tables:
            rows = export_table(src_conn, schema, table)
            if rows > 0:
                total_rows += rows

        src_conn.close()
        print(f"\nExport complete: {total_rows} total rows -> {EXPORT_DIR}/")

    if args.export_only:
        return

    # --- IMPORT phase ---
    if not args.import_only and not args.dest_token and not args.dest_user:
        print("\nNo destination credentials provided. Run with --import-only later.")
        print(f"Parquet files saved in: {EXPORT_DIR.absolute()}")
        return

    print("\n" + "=" * 60)
    print(f"IMPORT: Connecting to destination account {DEST_ACCOUNT}...")
    print("=" * 60)
    dest_conn = connect_dest(args)
    print(f"Connected as: {dest_conn.cursor().execute('SELECT CURRENT_USER()').fetchone()[0]}")

    # Create database
    dest_conn.cursor().execute(f"CREATE DATABASE IF NOT EXISTS {DEST_DATABASE}")
    dest_conn.cursor().execute(f"USE DATABASE {DEST_DATABASE}")

    # Import all exported tables
    for schema_dir in sorted(EXPORT_DIR.iterdir()):
        if not schema_dir.is_dir():
            continue
        schema = schema_dir.name
        if args.schemas and schema not in args.schemas:
            continue

        print(f"\n--- Schema: {schema} ---")
        for parquet_file in sorted(schema_dir.glob("*.parquet")):
            table = parquet_file.stem
            import_table(dest_conn, schema, table)

        # Handle DDL-only tables (no parquet)
        for ddl_file in sorted(schema_dir.glob("*.ddl.sql")):
            table = ddl_file.stem.replace(".ddl", "")
            parquet_file = schema_dir / f"{table}.parquet"
            if not parquet_file.exists():
                import_table(dest_conn, schema, table)

    dest_conn.close()
    print("\nImport complete!")


if __name__ == "__main__":
    main()
