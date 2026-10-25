import mysql, { type Pool, type PoolConnection } from "mysql2/promise";
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

function escapeIdentifier(identifier: string): string {
  return `\`${identifier.replace(/`/g, "``")}\``;
}

function escapeLiteral(literal: unknown): string {
  if (literal === null || literal === undefined) return "NULL";
  if (typeof literal === "number" || typeof literal === "boolean") return String(literal);
  if (typeof literal === "object") return `'${JSON.stringify(literal).replace(/'/g, "\\'")}'`;
  return `'${String(literal).replace(/'/g, "\\'")}'`;
}

export interface MySqlConnectionConfig {
  host?: string | null;
  port?: number | null;
  database?: string | null;
  username?: string | null;
  password?: string | null;
  ssl?: boolean;
  isReadOnly?: boolean;
}

export class MySqlAdapter implements DatabaseAdapter {
  public readonly engine = "MYSQL" as const;
  public readonly capabilities: DatabaseCapabilities = {
    schemas: false, // MySQL treats schemas as databases
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

  private pool: Pool;
  private isReadOnly: boolean;
  private defaultDatabase: string;
  private activeQueries = new Map<string, { threadId: number }>();

  constructor(config: MySqlConnectionConfig) {
    this.isReadOnly = Boolean(config.isReadOnly);
    this.defaultDatabase = config.database || "mysql";

    this.pool = mysql.createPool({
      host: config.host || "127.0.0.1",
      port: config.port || 3306,
      database: this.defaultDatabase,
      user: config.username || "root",
      password: config.password || undefined,
      ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
      waitForConnections: true,
      connectionLimit: 5,
      maxIdle: 5,
      idleTimeout: 30000,
      queueLimit: 0,
      supportBigNumbers: true,
      bigNumberStrings: true,
      multipleStatements: true
    });
  }

  async testConnection(): Promise<{ ok: boolean; version?: string; error?: string }> {
    try {
      const [rows] = await this.pool.query("SELECT VERSION() as ver");
      const ver = (rows as Array<{ ver: string }>)[0]?.ver;
      return { ok: true, version: ver };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async getCatalog(databaseName?: string): Promise<DatabaseCatalog> {
    const targetDb = databaseName || this.defaultDatabase;

    // List databases
    let databases: string[] = [targetDb];
    try {
      const [dbRows] = await this.pool.query("SHOW DATABASES");
      databases = (dbRows as Array<Record<string, string>>)
        .map((r) => Object.values(r)[0])
        .filter((v): v is string => typeof v === "string");
    } catch {
      // Ignore if no permission
    }

    // List tables and views
    const [tableRows] = await this.pool.query(
      `SELECT TABLE_NAME, TABLE_TYPE, TABLE_ROWS, DATA_LENGTH, TABLE_COMMENT 
       FROM information_schema.TABLES 
       WHERE TABLE_SCHEMA = ?
       ORDER BY TABLE_NAME`,
      [targetDb]
    );

    // List columns
    const [columnRows] = await this.pool.query(
      `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, EXTRA, CHARACTER_MAXIMUM_LENGTH, COLUMN_COMMENT
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ?
       ORDER BY TABLE_NAME, ORDINAL_POSITION`,
      [targetDb]
    );

    // List foreign keys
    const [fkRows] = await this.pool.query(
      `SELECT CONSTRAINT_NAME, TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
       FROM information_schema.KEY_COLUMN_USAGE
       WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL`,
      [targetDb]
    );

    // List indexes
    const [idxRows] = await this.pool.query(
      `SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, COLUMN_NAME, INDEX_TYPE
       FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = ?
       ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
      [targetDb]
    );

    // Group columns by table
    const columnsMap = new Map<string, DatabaseColumnMeta[]>();
    for (const c of columnRows as Array<Record<string, unknown>>) {
      const tName = String(c.TABLE_NAME);
      if (!columnsMap.has(tName)) columnsMap.set(tName, []);
      columnsMap.get(tName)!.push({
        name: String(c.COLUMN_NAME),
        type: String(c.COLUMN_TYPE),
        dataType: String(c.DATA_TYPE),
        nullable: c.IS_NULLABLE === "YES",
        defaultValue: c.COLUMN_DEFAULT !== null ? String(c.COLUMN_DEFAULT) : null,
        isPrimaryKey: c.COLUMN_KEY === "PRI",
        isAutoIncrement: typeof c.EXTRA === "string" && c.EXTRA.toLowerCase().includes("auto_increment"),
        maxLength: typeof c.CHARACTER_MAXIMUM_LENGTH === "number" ? c.CHARACTER_MAXIMUM_LENGTH : null,
        comment: c.COLUMN_COMMENT ? String(c.COLUMN_COMMENT) : null
      });
    }

    const tables: DatabaseTableMeta[] = [];
    const views: Array<{ name: string; schema?: string }> = [];

    for (const t of tableRows as Array<Record<string, unknown>>) {
      const tName = String(t.TABLE_NAME);
      const isView = t.TABLE_TYPE === "VIEW";
      if (isView) {
        views.push({ name: tName, schema: targetDb });
        continue;
      }

      const pks: string[] = [];
      const cols = columnsMap.get(tName) || [];
      for (const col of cols) {
        if (col.isPrimaryKey) pks.push(col.name);
      }

      const fks: DatabaseForeignKeyMeta[] = (fkRows as Array<Record<string, unknown>>)
        .filter((fk) => fk.TABLE_NAME === tName)
        .map((fk) => ({
          name: String(fk.CONSTRAINT_NAME),
          column: String(fk.COLUMN_NAME),
          referencedTable: String(fk.REFERENCED_TABLE_NAME),
          referencedColumn: String(fk.REFERENCED_COLUMN_NAME)
        }));

      const idxMap = new Map<string, { name: string; columns: string[]; unique: boolean; type?: string }>();
      for (const idx of idxRows as Array<Record<string, unknown>>) {
        if (idx.TABLE_NAME !== tName) continue;
        const iName = String(idx.INDEX_NAME);
        if (!idxMap.has(iName)) {
          idxMap.set(iName, {
            name: iName,
            columns: [],
            unique: Number(idx.NON_UNIQUE) === 0,
            type: String(idx.INDEX_TYPE)
          });
        }
        idxMap.get(iName)!.columns.push(String(idx.COLUMN_NAME));
      }

      tables.push({
        name: tName,
        schema: targetDb,
        rowCount: typeof t.TABLE_ROWS === "number" ? t.TABLE_ROWS : undefined,
        sizeBytes: typeof t.DATA_LENGTH === "number" ? t.DATA_LENGTH : undefined,
        comment: t.TABLE_COMMENT ? String(t.TABLE_COMMENT) : null,
        columns: cols,
        primaryKeys: pks,
        foreignKeys: fks,
        indexes: Array.from(idxMap.values())
      });
    }

    return {
      engine: this.engine,
      databases,
      currentDatabase: targetDb,
      capabilities: this.capabilities,
      schemas: [
        {
          name: targetDb,
          tables,
          views
        }
      ]
    };
  }

  async getTableData(tableName: string, options: TableDataQueryOptions): Promise<DatabaseTableDataResponse> {
    const fullTableName = escapeIdentifier(tableName);

    // 1. Columns
    const [columnRows] = await this.pool.query(
      `SELECT COLUMN_NAME, COLUMN_TYPE, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, EXTRA, CHARACTER_MAXIMUM_LENGTH
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
       ORDER BY ORDINAL_POSITION`,
      [this.defaultDatabase, tableName]
    );

    const primaryKeys: string[] = [];
    const columns: DatabaseColumnMeta[] = (columnRows as Array<Record<string, unknown>>).map((r) => {
      const isPk = r.COLUMN_KEY === "PRI";
      if (isPk) primaryKeys.push(String(r.COLUMN_NAME));
      return {
        name: String(r.COLUMN_NAME),
        type: String(r.COLUMN_TYPE),
        dataType: String(r.DATA_TYPE),
        nullable: r.IS_NULLABLE === "YES",
        defaultValue: r.COLUMN_DEFAULT !== null ? String(r.COLUMN_DEFAULT) : null,
        isPrimaryKey: isPk,
        isAutoIncrement: typeof r.EXTRA === "string" && r.EXTRA.toLowerCase().includes("auto_increment"),
        maxLength: typeof r.CHARACTER_MAXIMUM_LENGTH === "number" ? r.CHARACTER_MAXIMUM_LENGTH : null
      };
    });

    // 2. Filters
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (options.filterColumn && options.filterOp) {
      const colIdent = escapeIdentifier(options.filterColumn);
      switch (options.filterOp) {
        case "eq":
          conditions.push(`${colIdent} = ?`);
          values.push(options.filterValue);
          break;
        case "neq":
          conditions.push(`${colIdent} != ?`);
          values.push(options.filterValue);
          break;
        case "like":
          conditions.push(`${colIdent} LIKE ?`);
          values.push(`%${options.filterValue}%`);
          break;
        case "gt":
          conditions.push(`${colIdent} > ?`);
          values.push(options.filterValue);
          break;
        case "lt":
          conditions.push(`${colIdent} < ?`);
          values.push(options.filterValue);
          break;
        case "gte":
          conditions.push(`${colIdent} >= ?`);
          values.push(options.filterValue);
          break;
        case "lte":
          conditions.push(`${colIdent} <= ?`);
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
        .filter((c) => ["varchar", "text", "char", "mediumtext", "longtext"].includes(c.dataType.toLowerCase()))
        .map((c) => `${escapeIdentifier(c.name)} LIKE ?`);
      if (searchConditions.length > 0) {
        conditions.push(`(${searchConditions.join(" OR ")})`);
        for (let i = 0; i < searchConditions.length; i++) values.push(searchVal);
      }
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // 3. Count
    const countSql = `SELECT count(*) as total FROM ${fullTableName} ${whereClause}`;
    const [countRows] = await this.pool.query(countSql, values);
    const totalRows = Number((countRows as Array<{ total: number }>)[0]?.total ?? 0);

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

    const dataSql = `SELECT * FROM ${fullTableName} ${whereClause} ${orderClause} LIMIT ? OFFSET ?`;
    const [dataRows] = await this.pool.query(dataSql, [...values, pageSize, offset]);

    return {
      columns,
      rows: (dataRows as Array<Record<string, unknown>>) || [],
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
    const fullTableName = escapeIdentifier(tableName);

    if (options.action === "INSERT") {
      const valuesObj = options.values || {};
      const keys = Object.keys(valuesObj);
      if (keys.length === 0) {
        const [res] = await this.pool.query(`INSERT INTO ${fullTableName} () VALUES ()`);
        return { ok: true, affectedRows: (res as { affectedRows?: number })?.affectedRows ?? 1 };
      }
      const cols = keys.map(escapeIdentifier).join(", ");
      const placeholders = keys.map(() => "?").join(", ");
      const sql = `INSERT INTO ${fullTableName} (${cols}) VALUES (${placeholders})`;
      const [res] = await this.pool.query(sql, Object.values(valuesObj));
      return { ok: true, affectedRows: (res as { affectedRows?: number })?.affectedRows ?? 1 };
    }

    if (options.action === "UPDATE") {
      const keysObj = options.keys || {};
      const valuesObj = options.values || {};
      const keyCols = Object.keys(keysObj);
      const updateCols = Object.keys(valuesObj);

      if (keyCols.length === 0) throw new Error("Cannot update row without key criteria.");
      if (updateCols.length === 0) return { ok: true, affectedRows: 0 };

      const params: unknown[] = [];
      const setClauses = updateCols.map((c) => {
        params.push(valuesObj[c]);
        return `${escapeIdentifier(c)} = ?`;
      });
      const whereClauses = keyCols.map((c) => {
        params.push(keysObj[c]);
        return `${escapeIdentifier(c)} = ?`;
      });

      const sql = `UPDATE ${fullTableName} SET ${setClauses.join(", ")} WHERE ${whereClauses.join(" AND ")}`;
      const [res] = await this.pool.query(sql, params);
      return { ok: true, affectedRows: (res as { affectedRows?: number })?.affectedRows ?? 0 };
    }

    if (options.action === "DELETE") {
      const keysObj = options.keys || {};
      const keyCols = Object.keys(keysObj);
      if (keyCols.length === 0) throw new Error("Cannot delete row without key criteria.");

      const params: unknown[] = [];
      const whereClauses = keyCols.map((c) => {
        params.push(keysObj[c]);
        return `${escapeIdentifier(c)} = ?`;
      });
      const sql = `DELETE FROM ${fullTableName} WHERE ${whereClauses.join(" AND ")}`;
      const [res] = await this.pool.query(sql, params);
      return { ok: true, affectedRows: (res as { affectedRows?: number })?.affectedRows ?? 0 };
    }

    throw new Error(`Unsupported mutation action: ${String(options.action)}`);
  }

  async alterTable(tableName: string, options: TableAlterationOptions): Promise<{ ok: boolean; message?: string }> {
    if (this.isReadOnly) {
      throw new Error("Cannot alter schema in a read-only database connection.");
    }
    const fullTableName = escapeIdentifier(tableName || options.tableName || "");

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
        await this.pool.query(`DROP TABLE IF EXISTS ${fullTableName}`);
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
        await this.pool.query(`ALTER TABLE ${fullTableName} DROP COLUMN ${escapeIdentifier(options.columnName)}`);
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
        await this.pool.query(`DROP INDEX ${escapeIdentifier(options.indexName)} ON ${fullTableName}`);
        return { ok: true, message: `Index ${options.indexName} dropped.` };
      }
      default:
        throw new Error(`Unsupported alteration action: ${String(options.action)}`);
    }
  }

  async executeSql(options: SqlExecutionOptions): Promise<SqlExecutionResult> {
    const sessionId = options.sessionId || `mysql_session_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const startTime = Date.now();
    const conn: PoolConnection = await this.pool.getConnection();

    try {
      if (conn.threadId) {
        this.activeQueries.set(sessionId, { threadId: conn.threadId });
      }

      if (options.database) {
        await conn.query(`USE ${escapeIdentifier(options.database)}`);
      }

      const [res, fields] = await conn.query(options.sql);
      const executionTimeMs = Date.now() - startTime;

      let rows: Record<string, unknown>[] = [];
      let columns: string[] = [];
      let affectedRows: number | undefined;

      if (Array.isArray(res)) {
        // If multiple statements, take last result set
        const lastResult = Array.isArray(res[0]) ? res[res.length - 1] : res;
        if (Array.isArray(lastResult)) {
          rows = lastResult as Record<string, unknown>[];
          const firstRow = rows[0];
          if (rows.length > 0 && firstRow) columns = Object.keys(firstRow);
        }
      } else if (res && typeof res === "object") {
        affectedRows = (res as { affectedRows?: number })?.affectedRows;
      }

      if (fields && Array.isArray(fields) && columns.length === 0) {
        columns = (fields as Array<{ name: string }>).map((f) => f.name);
      }

      if (options.limit && rows.length > options.limit) {
        rows = rows.slice(0, options.limit);
      }

      return {
        sessionId,
        columns,
        rows,
        rowCount: rows.length,
        executionTimeMs,
        affectedRows
      };
    } finally {
      this.activeQueries.delete(sessionId);
      conn.release();
    }
  }

  async cancelSql(sessionId: string): Promise<{ ok: boolean }> {
    const entry = this.activeQueries.get(sessionId);
    if (!entry) return { ok: false };
    try {
      await this.pool.query(`KILL QUERY ${entry.threadId}`);
      return { ok: true };
    } catch (err) {
      console.error("[MySqlAdapter] Error killing query:", err);
      return { ok: false };
    }
  }

  async exportData(options: ExportDataOptions): Promise<string> {
    if (options.format === "CSV") {
      if (!options.table) throw new Error("Table is required for CSV export.");
      const [rows] = await this.pool.query(`SELECT * FROM ${escapeIdentifier(options.table)}`);
      const rowList = rows as Array<Record<string, unknown>>;
      if (rowList.length === 0 || !rowList[0]) return "";
      const columns = Object.keys(rowList[0]);
      const csvRows = [
        columns.map((c) => `"${c.replace(/"/g, '""')}"`).join(","),
        ...rowList.map((row) =>
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

    const lines: string[] = [`-- SpaceApp Database Export`, `-- Engine: MySQL`, `-- Timestamp: ${new Date().toISOString()}`, ""];
    if (options.table) {
      const fullTableName = escapeIdentifier(options.table);
      if (options.includeStructure !== false) {
        const [showRes] = await this.pool.query(`SHOW CREATE TABLE ${fullTableName}`);
        const createSql = (showRes as Array<Record<string, string>>)[0]?.["Create Table"];
        if (createSql) lines.push(`${createSql};`, "");
      }
      if (options.includeData !== false) {
        const [dataRows] = await this.pool.query(`SELECT * FROM ${fullTableName}`);
        for (const row of dataRows as Array<Record<string, unknown>>) {
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
    if (options.format === "SQL") {
      await this.pool.query(options.content);
      return { ok: true, importedRows: 0, message: "SQL executed successfully." };
    }

    if (options.format === "CSV") {
      if (!options.table) throw new Error("Target table is required for CSV import.");
      const fullTableName = escapeIdentifier(options.table);
      const lines = options.content.split(/\r?\n/).filter((l) => l.trim().length > 0);
      if (lines.length < 2) return { ok: true, importedRows: 0 };

      const headerLine = lines[0];
      if (!headerLine) return { ok: true, importedRows: 0 };
      const headers = headerLine.split(",").map((h) => h.replace(/^["']|["']$/g, "").trim());
      const cols = headers.map(escapeIdentifier).join(", ");

      let imported = 0;
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        const rawVals = line.split(",").map((v) => v.replace(/^["']|["']$/g, "").trim());
        const placeholders = rawVals.map(() => "?").join(", ");
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
