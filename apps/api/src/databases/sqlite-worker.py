#!/usr/bin/env python3
import sys
import os
import json
import sqlite3
import base64
import time

FORBIDDEN_PATH_PREFIXES = [
    "/proc",
    "/sys",
    "/dev",
    "/etc/shadow",
    "/etc/sudoers",
    "/root",
]

def check_path_allowed(db_path: str):
    real_path = os.path.realpath(os.path.abspath(db_path))
    for prefix in FORBIDDEN_PATH_PREFIXES:
        if real_path.startswith(prefix):
            raise PermissionError(f"Access to path '{real_path}' is denied for security reasons.")
    return real_path

def create_connection(db_path: str, is_read_only: bool = False):
    real_path = check_path_allowed(db_path)
    
    # If file doesn't exist and read-only, fail
    if is_read_only and not os.path.exists(real_path):
        raise FileNotFoundError(f"SQLite database file not found: {real_path}")

    # Ensure parent directory exists if creating new db
    parent_dir = os.path.dirname(real_path)
    if parent_dir and not os.path.exists(parent_dir):
        os.makedirs(parent_dir, exist_ok=True)

    if is_read_only:
        uri = f"file:{real_path}?mode=ro"
        conn = sqlite3.connect(uri, uri=True, timeout=10.0)
    else:
        conn = sqlite3.connect(real_path, timeout=10.0)

    # Enable foreign keys and busy timeout
    conn.execute("PRAGMA foreign_keys = ON;")
    conn.execute("PRAGMA busy_timeout = 5000;")

    # SQLite Authorizer for security
    def authorizer_callback(action, arg1, arg2, dbname, source):
        # Disallow attaching external databases
        if action == sqlite3.SQLITE_ATTACH:
            return sqlite3.SQLITE_DENY
        # If read-only, disallow modifications
        if is_read_only:
            write_actions = {
                sqlite3.SQLITE_INSERT,
                sqlite3.SQLITE_UPDATE,
                sqlite3.SQLITE_DELETE,
                sqlite3.SQLITE_CREATE_TABLE,
                sqlite3.SQLITE_CREATE_INDEX,
                sqlite3.SQLITE_CREATE_VIEW,
                sqlite3.SQLITE_CREATE_TRIGGER,
                sqlite3.SQLITE_DROP_TABLE,
                sqlite3.SQLITE_DROP_INDEX,
                sqlite3.SQLITE_DROP_VIEW,
                sqlite3.SQLITE_DROP_TRIGGER,
                sqlite3.SQLITE_ALTER_TABLE,
            }
            if action in write_actions:
                return sqlite3.SQLITE_DENY
        return sqlite3.SQLITE_OK

    conn.set_authorizer(authorizer_callback)
    return conn

def serialize_value(val):
    if val is None:
        return None
    if isinstance(val, (int, float, str, bool)):
        return val
    if isinstance(val, (bytes, bytearray)):
        return f"__bytes_b64__:{base64.b64encode(val).decode('ascii')}"
    return str(val)

def handle_test(conn):
    c = conn.cursor()
    c.execute("SELECT sqlite_version()")
    ver = c.fetchone()[0]
    return {"ok": True, "version": f"SQLite {ver}"}

def handle_catalog(conn, db_path):
    c = conn.cursor()
    # List tables and views
    c.execute("""
        SELECT name, type, sql 
        FROM sqlite_master 
        WHERE name NOT LIKE 'sqlite_%' 
        ORDER BY name
    """)
    items = c.fetchall()

    tables = []
    views = []

    for name, item_type, sql in items:
        if item_type == "view":
            views.append({"name": name, "schema": "main", "definition": sql})
            continue

        # Column info
        c.execute(f"PRAGMA table_info(\"{name}\")")
        col_rows = c.fetchall()
        # cid, name, type, notnull, dflt_value, pk
        columns = []
        pks = []
        for cid, cname, ctype, notnull, dflt, pk in col_rows:
            is_pk = bool(pk)
            if is_pk:
                pks.append(cname)
            columns.append({
                "name": cname,
                "type": ctype or "TEXT",
                "dataType": (ctype or "TEXT").split("(")[0].upper(),
                "nullable": not bool(notnull),
                "defaultValue": dflt,
                "isPrimaryKey": is_pk,
                "isAutoIncrement": "AUTOINCREMENT" in (sql or "").upper() if is_pk else False
            })

        # Foreign keys
        c.execute(f"PRAGMA foreign_key_list(\"{name}\")")
        fk_rows = c.fetchall()
        # id, seq, table, from, to, on_update, on_delete, match
        foreign_keys = []
        for fk_id, seq, ref_table, from_col, to_col, on_upd, on_del, match in fk_rows:
            foreign_keys.append({
                "name": f"fk_{name}_{from_col}_{ref_table}",
                "column": from_col,
                "referencedTable": ref_table,
                "referencedColumn": to_col,
                "onUpdate": on_upd,
                "onDelete": on_del
            })

        # Indexes
        c.execute(f"PRAGMA index_list(\"{name}\")")
        idx_rows = c.fetchall()
        # seq, name, unique, origin, partial
        indexes = []
        for iseq, iname, iunique, iorigin, ipartial in idx_rows:
            c.execute(f"PRAGMA index_info(\"{iname}\")")
            idx_cols = [r[2] for r in c.fetchall()]
            indexes.append({
                "name": iname,
                "columns": idx_cols,
                "unique": bool(iunique)
            })

        # Count estimate
        row_count = 0
        try:
            c.execute(f"SELECT count(*) FROM \"{name}\"")
            row_count = c.fetchone()[0]
        except Exception:
            pass

        tables.append({
            "name": name,
            "schema": "main",
            "rowCount": row_count,
            "columns": columns,
            "primaryKeys": pks,
            "foreignKeys": foreign_keys,
            "indexes": indexes
        })

    return {
        "engine": "SQLITE",
        "currentDatabase": os.path.basename(db_path),
        "capabilities": {
            "schemas": False,
            "alterColumn": False,
            "dropColumn": True,
            "foreignKeys": True,
            "indexes": True,
            "views": True,
            "triggers": True,
            "functions": False,
            "cancelQuery": True,
            "explain": True
        },
        "schemas": [
            {
                "name": "main",
                "tables": tables,
                "views": views
            }
        ]
    }

def handle_table_data(conn, params):
    table_name = params.get("tableName")
    page = max(1, int(params.get("page", 1)))
    page_size = min(500, max(1, int(params.get("pageSize", 50))))
    sort_column = params.get("sortColumn")
    sort_direction = params.get("sortDirection", "asc").lower()
    search = params.get("search")
    filter_col = params.get("filterColumn")
    filter_op = params.get("filterOp")
    filter_val = params.get("filterValue")

    c = conn.cursor()
    # Get columns
    c.execute(f"PRAGMA table_info(\"{table_name}\")")
    col_rows = c.fetchall()
    columns = []
    primary_keys = []
    for cid, cname, ctype, notnull, dflt, pk in col_rows:
        is_pk = bool(pk)
        if is_pk:
            primary_keys.append(cname)
        columns.append({
            "name": cname,
            "type": ctype or "TEXT",
            "dataType": (ctype or "TEXT").split("(")[0].upper(),
            "nullable": not bool(notnull),
            "defaultValue": dflt,
            "isPrimaryKey": is_pk
        })

    conditions = []
    values = []

    if filter_col and filter_op:
        esc_col = f"\"{filter_col}\""
        if filter_op == "eq":
            conditions.append(f"{esc_col} = ?")
            values.append(filter_val)
        elif filter_op == "neq":
            conditions.append(f"{esc_col} != ?")
            values.append(filter_val)
        elif filter_op == "like":
            conditions.append(f"{esc_col} LIKE ?")
            values.append(f"%{filter_val}%")
        elif filter_op == "gt":
            conditions.append(f"{esc_col} > ?")
            values.append(filter_val)
        elif filter_op == "lt":
            conditions.append(f"{esc_col} < ?")
            values.append(filter_val)
        elif filter_op == "gte":
            conditions.append(f"{esc_col} >= ?")
            values.append(filter_val)
        elif filter_op == "lte":
            conditions.append(f"{esc_col} <= ?")
            values.append(filter_val)
        elif filter_op == "null":
            conditions.append(f"{esc_col} IS NULL")
        elif filter_op == "notnull":
            conditions.append(f"{esc_col} IS NOT NULL")

    if search and search.strip():
        search_terms = []
        for col in columns:
            search_terms.append(f"CAST(\"{col['name']}\" AS TEXT) LIKE ?")
            values.append(f"%{search.strip()}%")
        if search_terms:
            conditions.append(f"({' OR '.join(search_terms)})")

    where_sql = f"WHERE {' AND '.join(conditions)}" if conditions else ""

    # Count
    c.execute(f"SELECT count(*) FROM \"{table_name}\" {where_sql}", values)
    total_rows = c.fetchone()[0]

    # Order
    order_sql = ""
    if sort_column and any(col["name"] == sort_column for col in columns):
        direction = "DESC" if sort_direction == "desc" else "ASC"
        order_sql = f"ORDER BY \"{sort_column}\" {direction}"
    elif primary_keys:
        order_sql = f"ORDER BY {', '.join([f'\"{pk}\" ASC' for pk in primary_keys])}"

    offset = (page - 1) * page_size
    data_sql = f"SELECT * FROM \"{table_name}\" {where_sql} {order_sql} LIMIT ? OFFSET ?"
    c.execute(data_sql, [*values, page_size, offset])

    raw_rows = c.fetchall()
    col_names = [col["name"] for col in columns]
    rows = []
    for r in raw_rows:
        row_dict = {}
        for idx, val in enumerate(r):
            row_dict[col_names[idx]] = serialize_value(val)
        rows.append(row_dict)

    return {
        "columns": columns,
        "rows": rows,
        "totalRows": total_rows,
        "page": page,
        "pageSize": page_size,
        "primaryKeys": primary_keys,
        "isReadOnly": False
    }

def handle_mutate_row(conn, params):
    action = (params.get("action") or "").upper()
    table_name = params.get("tableName") or params.get("table")
    c = conn.cursor()

    if action == "INSERT":
        values_dict = params.get("values") or params.get("row") or {}
        if not values_dict:
            c.execute(f"INSERT INTO \"{table_name}\" DEFAULT VALUES")
        else:
            cols = list(values_dict.keys())
            placeholders = ["?"] * len(cols)
            sql = f"INSERT INTO \"{table_name}\" ({', '.join([f'\"{col}\"' for col in cols])}) VALUES ({', '.join(placeholders)})"
            c.execute(sql, list(values_dict.values()))
        conn.commit()
        return {"ok": True, "affectedRows": c.rowcount}

    if action == "UPDATE":
        keys_dict = params.get("keys") or params.get("primaryKey") or {}
        values_dict = params.get("values") or params.get("row") or {}
        if not keys_dict:
            raise ValueError("Keys are required for UPDATE")
        if not values_dict:
            return {"ok": True, "affectedRows": 0}

        set_clauses = [f"\"{k}\" = ?" for k in values_dict.keys()]
        where_clauses = [f"\"{k}\" = ?" for k in keys_dict.keys()]
        sql = f"UPDATE \"{table_name}\" SET {', '.join(set_clauses)} WHERE {' AND '.join(where_clauses)}"
        c.execute(sql, [*list(values_dict.values()), *list(keys_dict.values())])
        conn.commit()
        return {"ok": True, "affectedRows": c.rowcount}

    if action == "DELETE":
        keys_dict = params.get("keys") or params.get("primaryKey") or {}
        if not keys_dict:
            raise ValueError("Keys are required for DELETE")
        where_clauses = [f"\"{k}\" = ?" for k in keys_dict.keys()]
        sql = f"DELETE FROM \"{table_name}\" WHERE {' AND '.join(where_clauses)}"
        c.execute(sql, list(keys_dict.values()))
        conn.commit()
        return {"ok": True, "affectedRows": c.rowcount}

    raise ValueError(f"Unknown action: {action}")

def handle_alter_table(conn, params):
    action = params.get("action")
    table_name = params.get("tableName")
    c = conn.cursor()

    if action == "CREATE_TABLE":
        columns = params.get("columns", [])
        if not columns:
            raise ValueError("Columns required to create table")
        col_defs = []
        for col in columns:
            def_str = f"\"{col['name']}\" {col['type']}"
            if col.get("isPrimaryKey"):
                def_str += " PRIMARY KEY"
            if col.get("nullable") is False:
                def_str += " NOT NULL"
            if col.get("defaultValue"):
                def_str += f" DEFAULT {col['defaultValue']}"
            col_defs.append(def_str)
        c.execute(f"CREATE TABLE \"{table_name}\" ({', '.join(col_defs)})")
        conn.commit()
        return {"ok": True, "message": f"Table {table_name} created"}

    if action == "DROP_TABLE":
        c.execute(f"DROP TABLE IF EXISTS \"{table_name}\"")
        conn.commit()
        return {"ok": True, "message": f"Table {table_name} dropped"}

    if action == "ADD_COLUMN":
        col = params.get("column", {})
        def_str = f"\"{col['name']}\" {col['type']}"
        if col.get("defaultValue"):
            def_str += f" DEFAULT {col['defaultValue']}"
        c.execute(f"ALTER TABLE \"{table_name}\" ADD COLUMN {def_str}")
        conn.commit()
        return {"ok": True, "message": f"Column {col['name']} added"}

    if action == "DROP_COLUMN":
        col_name = params.get("columnName")
        c.execute(f"ALTER TABLE \"{table_name}\" DROP COLUMN \"{col_name}\"")
        conn.commit()
        return {"ok": True, "message": f"Column {col_name} dropped"}

    if action == "ADD_INDEX":
        idx = params.get("index", {})
        unique_str = "UNIQUE " if idx.get("unique") else ""
        idx_cols = ", ".join([f"\"{c}\"" for c in idx.get("columns", [])])
        c.execute(f"CREATE {unique_str}INDEX \"{idx['name']}\" ON \"{table_name}\" ({idx_cols})")
        conn.commit()
        return {"ok": True, "message": f"Index {idx['name']} created"}

    if action == "DROP_INDEX":
        idx_name = params.get("indexName")
        c.execute(f"DROP INDEX IF EXISTS \"{idx_name}\"")
        conn.commit()
        return {"ok": True, "message": f"Index {idx_name} dropped"}

    raise ValueError(f"Unknown alteration action: {action}")

def handle_execute_sql(conn, params):
    sql = params.get("sql", "").strip()
    limit = int(params.get("limit", 500))
    session_id = params.get("sessionId", f"sqlite_{int(time.time()*1000)}")

    c = conn.cursor()
    start_time = time.time()
    
    # Check if multiple statements
    statements = [s.strip() for s in sql.split(";") if s.strip()]
    last_cursor = None
    affected_rows = 0

    for stmt in statements:
        last_cursor = c.execute(stmt)
        if c.rowcount > 0:
            affected_rows += c.rowcount

    conn.commit()
    elapsed_ms = int((time.time() - start_time) * 1000)

    columns = []
    rows = []

    if last_cursor and last_cursor.description:
        columns = [d[0] for d in last_cursor.description]
        raw_rows = last_cursor.fetchmany(limit)
        for r in raw_rows:
            row_dict = {}
            for idx, val in enumerate(r):
                row_dict[columns[idx]] = serialize_value(val)
            rows.append(row_dict)

    return {
        "sessionId": session_id,
        "columns": columns,
        "rows": rows,
        "rowCount": len(rows),
        "executionTimeMs": elapsed_ms,
        "affectedRows": affected_rows
    }

def handle_export(conn, params):
    fmt = (params.get("format") or "SQL").upper()
    table = params.get("table") or params.get("tableName")
    c = conn.cursor()

    if fmt == "CSV":
        if not table:
            raise ValueError("Table required for CSV export")
        c.execute(f"SELECT * FROM \"{table}\"")
        cols = [d[0] for d in c.description]
        lines = [",".join([f'"{col}"' for col in cols])]
        for r in c.fetchall():
            row_vals = []
            for val in r:
                if val is None:
                    row_vals.append("")
                else:
                    escaped = str(val).replace('"', '""')
                    row_vals.append(f'"{escaped}"')
            lines.append(",".join(row_vals))
        return {"data": "\n".join(lines)}

    # SQL Dump
    lines = [
        "-- SpaceApp Database Export",
        "-- Engine: SQLite",
        f"-- Timestamp: {time.strftime('%Y-%m-%d %H:%M:%S')}",
        ""
    ]
    if table:
        c.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (table,))
        schema_row = c.fetchone()
        if schema_row and schema_row[0]:
            lines.append(f"{schema_row[0]};")
            lines.append("")
        c.execute(f"SELECT * FROM \"{table}\"")
        cols = [d[0] for d in c.description]
        for r in c.fetchall():
            vals = []
            for v in r:
                if v is None:
                    vals.append("NULL")
                elif isinstance(v, (int, float)):
                    vals.append(str(v))
                else:
                    esc = str(v).replace("'", "''")
                    vals.append(f"'{esc}'")
            cols_str = ", ".join([f'"{col}"' for col in cols])
            lines.append(f"INSERT INTO \"{table}\" ({cols_str}) VALUES ({', '.join(vals)});")
    return {"data": "\n".join(lines)}

def handle_import(conn, params):
    fmt = (params.get("format") or "SQL").upper()
    content = params.get("content") or params.get("data") or ""
    table = params.get("table") or params.get("tableName")
    c = conn.cursor()

    if fmt == "SQL":
        c.executescript(content)
        conn.commit()
        return {"ok": True, "importedRows": 0, "message": "SQL executed successfully"}

    if fmt == "CSV":
        if not table:
            raise ValueError("Target table required for CSV import")
        lines = [l for l in content.splitlines() if l.strip()]
        if len(lines) < 2:
            return {"ok": True, "importedRows": 0}
        headers = [h.strip().strip('"\'') for h in lines[0].split(",")]
        cols_str = ", ".join([f'"{h}"' for h in headers])
        placeholders = ", ".join(["?"] * len(headers))
        sql = f"INSERT INTO \"{table}\" ({cols_str}) VALUES ({placeholders})"

        count = 0
        for line in lines[1:]:
            vals = [v.strip().strip('"\'') for v in line.split(",")]
            c.execute(sql, vals)
            count += 1
        conn.commit()
        return {"ok": True, "importedRows": count, "message": f"Imported {count} rows"}

    raise ValueError(f"Unknown format: {fmt}")

def main():
    try:
        raw_input = sys.stdin.read()
        if not raw_input.strip():
            sys.stderr.write("No JSON input provided on stdin\n")
            sys.exit(1)

        payload = json.loads(raw_input)
        action = payload.get("action")
        db_path = payload.get("dbPath")
        is_read_only = bool(payload.get("isReadOnly", False))
        params = payload.get("params", {})

        if not db_path:
            raise ValueError("dbPath is required")

        conn = create_connection(db_path, is_read_only)
        try:
            if action == "test":
                res = handle_test(conn)
            elif action == "catalog":
                res = handle_catalog(conn, db_path)
            elif action == "table_data":
                res = handle_table_data(conn, params)
            elif action == "mutate_row":
                res = handle_mutate_row(conn, params)
            elif action == "alter_table":
                res = handle_alter_table(conn, params)
            elif action == "execute_sql":
                res = handle_execute_sql(conn, params)
            elif action == "export":
                res = handle_export(conn, params)
            elif action == "import":
                res = handle_import(conn, params)
            else:
                raise ValueError(f"Unsupported action: {action}")

            sys.stdout.write(json.dumps(res))
            sys.stdout.flush()
        finally:
            conn.close()

    except Exception as err:
        err_res = {"ok": False, "error": str(err)}
        sys.stderr.write(json.dumps(err_res) + "\n")
        sys.exit(1)

if __name__ == "__main__":
    main()
