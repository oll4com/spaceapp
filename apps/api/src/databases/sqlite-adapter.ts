import { spawn } from "../safe-child-process.js";
import type { ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  DatabaseCatalog,
  DatabaseTableDataResponse
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT = path.join(__dirname, "sqlite-worker.py");

export interface SqliteConnectionConfig {
  filename?: string | null;
  isReadOnly?: boolean;
}

export class SqliteAdapter implements DatabaseAdapter {
  public readonly engine = "SQLITE" as const;
  public readonly capabilities: DatabaseCapabilities = {
    schemas: false,
    alterColumn: false,
    dropColumn: true,
    foreignKeys: true,
    indexes: true,
    views: true,
    triggers: true,
    functions: false,
    cancelQuery: true,
    explain: true
  };

  private filename: string;
  private isReadOnly: boolean;
  private activeProcesses = new Map<string, ChildProcess>();

  constructor(config: SqliteConnectionConfig) {
    if (!config.filename) {
      throw new Error("Filename is required for SQLite connection.");
    }
    this.filename = config.filename;
    this.isReadOnly = Boolean(config.isReadOnly);
  }

  private async runWorker<T>(action: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const child = spawn("python3", [WORKER_SCRIPT], {
        stdio: ["pipe", "pipe", "pipe"]
      });

      if (sessionId) {
        this.activeProcesses.set(sessionId, child);
      }

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      child.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      child.on("close", (code) => {
        if (sessionId) {
          this.activeProcesses.delete(sessionId);
        }
        if (code !== 0) {
          try {
            const errObj = JSON.parse(stderr);
            reject(new Error(errObj.error || `SQLite worker exited with code ${code}`));
          } catch {
            reject(new Error(stderr || `SQLite worker exited with code ${code}`));
          }
          return;
        }

        try {
          const parsed = JSON.parse(stdout);
          resolve(parsed as T);
        } catch (e) {
          reject(new Error(`Failed to parse worker output: ${stdout}`));
        }
      });

      child.on("error", (err) => {
        if (sessionId) {
          this.activeProcesses.delete(sessionId);
        }
        reject(err);
      });

      const payload = {
        action,
        dbPath: this.filename,
        isReadOnly: this.isReadOnly,
        params
      };

      child.stdin.write(JSON.stringify(payload));
      child.stdin.end();
    });
  }

  async testConnection(): Promise<{ ok: boolean; version?: string; error?: string }> {
    try {
      const res = await this.runWorker<{ ok: boolean; version?: string }>("test");
      return res;
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async getCatalog(): Promise<DatabaseCatalog> {
    return await this.runWorker<DatabaseCatalog>("catalog");
  }

  async getTableData(tableName: string, options: TableDataQueryOptions): Promise<DatabaseTableDataResponse> {
    const res = await this.runWorker<DatabaseTableDataResponse>("table_data", {
      tableName,
      ...options
    });
    res.isReadOnly = this.isReadOnly;
    return res;
  }

  async mutateRow(
    tableName: string,
    options: TableRowMutationOptions
  ): Promise<{ ok: boolean; affectedRows: number; newRow?: Record<string, unknown> }> {
    if (this.isReadOnly) {
      throw new Error("Cannot modify rows in a read-only database connection.");
    }
    return await this.runWorker<{ ok: boolean; affectedRows: number; newRow?: Record<string, unknown> }>("mutate_row", {
      tableName,
      ...options
    });
  }

  async alterTable(tableName: string, options: TableAlterationOptions): Promise<{ ok: boolean; message?: string }> {
    if (this.isReadOnly) {
      throw new Error("Cannot alter schema in a read-only database connection.");
    }
    return await this.runWorker<{ ok: boolean; message?: string }>("alter_table", {
      tableName,
      ...options
    });
  }

  async executeSql(options: SqlExecutionOptions): Promise<SqlExecutionResult> {
    const sessionId = options.sessionId || `sqlite_session_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    return await this.runWorker<SqlExecutionResult>(
      "execute_sql",
      {
        ...options,
        sessionId
      },
      sessionId
    );
  }

  async cancelSql(sessionId: string): Promise<{ ok: boolean }> {
    const child = this.activeProcesses.get(sessionId);
    if (!child) return { ok: false };
    child.kill("SIGTERM");
    return { ok: true };
  }

  async exportData(options: ExportDataOptions): Promise<string> {
    const res = await this.runWorker<{ data: string }>("export", options as unknown as Record<string, unknown>);
    return res.data;
  }

  async importData(options: ImportDataOptions): Promise<{ ok: boolean; importedRows: number; message?: string }> {
    if (this.isReadOnly) {
      throw new Error("Cannot import data into a read-only database connection.");
    }
    return await this.runWorker<{ ok: boolean; importedRows: number; message?: string }>("import", options as unknown as Record<string, unknown>);
  }

  async close(): Promise<void> {
    for (const child of this.activeProcesses.values()) {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
    }
    this.activeProcesses.clear();
  }
}
