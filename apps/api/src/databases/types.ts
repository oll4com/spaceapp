import type {
  DatabaseCatalog,
  DatabaseColumnMeta,
  DatabaseEngine,
  DatabaseTableDataResponse,
  DatabaseTableMeta
} from "@space/contracts";

export interface DatabaseCapabilities {
  schemas: boolean;
  alterColumn: boolean;
  dropColumn: boolean;
  foreignKeys: boolean;
  indexes: boolean;
  views: boolean;
  triggers: boolean;
  functions: boolean;
  cancelQuery: boolean;
  explain: boolean;
}

export interface TableDataQueryOptions {
  schema?: string;
  page: number;
  pageSize: number;
  sortColumn?: string;
  sortDirection?: "asc" | "desc";
  search?: string;
  filterColumn?: string;
  filterValue?: string;
  filterOp?: "eq" | "neq" | "like" | "gt" | "lt" | "gte" | "lte" | "null" | "notnull";
}

export interface TableRowMutationOptions {
  action: "INSERT" | "UPDATE" | "DELETE";
  schema?: string;
  keys?: Record<string, unknown>;
  values?: Record<string, unknown>;
}

export interface TableAlterationOptions {
  action: "CREATE_TABLE" | "DROP_TABLE" | "ADD_COLUMN" | "DROP_COLUMN" | "ADD_INDEX" | "DROP_INDEX";
  schema?: string;
  tableName?: string;
  column?: {
    name: string;
    type: string;
    nullable?: boolean;
    defaultValue?: string;
    isPrimaryKey?: boolean;
  };
  columnName?: string;
  index?: {
    name: string;
    columns: string[];
    unique?: boolean;
  };
  indexName?: string;
  columns?: Array<{
    name: string;
    type: string;
    nullable?: boolean;
    defaultValue?: string;
    isPrimaryKey?: boolean;
  }>;
}

export interface SqlExecutionOptions {
  database?: string;
  schema?: string;
  sql: string;
  limit?: number;
  sessionId?: string;
}

export interface SqlExecutionResult {
  sessionId: string;
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  executionTimeMs: number;
  affectedRows?: number;
  command?: string;
}

export interface ExportDataOptions {
  format: "SQL" | "CSV";
  table?: string;
  schema?: string;
  includeStructure?: boolean;
  includeData?: boolean;
}

export interface ImportDataOptions {
  format: "SQL" | "CSV";
  table?: string;
  schema?: string;
  content: string;
}

export interface DatabaseAdapter {
  engine: DatabaseEngine;
  capabilities: DatabaseCapabilities;
  testConnection(): Promise<{ ok: boolean; version?: string; error?: string }>;
  getCatalog(databaseName?: string): Promise<DatabaseCatalog>;
  getTableData(tableName: string, options: TableDataQueryOptions): Promise<DatabaseTableDataResponse>;
  mutateRow(tableName: string, options: TableRowMutationOptions): Promise<{ ok: boolean; affectedRows: number; newRow?: Record<string, unknown> }>;
  alterTable(tableName: string, options: TableAlterationOptions): Promise<{ ok: boolean; message?: string }>;
  executeSql(options: SqlExecutionOptions): Promise<SqlExecutionResult>;
  cancelSql?(sessionId: string): Promise<{ ok: boolean }>;
  exportData(options: ExportDataOptions): Promise<string>;
  importData(options: ImportDataOptions): Promise<{ ok: boolean; importedRows: number; message?: string }>;
  close(): Promise<void>;
}
