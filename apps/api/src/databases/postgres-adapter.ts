import pg from "pg";
import type {
  DatabaseCatalog,
  DatabaseColumnMeta,
  DatabaseForeignKeyMeta,
  DatabaseIndexMeta,
  DatabaseTableDataResponse,
  DatabaseTableMeta
} from "@space/contracts";
import type {
  DatabaseAdapter,
  DatabaseCapabilities,
  ExportDataOptions,
  ImportDataOptions,
  SqlExecutionOptions,
  SqlExecutionResult,
  TableAlterationOptions,
  TableDataQueryOptions,
  TableRowMutationOptions
} from "./types.js";

const { Pool } = pg;

// Parse BigInt as string to avoid precision loss
pg.types.setTypeParser(20, (val: string) => val);

function escapeIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function escapeLiteral(literal: unknown): string {
  if (literal === null || literal === undefined) return "NULL";
  if (typeof literal === "number" || typeof literal === "boolean") return String(literal);
  if (typeof literal === "object") return `'${JSON.stringify(literal).replace(/'/g, "''")}'`;
  return `'${String(literal).replace(/'/g, "''")}'`;
}

export interface PostgresConnectionConfig {
  host?: string | null;
  port?: number | null;
  database?: string | null;
  username?: string | null;
  password?: string | null;
  ssl?: boolean;
  isReadOnly?: boolean;
  connectionString?: string | null;
}

export class PostgresAdapter implements DatabaseAdapter {
  public readonly engine = "POSTGRES" as const;
  public readonly capabilities: DatabaseCapabilities = {
    schemas: true,
    alterColumn: true,
    dropColumn: true,
    foreignKeys: true,
    indexes: true,
    views: true,
    triggers: true,
    functions: true,
    cancelQuery: true,
    explain: true
  };

  private pool: pg.Pool;
  private isReadOnly: boolean;
  private activeQueries = new Map<string, { client: pg.PoolClient; pid: number }>();

  constructor(config: PostgresConnectionConfig) {
    this.isReadOnly = Boolean(config.isReadOnly);

    if (config.connectionString) {
      this.pool = new Pool({
        connectionString: config.connectionString,
        max: 5,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
        ssl: config.ssl ? { rejectUnauthorized: false } : undefined
      });
    } else {
      this.pool = new Pool({
        host: config.host || "127.0.0.1",
        port: config.port || 5432,
        database: config.database || "postgres",
        user: config.username || "postgres",
        password: config.password || undefined,
        ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
        max: 5,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000
      });
    }

    this.pool.on("error", (err: Error) => {
      console.error("[PostgresAdapter] Unexpected error on idle client:", err);
    });
  }

  async testConnection(): Promise<{ ok: boolean; version?: string; error?: string }> {
    try {
      const res = await this.pool.query("SELECT version() as ver");
      return { ok: true, version: res.rows[0]?.ver };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async getCatalog(databaseName?: string): Promise<DatabaseCatalog> {
    const currentDbRes = await this.pool.query("SELECT current_database() as db");
    const currentDatabase = currentDbRes.rows[0]?.db || "postgres";

    // Query databases
    let databases: string[] = [currentDatabase];
    try {
      const dbsRes = await this.pool.query("SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname");
      databases = dbsRes.rows.map((r: { datname: string }) => r.datname);
    } catch {
      // Ignore if user cannot list all databases
    }

    // Query schemas
    const schemasRes = await this.pool.query(`
      SELECT schema_name 
      FROM information_schema.schemata 
      WHERE schema_name NOT IN ('information_schema', 'pg_catalog', 'pg_toast')
        AND schema_name NOT LIKE 'pg_temp_%'
        AND schema_name NOT LIKE 'pg_toast%'
      ORDER BY schema_name
    `);
    const schemaNames: string[] = schemasRes.rows.map((r: { schema_name: string }) => r.schema_name);
    if (!schemaNames.includes("public")) {
      schemaNames.unshift("public");
    }

    // Query table row counts
    const rowCountsMap = new Map<string, number>();
    try {
      const countsRes = await this.pool.query(`
        SELECT 
          s.schemaname AS schema_name,
          s.relname AS table_name,
          GREATEST(COALESCE(s.n_live_tup, 0), COALESCE(c.reltuples::bigint, 0)) AS row_count
        FROM pg_stat_user_tables s
        JOIN pg_class c ON c.oid = s.relid
        WHERE s.schemaname NOT IN ('information_schema', 'pg_catalog', 'pg_toast')
          AND s.schemaname NOT LIKE 'pg_temp_%'
          AND s.schemaname NOT LIKE 'pg_toast%'
      `);
      for (const r of countsRes.rows) {
        rowCountsMap.set(`${r.schema_name}.${r.table_name}`, Math.max(0, Number(r.row_count) || 0));
      }
    } catch {
      // Ignore if pg_stat_user_tables not accessible
    }

    // Query tables and views
    const tablesRes = await this.pool.query(`
      SELECT 
        table_schema, 
        table_name, 
        table_type
      FROM information_schema.tables 
      WHERE table_schema NOT IN ('information_schema', 'pg_catalog', 'pg_toast')
        AND table_schema NOT LIKE 'pg_temp_%'
        AND table_schema NOT LIKE 'pg_toast%'
      ORDER BY table_schema, table_name
    `);

    // For tables where pg_stat reported 0 or missing (e.g. unanalyzed tables),
    // perform a fast direct count query so low-traffic or unanalyzed tables
    // are never falsely reported with 0 rows.
    const unverifiedTables = tablesRes.rows
      .filter(
        (t: { table_schema: string; table_name: string; table_type: string }) =>
          t.table_type !== "VIEW" &&
          (!rowCountsMap.has(`${t.table_schema}.${t.table_name}`) ||
            rowCountsMap.get(`${t.table_schema}.${t.table_name}`) === 0)
      )
      .slice(0, 200);

    if (unverifiedTables.length > 0) {
      const CHUNK_SIZE = 15;
      for (let i = 0; i < unverifiedTables.length; i += CHUNK_SIZE) {
        const chunk = unverifiedTables.slice(i, i + CHUNK_SIZE);
        await Promise.allSettled(
          chunk.map(async (t: { table_schema: string; table_name: string }) => {
            try {
              const fullIdent = `${escapeIdentifier(t.table_schema)}.${escapeIdentifier(t.table_name)}`;
              const cntRes = await this.pool.query(`SELECT count(1)::int AS cnt FROM ${fullIdent}`);
              const count = Number(cntRes.rows[0]?.cnt) || 0;
              rowCountsMap.set(`${t.table_schema}.${t.table_name}`, count);
            } catch {
              // Ignore if table cannot be counted
            }
          })
        );
      }
    }

    // Query columns
    const columnsRes = await this.pool.query(`
      SELECT 
        table_schema,
        table_name,
        column_name,
        data_type,
        udt_name,
        is_nullable,
        column_default,
        character_maximum_length
      FROM information_schema.columns
      WHERE table_schema NOT IN ('information_schema', 'pg_catalog', 'pg_toast')
        AND table_schema NOT LIKE 'pg_temp_%'
        AND table_schema NOT LIKE 'pg_toast%'
      ORDER BY table_schema, table_name, ordinal_position
    `);

    // Query primary keys
    const pkRes = await this.pool.query(`
      SELECT 
        kcu.table_schema,
        kcu.table_name,
        kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      WHERE tc.constraint_type = 'PRIMARY KEY'
    `);

    // Query foreign keys
    const fkRes = await this.pool.query(`
      SELECT
        tc.constraint_name,
        tc.table_schema,
        tc.table_name,
        kcu.column_name,
        ccu.table_schema AS foreign_table_schema,
        ccu.table_name AS foreign_table_name,
        ccu.column_name AS foreign_column_name,
        rc.update_rule,
        rc.delete_rule
      FROM information_schema.table_constraints AS tc
      JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage AS ccu
        ON ccu.constraint_name = tc.constraint_name
        AND ccu.table_schema = tc.table_schema
      JOIN information_schema.referential_constraints AS rc
        ON rc.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY'
    `);

    // Query indexes
    const indexRes = await this.pool.query(`
      SELECT
        schemaname AS schema_name,
        tablename AS table_name,
        indexname AS index_name,
        indexdef
      FROM pg_indexes
      WHERE schemaname NOT IN ('information_schema', 'pg_catalog')
    `);

    // Grouping by schema and table
    const columnsMap = new Map<string, DatabaseColumnMeta[]>();
    for (const col of columnsRes.rows) {
      const key = `${col.table_schema}.${col.table_name}`;
      if (!columnsMap.has(key)) columnsMap.set(key, []);
      const isPk = pkRes.rows.some(
        (pk: { table_schema: string; table_name: string; column_name: string }) =>
          pk.table_schema === col.table_schema && pk.table_name === col.table_name && pk.column_name === col.column_name
      );
      columnsMap.get(key)!.push({
        name: col.column_name,
        type: col.character_maximum_length ? `${col.udt_name}(${col.character_maximum_length})` : col.udt_name,
        dataType: col.data_type,
        nullable: col.is_nullable === "YES",
        defaultValue: col.column_default,
        isPrimaryKey: isPk,
        isAutoIncrement: typeof col.column_default === "string" && col.column_default.includes("nextval"),
        maxLength: col.character_maximum_length
      });
    }

    const schemas = schemaNames.map((sName: string) => {
      const tables: DatabaseTableMeta[] = [];
      const views: Array<{ name: string; schema?: string; definition?: string }> = [];

      for (const t of tablesRes.rows) {
        if (t.table_schema !== sName) continue;
        const key = `${t.table_schema}.${t.table_name}`;
        if (t.table_type === "VIEW") {
          views.push({ name: t.table_name, schema: sName });
        } else {
          const pks = pkRes.rows
            .filter((pk: { table_schema: string; table_name: string }) => pk.table_schema === sName && pk.table_name === t.table_name)
            .map((pk: { column_name: string }) => pk.column_name);

          const fks: DatabaseForeignKeyMeta[] = fkRes.rows
            .filter((fk: { table_schema: string; table_name: string }) => fk.table_schema === sName && fk.table_name === t.table_name)
            .map((fk: Record<string, string>) => ({
              name: fk.constraint_name || "",
              column: fk.column_name || "",
              referencedTable: fk.foreign_table_name || "",
              referencedSchema: fk.foreign_table_schema,
              referencedColumn: fk.foreign_column_name || "",
              onUpdate: fk.update_rule,
              onDelete: fk.delete_rule
            }));

          const idxs: DatabaseIndexMeta[] = indexRes.rows
            .filter((idx: { schema_name: string; table_name: string }) => idx.schema_name === sName && idx.table_name === t.table_name)
            .map((idx: { index_name: string; indexdef: string }) => ({
              name: idx.index_name,
              columns: [], // defined in indexdef
              unique: idx.indexdef.toLowerCase().includes("unique index")
            }));

          tables.push({
            name: t.table_name,
            schema: sName,
            columns: columnsMap.get(key) || [],
            primaryKeys: pks,
            foreignKeys: fks,
            indexes: idxs,
            rowCount: rowCountsMap.get(key) ?? 0
          });
        }
      }

      return {
        name: sName,
        tables,
        views
      };
    });

    return {
      engine: this.engine,
      databases,
      currentDatabase,
      capabilities: this.capabilities,
      schemas
    };
  }

  async getTableData(tableName: string, options: TableDataQueryOptions): Promise<DatabaseTableDataResponse> {
    const schema = options.schema || "public";
    const fullTableName = `${escapeIdentifier(schema)}.${escapeIdentifier(tableName)}`;

    // 1. Get column metadata
    const colRes = await this.pool.query(
      `SELECT column_name, data_type, udt_name, is_nullable, column_default, character_maximum_length
       FROM information_schema.columns 
       WHERE table_schema = $1 AND table_name = $2
       ORDER BY ordinal_position`,
      [schema, tableName]
    );

    const pkRes = await this.pool.query(
      `SELECT kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = $1 AND tc.table_name = $2`,
      [schema, tableName]
    );
    const primaryKeys: string[] = pkRes.rows.map((r: { column_name: string }) => r.column_name);

    const columns: DatabaseColumnMeta[] = colRes.rows.map((r: Record<string, unknown>) => ({
      name: String(r.column_name),
      type: r.character_maximum_length ? `${String(r.udt_name)}(${r.character_maximum_length})` : String(r.udt_name),
      dataType: String(r.data_type),
      nullable: r.is_nullable === "YES",
      defaultValue: r.column_default !== null ? String(r.column_default) : null,
      isPrimaryKey: primaryKeys.includes(String(r.column_name)),
      isAutoIncrement: typeof r.column_default === "string" && r.column_default.includes("nextval"),
      maxLength: typeof r.character_maximum_length === "number" ? r.character_maximum_length : null
    }));

    // 2. Build filter and search clause
    const conditions: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (options.filterColumn && options.filterOp) {
      const colIdent = escapeIdentifier(options.filterColumn);
      switch (options.filterOp) {
        case "eq":
          conditions.push(`${colIdent} = $${paramIndex++}`);
          values.push(options.filterValue);
          break;
        case "neq":
          conditions.push(`${colIdent} != $${paramIndex++}`);
          values.push(options.filterValue);
          break;
        case "like":
          conditions.push(`${colIdent}::text ILIKE $${paramIndex++}`);
          values.push(`%${options.filterValue}%`);
          break;
        case "gt":
          conditions.push(`${colIdent} > $${paramIndex++}`);
          values.push(options.filterValue);
          break;
        case "lt":
          conditions.push(`${colIdent} < $${paramIndex++}`);
          values.push(options.filterValue);
          break;
        case "gte":
          conditions.push(`${colIdent} >= $${paramIndex++}`);
          values.push(options.filterValue);
          break;
        case "lte":
          conditions.push(`${colIdent} <= $${paramIndex++}`);
          values.push(options.filterValue);
          break;
        case "null":
          conditions.push(`${colIdent} IS NULL`);
          break;
        case "notnull":
          conditions.push(`${colIdent} IS NOT NULL`);
          break;
      }
    }

    if (options.search && options.search.trim()) {
      const searchVal = `%${options.search.trim()}%`;
      const searchConditions = columns
        .filter((c) => ["text", "varchar", "character varying", "char"].includes(c.dataType.toLowerCase()))
        .map((c) => `${escapeIdentifier(c.name)} ILIKE $${paramIndex}`);
      if (searchConditions.length > 0) {
        conditions.push(`(${searchConditions.join(" OR ")})`);
        values.push(searchVal);
        paramIndex++;
      }
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // 3. Count total rows
    const countSql = `SELECT count(*)::int as total FROM ${fullTableName} ${whereClause}`;
    const countRes = await this.pool.query(countSql, values);
    const totalRows = countRes.rows[0]?.total ?? 0;

    // 4. Order and pagination
    let orderClause = "";
    if (options.sortColumn) {
      const validCol = columns.find((c) => c.name === options.sortColumn);
      if (validCol) {
        const dir = options.sortDirection === "desc" ? "DESC" : "ASC";
        orderClause = `ORDER BY ${escapeIdentifier(validCol.name)} ${dir}`;
      }
    } else if (primaryKeys.length > 0) {
      orderClause = `ORDER BY ${primaryKeys.map(escapeIdentifier).join(", ")} ASC`;
    }

    const page = Math.max(1, options.page);
    const pageSize = Math.min(500, Math.max(1, options.pageSize));
    const offset = (page - 1) * pageSize;

    const dataSql = `SELECT * FROM ${fullTableName} ${whereClause} ${orderClause} LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    const dataValues = [...values, pageSize, offset];

    const dataRes = await this.pool.query(dataSql, dataValues);

    return {
      columns,
      rows: dataRes.rows,
      totalRows,
      page,
      pageSize,
      primaryKeys,
      isReadOnly: this.isReadOnly
    };
  }

  async mutateRow(
    tableName: string,
    options: TableRowMutationOptions
  ): Promise<{ ok: boolean; affectedRows: number; newRow?: Record<string, unknown> }> {
    if (this.isReadOnly) {
      throw new Error("Cannot modify rows in a read-only database connection.");
    }
    const schema = options.schema || "public";
    const fullTableName = `${escapeIdentifier(schema)}.${escapeIdentifier(tableName)}`;

    if (options.action === "INSERT") {
      const valuesObj = options.values || {};
      const keys = Object.keys(valuesObj);
      if (keys.length === 0) {
        const res = await this.pool.query(`INSERT INTO ${fullTableName} DEFAULT VALUES RETURNING *`);
        return { ok: true, affectedRows: res.rowCount ?? 1, newRow: res.rows[0] };
      }
      const cols = keys.map(escapeIdentifier).join(", ");
      const placeholders = keys.map((_, i) => `$${i + 1}`).join(", ");
      const sql = `INSERT INTO ${fullTableName} (${cols}) VALUES (${placeholders}) RETURNING *`;
      const res = await this.pool.query(sql, Object.values(valuesObj));
      return { ok: true, affectedRows: res.rowCount ?? 1, newRow: res.rows[0] };
    }

    if (options.action === "UPDATE") {
      const keysObj = options.keys || {};
      const valuesObj = options.values || {};
      const keyCols = Object.keys(keysObj);
      const updateCols = Object.keys(valuesObj);

      if (keyCols.length === 0) {
        throw new Error("Cannot update row without key criteria.");
      }
      if (updateCols.length === 0) {
        return { ok: true, affectedRows: 0 };
      }

      const params: unknown[] = [];
      let pIdx = 1;
      const setClauses = updateCols.map((c) => {
        params.push(valuesObj[c]);
        return `${escapeIdentifier(c)} = $${pIdx++}`;
      });
      const whereClauses = keyCols.map((c) => {
        params.push(keysObj[c]);
        return `${escapeIdentifier(c)} = $${pIdx++}`;
      });

      const sql = `UPDATE ${fullTableName} SET ${setClauses.join(", ")} WHERE ${whereClauses.join(" AND ")} RETURNING *`;
      const res = await this.pool.query(sql, params);
      return { ok: true, affectedRows: res.rowCount ?? 0, newRow: res.rows[0] };
    }

    if (options.action === "DELETE") {
      const keysObj = options.keys || {};
      const keyCols = Object.keys(keysObj);
      if (keyCols.length === 0) {
        throw new Error("Cannot delete row without key criteria.");
      }
      const params: unknown[] = [];
      let pIdx = 1;
      const whereClauses = keyCols.map((c) => {
        params.push(keysObj[c]);
        return `${escapeIdentifier(c)} = $${pIdx++}`;
      });
      const sql = `DELETE FROM ${fullTableName} WHERE ${whereClauses.join(" AND ")}`;
      const res = await this.pool.query(sql, params);
      return { ok: true, affectedRows: res.rowCount ?? 0 };
    }

    throw new Error(`Unsupported mutation action: ${String(options.action)}`);
  }

  async alterTable(tableName: string, options: TableAlterationOptions): Promise<{ ok: boolean; message?: string }> {
    if (this.isReadOnly) {
      throw new Error("Cannot alter schema in a read-only database connection.");
    }
    const schema = options.schema || "public";
    const fullTableName = `${escapeIdentifier(schema)}.${escapeIdentifier(tableName || options.tableName || "")}`;

    switch (options.action) {
      case "CREATE_TABLE": {
        const columns = options.columns || [];
        if (columns.length === 0) throw new Error("Columns definition is required to create a table.");
        const colDefs = columns.map((col) => {
          let def = `${escapeIdentifier(col.name)} ${col.type}`;
          if (col.isPrimaryKey) def += " PRIMARY KEY";
          if (col.nullable === false) def += " NOT NULL";
          if (col.defaultValue) def += ` DEFAULT ${col.defaultValue}`;
          return def;
        });
        await this.pool.query(`CREATE TABLE ${fullTableName} (${colDefs.join(", ")})`);
        return { ok: true, message: `Table ${tableName} created successfully.` };
      }
      case "DROP_TABLE": {
        await this.pool.query(`DROP TABLE IF EXISTS ${fullTableName} CASCADE`);
        return { ok: true, message: `Table ${tableName} dropped.` };
      }
      case "ADD_COLUMN": {
        if (!options.column?.name || !options.column?.type) throw new Error("Column name and type are required.");
        let def = `${escapeIdentifier(options.column.name)} ${options.column.type}`;
        if (options.column.nullable === false) def += " NOT NULL";
        if (options.column.defaultValue) def += ` DEFAULT ${options.column.defaultValue}`;
        await this.pool.query(`ALTER TABLE ${fullTableName} ADD COLUMN ${def}`);
        return { ok: true, message: `Column ${options.column.name} added.` };
      }
      case "DROP_COLUMN": {
        if (!options.columnName) throw new Error("Column name is required to drop column.");
        await this.pool.query(`ALTER TABLE ${fullTableName} DROP COLUMN IF EXISTS ${escapeIdentifier(options.columnName)} CASCADE`);
        return { ok: true, message: `Column ${options.columnName} dropped.` };
      }
      case "ADD_INDEX": {
        if (!options.index?.name || !options.index?.columns || options.index.columns.length === 0) {
          throw new Error("Index name and columns are required.");
        }
        const unique = options.index.unique ? "UNIQUE" : "";
        const indexName = escapeIdentifier(options.index.name);
        const cols = options.index.columns.map(escapeIdentifier).join(", ");
        await this.pool.query(`CREATE ${unique} INDEX ${indexName} ON ${fullTableName} (${cols})`);
        return { ok: true, message: `Index ${options.index.name} created.` };
      }
      case "DROP_INDEX": {
        if (!options.indexName) throw new Error("Index name is required to drop index.");
        await this.pool.query(`DROP INDEX IF EXISTS ${escapeIdentifier(schema)}.${escapeIdentifier(options.indexName)}`);
        return { ok: true, message: `Index ${options.indexName} dropped.` };
      }
      default:
        throw new Error(`Unsupported alteration action: ${String(options.action)}`);
    }
  }

  async executeSql(options: SqlExecutionOptions): Promise<SqlExecutionResult> {
    const sessionId = options.sessionId || `session_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const startTime = Date.now();
    const client = await this.pool.connect();

    try {
      // Get backend PID for cancellation
      const pidRes = await client.query("SELECT pg_backend_pid() as pid");
      const pid = pidRes.rows[0]?.pid;
      if (pid) {
        this.activeQueries.set(sessionId, { client, pid });
      }

      // If read-only connection, enforce transaction read only
      if (this.isReadOnly) {
        await client.query("SET TRANSACTION READ ONLY");
      }

      // Set statement timeout (30 seconds)
      await client.query("SET statement_timeout = 30000");

      if (options.schema) {
        await client.query(`SET search_path TO ${escapeIdentifier(options.schema)}, public`);
      }

      const res = await client.query(options.sql);
      const executionTimeMs = Date.now() - startTime;

      // Handle multi-statement results or single result
      const resultObj = Array.isArray(res) ? res[res.length - 1] : res;
      const columns = resultObj?.fields ? resultObj.fields.map((f: { name: string }) => f.name) : [];
      let rows = resultObj?.rows || [];

      // Limit returned rows if needed
      if (options.limit && rows.length > options.limit) {
        rows = rows.slice(0, options.limit);
      }

      return {
        sessionId,
        columns,
        rows,
        rowCount: rows.length,
        executionTimeMs,
        affectedRows: resultObj?.rowCount ?? undefined,
        command: resultObj?.command
      };
    } finally {
      this.activeQueries.delete(sessionId);
      client.release();
    }
  }

  async cancelSql(sessionId: string): Promise<{ ok: boolean }> {
    const entry = this.activeQueries.get(sessionId);
    if (!entry) return { ok: false };
    try {
      await this.pool.query("SELECT pg_cancel_backend($1)", [entry.pid]);
      return { ok: true };
    } catch (err) {
      console.error("[PostgresAdapter] Error cancelling query:", err);
      return { ok: false };
    }
  }

  async exportData(options: ExportDataOptions): Promise<string> {
    const schema = options.schema || "public";
    if (options.format === "CSV") {
      if (!options.table) throw new Error("Table is required for CSV export.");
      const fullTableName = `${escapeIdentifier(schema)}.${escapeIdentifier(options.table)}`;
      const res = await this.pool.query(`SELECT * FROM ${fullTableName}`);
      if (res.rows.length === 0 || !res.rows[0]) return "";
      const columns = Object.keys(res.rows[0]);
      const csvRows = [
        columns.map((c) => `"${c.replace(/"/g, '""')}"`).join(","),
        ...res.rows.map((row: Record<string, unknown>) =>
          columns
            .map((c) => {
              const val = row[c];
              if (val === null || val === undefined) return "";
              if (typeof val === "object") return `"${JSON.stringify(val).replace(/"/g, '""')}"`;
              return `"${String(val).replace(/"/g, '""')}"`;
            })
            .join(",")
        )
      ];
      return csvRows.join("\n");
    }

    // SQL format export
    const lines: string[] = [`-- SpaceApp Database Export`, `-- Engine: PostgreSQL`, `-- Timestamp: ${new Date().toISOString()}`, ""];
    if (options.table) {
      const fullTableName = `${escapeIdentifier(schema)}.${escapeIdentifier(options.table)}`;
      if (options.includeStructure !== false) {
        const colRes = await this.pool.query(
          `SELECT column_name, udt_name, character_maximum_length, is_nullable, column_default
           FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
          [schema, options.table]
        );
        const colDefs = colRes.rows.map((r: Record<string, unknown>) => {
          let def = `${escapeIdentifier(String(r.column_name))} ${r.character_maximum_length ? `${String(r.udt_name)}(${r.character_maximum_length})` : String(r.udt_name)}`;
          if (r.is_nullable === "NO") def += " NOT NULL";
          if (r.column_default) def += ` DEFAULT ${r.column_default}`;
          return def;
        });
        lines.push(`CREATE TABLE IF NOT EXISTS ${fullTableName} (\n  ${colDefs.join(",\n  ")}\n);`, "");
      }
      if (options.includeData !== false) {
        const dataRes = await this.pool.query(`SELECT * FROM ${fullTableName}`);
        for (const row of dataRes.rows) {
          const cols = Object.keys(row).map(escapeIdentifier).join(", ");
          const vals = Object.values(row).map(escapeLiteral).join(", ");
          lines.push(`INSERT INTO ${fullTableName} (${cols}) VALUES (${vals});`);
        }
      }
    }
    return lines.join("\n");
  }

  async importData(options: ImportDataOptions): Promise<{ ok: boolean; importedRows: number; message?: string }> {
    if (this.isReadOnly) {
      throw new Error("Cannot import data into a read-only database connection.");
    }
    const schema = options.schema || "public";

    if (options.format === "SQL") {
      await this.pool.query(options.content);
      return { ok: true, importedRows: 0, message: "SQL executed successfully." };
    }

    if (options.format === "CSV") {
      if (!options.table) throw new Error("Target table is required for CSV import.");
      const fullTableName = `${escapeIdentifier(schema)}.${escapeIdentifier(options.table)}`;
      const lines = options.content.split(/\r?\n/).filter((l) => l.trim().length > 0);
      if (lines.length < 2) return { ok: true, importedRows: 0 };

      // Simple CSV parsing for comma separated rows
      const headerLine = lines[0];
      if (!headerLine) return { ok: true, importedRows: 0 };
      const headers = headerLine.split(",").map((h) => h.replace(/^["']|["']$/g, "").trim());
      const cols = headers.map(escapeIdentifier).join(", ");

      let imported = 0;
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        const rawVals = line.split(",").map((v) => v.replace(/^["']|["']$/g, "").trim());
        const placeholders = rawVals.map((_, idx) => `$${idx + 1}`).join(", ");
        await this.pool.query(`INSERT INTO ${fullTableName} (${cols}) VALUES (${placeholders})`, rawVals);
        imported++;
      }
      return { ok: true, importedRows: imported, message: `Imported ${imported} rows.` };
    }

    throw new Error(`Unsupported import format: ${String(options.format)}`);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
