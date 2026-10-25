import pg from "pg";
import { nanoid } from "nanoid";
import { createSpacePgPool } from "@space/db";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type {
  CreateDatabaseConnectionInput,
  DatabaseConnection,
  DatabaseDiscoveryItem,
  UpdateDatabaseConnectionInput
} from "@space/contracts";
import { encryptSecret, decryptSecret } from "./crypto.js";
import { closeAdapterForConnection, getAdapterForConnection } from "./adapter-factory.js";
import type { DatabaseAdapter } from "./types.js";


let internalPool: pg.Pool | null = null;

function resolveDatabaseUrl(): string {
  const url = process.env.SPACE_DATABASE_URL || process.env.DATABASE_URL || "postgres://space:space@127.0.0.1:54329/space";
  return url;
}

export function getInternalDbPool(): pg.Pool {
  if (internalPool) return internalPool;
  const originalUrl = resolveDatabaseUrl();
  // If in a network namespace where 54329 is not exposed directly on loopback, allow fallback
  const connectionString = originalUrl;
  internalPool = createSpacePgPool(connectionString, { max: 10 });

  internalPool.on("error", (err) => {
    console.error("[DatabasesService] Internal PG pool error:", err);
  });

  return internalPool;
}

export interface UserContext {
  id: string;
  role?: string;
  email?: string;
}

export class DatabasesService {
  private get pool(): pg.Pool {
    return getInternalDbPool();
  }

  private isUserAdmin(user?: UserContext | null): boolean {
    const role = user?.role?.toUpperCase();
    return role === "ADMIN" || role === "OPERATOR";
  }

  private getInternalConnection(mode?: "user" | "admin"): DatabaseConnection {
    const dbUrl = resolveDatabaseUrl();
    let host = "127.0.0.1";
    let port = 5432;
    let database = "space";
    let username = "space";

    try {
      const parsed = new URL(dbUrl);
      host = parsed.hostname || host;
      port = parsed.port ? Number(parsed.port) : port;
      database = parsed.pathname ? parsed.pathname.replace(/^\//, "") : database;
      username = parsed.username || username;
    } catch {
      // ignore
    }

    return {
      id: "spaceapp-internal",
      ownerUserId: "system",
      projectPath: null,
      name: "SpaceApp Internal (PostgreSQL)",
      engine: "POSTGRES",
      host,
      port,
      database,
      username,
      ssl: false,
      filename: null,
      isInternal: true,
      isReadOnly: mode !== "admin",
      options: {},
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date().toISOString()
    };
  }

  async listConnections(
    user?: UserContext | null,
    projectPath?: string | null,
    mode?: "user" | "admin"
  ): Promise<DatabaseConnection[]> {
    const isAdmin = this.isUserAdmin(user) || mode === "admin";
    const connections: DatabaseConnection[] = [];

    // Always include internal DB if admin or in admin mode
    if (isAdmin) {
      connections.push(this.getInternalConnection(mode));
    }

    let query: string;
    let params: unknown[];

    if (isAdmin) {
      if (projectPath) {
        query = `SELECT * FROM database_connections WHERE project_path = $1 OR project_path IS NULL ORDER BY name ASC`;
        params = [projectPath];
      } else {
        query = `SELECT * FROM database_connections ORDER BY name ASC`;
        params = [];
      }
    } else {
      const userId = user?.id || "anonymous";
      if (projectPath) {
        query = `SELECT * FROM database_connections WHERE owner_user_id = $1 AND (project_path = $2 OR project_path IS NULL) ORDER BY name ASC`;
        params = [userId, projectPath];
      } else {
        query = `SELECT * FROM database_connections WHERE owner_user_id = $1 ORDER BY name ASC`;
        params = [userId];
      }
    }

    try {
      const res = await this.pool.query(query, params);
      for (const row of res.rows) {
        connections.push({
          id: row.id,
          ownerUserId: row.owner_user_id,
          projectPath: row.project_path,
          name: row.name,
          engine: row.engine,
          host: row.host,
          port: row.port,
          database: row.database,
          username: row.username,
          ssl: row.ssl,
          filename: row.filename,
          isInternal: row.is_internal,
          isReadOnly: row.is_read_only,
          options: row.options || {},
          createdAt: row.created_at.toISOString(),
          updatedAt: row.updated_at.toISOString()
        });
      }
    } catch (err) {
      console.error("[DatabasesService] Failed to list connections:", err);
    }

    return connections;
  }

  async getConnection(id: string, user?: UserContext | null, mode?: "user" | "admin"): Promise<DatabaseConnection> {
    if (id === "spaceapp-internal") {
      const isAdmin = this.isUserAdmin(user) || mode === "admin";
      if (!isAdmin) {
        throw new Error("Admin privileges required to access internal database.");
      }
      return this.getInternalConnection(mode);
    }

    const res = await this.pool.query("SELECT * FROM database_connections WHERE id = $1", [id]);
    if (res.rows.length === 0) {
      throw new Error(`Connection not found: ${id}`);
    }
    const row = res.rows[0];
    const isAdmin = this.isUserAdmin(user) || mode === "admin";
    if (!isAdmin && row.owner_user_id !== user?.id) {
      throw new Error("Access denied to this database connection.");
    }

    return {
      id: row.id,
      ownerUserId: row.owner_user_id,
      projectPath: row.project_path,
      name: row.name,
      engine: row.engine,
      host: row.host,
      port: row.port,
      database: row.database,
      username: row.username,
      ssl: row.ssl,
      filename: row.filename,
      isInternal: row.is_internal,
      isReadOnly: row.is_read_only,
      options: row.options || {},
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString()
    };
  }

  async createConnection(input: CreateDatabaseConnectionInput, user?: UserContext | null): Promise<DatabaseConnection> {
    const id = `conn_${nanoid(12)}`;
    const ownerUserId = user?.id || "anonymous";
    const encrypted = input.password ? encryptSecret(input.password) : null;

    const res = await this.pool.query(
      `INSERT INTO database_connections 
       (id, owner_user_id, project_path, name, engine, host, port, database, username, encrypted_credentials, ssl, filename, is_internal, is_read_only, options)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, false, false, $13)
       RETURNING *`,
      [
        id,
        ownerUserId,
        input.projectPath || null,
        input.name,
        input.engine,
        input.host || null,
        input.port || null,
        input.database || null,
        input.username || null,
        encrypted,
        Boolean(input.ssl),
        input.filename || null,
        input.options || {}
      ]
    );

    const row = res.rows[0];
    return {
      id: row.id,
      ownerUserId: row.owner_user_id,
      projectPath: row.project_path,
      name: row.name,
      engine: row.engine,
      host: row.host,
      port: row.port,
      database: row.database,
      username: row.username,
      ssl: row.ssl,
      filename: row.filename,
      isInternal: false,
      isReadOnly: false,
      options: row.options || {},
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString()
    };
  }

  async updateConnection(
    id: string,
    input: UpdateDatabaseConnectionInput,
    user?: UserContext | null,
    mode?: "user" | "admin"
  ): Promise<DatabaseConnection> {
    if (id === "spaceapp-internal") {
      throw new Error("Cannot modify internal SpaceApp database connection.");
    }

    const existing = await this.getConnection(id, user, mode);
    const updates: string[] = [];
    const values: unknown[] = [];
    let pIdx = 1;

    if (input.name !== undefined) {
      updates.push(`name = $${pIdx++}`);
      values.push(input.name);
    }
    if (input.engine !== undefined) {
      updates.push(`engine = $${pIdx++}`);
      values.push(input.engine);
    }
    if (input.host !== undefined) {
      updates.push(`host = $${pIdx++}`);
      values.push(input.host);
    }
    if (input.port !== undefined) {
      updates.push(`port = $${pIdx++}`);
      values.push(input.port);
    }
    if (input.database !== undefined) {
      updates.push(`database = $${pIdx++}`);
      values.push(input.database);
    }
    if (input.username !== undefined) {
      updates.push(`username = $${pIdx++}`);
      values.push(input.username);
    }
    if (input.password !== undefined) {
      updates.push(`encrypted_credentials = $${pIdx++}`);
      values.push(input.password ? encryptSecret(input.password) : null);
    }
    if (input.ssl !== undefined) {
      updates.push(`ssl = $${pIdx++}`);
      values.push(input.ssl);
    }
    if (input.filename !== undefined) {
      updates.push(`filename = $${pIdx++}`);
      values.push(input.filename);
    }
    if (input.projectPath !== undefined) {
      updates.push(`project_path = $${pIdx++}`);
      values.push(input.projectPath);
    }

    updates.push(`updated_at = now()`);

    if (updates.length > 0) {
      values.push(id);
      await this.pool.query(
        `UPDATE database_connections SET ${updates.join(", ")} WHERE id = $${pIdx}`,
        values
      );
    }

    await closeAdapterForConnection(id);
    return await this.getConnection(id, user, mode);
  }

  async deleteConnection(id: string, user?: UserContext | null, mode?: "user" | "admin"): Promise<{ ok: boolean }> {
    if (id === "spaceapp-internal") {
      throw new Error("Cannot delete internal SpaceApp database connection.");
    }

    await this.getConnection(id, user, mode); // Asserts permission
    await closeAdapterForConnection(id);
    await this.pool.query("DELETE FROM database_connections WHERE id = $1", [id]);
    return { ok: true };
  }

  async getAdapter(id: string, user?: UserContext | null, mode?: "user" | "admin"): Promise<DatabaseAdapter> {
    const conn = await this.getConnection(id, user, mode);

    let decryptedPassword = "";
    if (!conn.isInternal) {
      const res = await this.pool.query("SELECT encrypted_credentials FROM database_connections WHERE id = $1", [id]);
      const enc = res.rows[0]?.encrypted_credentials;
      if (enc) {
        decryptedPassword = decryptSecret(enc);
      }
    }

    const internalUrl = conn.isInternal ? resolveDatabaseUrl() : undefined;
    return getAdapterForConnection(conn, decryptedPassword, internalUrl);
  }

  async testNewConnection(input: CreateDatabaseConnectionInput): Promise<{ ok: boolean; version?: string; error?: string }> {
    const dummyConn: DatabaseConnection = {
      id: "test-probe",
      ownerUserId: "test",
      projectPath: input.projectPath,
      name: input.name,
      engine: input.engine,
      host: input.host || null,
      port: input.port || null,
      database: input.database || null,
      username: input.username || null,
      ssl: Boolean(input.ssl),
      filename: input.filename || null,
      isInternal: false,
      isReadOnly: false,
      options: input.options || {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const adapter = getAdapterForConnection(dummyConn, input.password);
    try {
      const result = await adapter.testConnection();
      return result;
    } finally {
      await closeAdapterForConnection(dummyConn.id);
    }
  }

  async discoverDatabases(projectPath: string): Promise<DatabaseDiscoveryItem[]> {
    const results: DatabaseDiscoveryItem[] = [];
    if (!projectPath || !projectPath.startsWith("/")) return results;

    try {
      // 1. Check .space/databases.json
      const spaceDbConfig = path.join(projectPath, ".space", "databases.json");
      try {
        const raw = await readFile(spaceDbConfig, "utf8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            results.push({
              engine: item.engine || "POSTGRES",
              name: item.name || "Configured Database",
              database: item.database,
              host: item.host,
              port: item.port,
              username: item.username,
              filename: item.filename,
              source: ".space/databases.json",
              confidence: "high"
            });
          }
        }
      } catch {
        // ignore
      }

      // 2. Check .env files (.env, .env.local, .env.development)
      const envFiles = [".env", ".env.local", ".env.development", ".env.production"];
      for (const envName of envFiles) {
        try {
          const envPath = path.join(projectPath, envName);
          const content = await readFile(envPath, "utf8");
          const lines = content.split("\n");

          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith("#") || !trimmed.includes("=")) continue;
            const parts = trimmed.split("=");
            const key = parts[0]?.trim();
            if (!key) continue;
            const val = parts.slice(1).join("=").replace(/^['"]|['"]$/g, "").trim();

            if (["DATABASE_URL", "POSTGRES_URL", "PG_URL", "MYSQL_URL"].includes(key.toUpperCase())) {
              try {
                const parsed = new URL(val);
                const isPg = parsed.protocol.startsWith("postgres");
                const isMysql = parsed.protocol.startsWith("mysql");
                if (isPg || isMysql) {
                  results.push({
                    engine: isPg ? "POSTGRES" : "MYSQL",
                    name: `${isPg ? "PostgreSQL" : "MySQL"} (${key})`,
                    database: parsed.pathname ? parsed.pathname.replace(/^\//, "") : undefined,
                    host: parsed.hostname,
                    port: parsed.port ? Number(parsed.port) : undefined,
                    username: parsed.username || undefined,
                    source: envName,
                    confidence: "high"
                  });
                }
              } catch {
                // not URL format
              }
            } else if (key.toUpperCase().includes("SQLITE") && (val.endsWith(".db") || val.endsWith(".sqlite"))) {
              results.push({
                engine: "SQLITE",
                name: `SQLite (${key})`,
                filename: path.isAbsolute(val) ? val : path.join(projectPath, val),
                source: envName,
                confidence: "high"
              });
            }
          }
        } catch {
          // ignore
        }
      }

      // 3. Check docker-compose.yml
      const composeFiles = ["docker-compose.yml", "compose.yml"];
      for (const composeName of composeFiles) {
        try {
          const composePath = path.join(projectPath, composeName);
          const content = await readFile(composePath, "utf8");
          if (content.includes("postgres") || content.includes("timescale")) {
            results.push({
              engine: "POSTGRES",
              name: `PostgreSQL (${composeName})`,
              host: "127.0.0.1",
              port: 5432,
              database: "postgres",
              username: "postgres",
              source: composeName,
              confidence: "medium"
            });
          }
          if (content.includes("mysql") || content.includes("mariadb")) {
            results.push({
              engine: "MYSQL",
              name: `MySQL/MariaDB (${composeName})`,
              host: "127.0.0.1",
              port: 3306,
              database: "mysql",
              username: "root",
              source: composeName,
              confidence: "medium"
            });
          }
        } catch {
          // ignore
        }
      }

      // 4. Check for SQLite files in project root & immediate subfolders
      const checkDirs = [projectPath, path.join(projectPath, "prisma"), path.join(projectPath, "data"), path.join(projectPath, "db")];
      for (const dir of checkDirs) {
        try {
          const files = await readdir(dir);
          for (const file of files) {
            if (file.endsWith(".sqlite") || file.endsWith(".sqlite3") || file.endsWith(".db")) {
              const fullPath = path.join(dir, file);
              const st = await stat(fullPath);
              if (st.isFile() && st.size > 0) {
                results.push({
                  engine: "SQLITE",
                  name: `SQLite (${file})`,
                  filename: fullPath,
                  source: path.relative(projectPath, fullPath) || file,
                  confidence: "high"
                });
              }
            }
          }
        } catch {
          // ignore
        }
      }
    } catch (err) {
      console.error("[DatabasesService] Discovery error:", err);
    }

    return results;
  }
}

export const databasesService = new DatabasesService();
