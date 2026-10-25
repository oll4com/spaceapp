import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  createDatabaseConnectionSchema,
  updateDatabaseConnectionSchema,
  databaseTableDataQuerySchema,
  databaseRowMutationSchema,
  databaseExecuteSqlRequestSchema
} from "@space/contracts";
import { databasesService } from "./databases-service.js";

function getRequestMode(request: FastifyRequest): "user" | "admin" {
  const query = request.query as Record<string, unknown>;
  const headers = request.headers as Record<string, unknown>;
  return (query?.mode === "admin" || headers?.["x-space-mode"] === "admin") ? "admin" : "user";
}

export function registerDatabasesRoutes(app: FastifyInstance) {
  // 1. List connections
  app.get("/api/databases/connections", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const query = request.query as { projectPath?: string; mode?: "user" | "admin" };
      const mode = query.mode || getRequestMode(request);
      const connections = await databasesService.listConnections(request.user, query.projectPath, mode);
      return reply.send({ ok: true, connections });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ ok: false, error: { message } });
    }
  });

  // 1b. Test connection parameters before saving
  app.post("/api/databases/connections/test", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = createDatabaseConnectionSchema.parse(request.body);
      const res = await databasesService.testNewConnection(body);
      return reply.send(res);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ ok: false, error: message });
    }
  });

  // 2. Create connection
  app.post("/api/databases/connections", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = createDatabaseConnectionSchema.parse(request.body);
      const connection = await databasesService.createConnection(body, request.user);
      return reply.status(201).send({ ok: true, connection });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ ok: false, error: { message } });
    }
  });

  // 3. Get single connection
  app.get("/api/databases/connections/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { id } = request.params as { id: string };
      const mode = getRequestMode(request);
      const connection = await databasesService.getConnection(id, request.user, mode);
      return reply.send({ ok: true, connection });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(404).send({ ok: false, error: { message } });
    }
  });

  // 4. Update connection
  app.put("/api/databases/connections/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { id } = request.params as { id: string };
      const mode = getRequestMode(request);
      const body = updateDatabaseConnectionSchema.parse(request.body);
      const connection = await databasesService.updateConnection(id, body, request.user, mode);
      return reply.send({ ok: true, connection });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ ok: false, error: { message } });
    }
  });

  // 5. Delete connection
  app.delete("/api/databases/connections/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { id } = request.params as { id: string };
      const mode = getRequestMode(request);
      await databasesService.deleteConnection(id, request.user, mode);
      return reply.send({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ ok: false, error: { message } });
    }
  });

  // 6. Discover project databases
  const handleDiscover = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { roomId } = request.params as { roomId: string };
      const query = request.query as { projectPath?: string };
      let projectPath = query.projectPath;

      if (!projectPath && roomId && (app as unknown as { store?: { getRoom?: (id: string) => Promise<{ projectPath?: string }> } }).store?.getRoom) {
        try {
          const room = await (app as unknown as { store: { getRoom: (id: string) => Promise<{ projectPath?: string }> } }).store.getRoom(roomId);
          projectPath = room?.projectPath;
        } catch {
          // ignore
        }
      }

      if (!projectPath) {
        return reply.send({ ok: true, discovered: [] });
      }

      const discovered = await databasesService.discoverDatabases(projectPath);
      return reply.send({ ok: true, discovered });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ ok: false, error: { message } });
    }
  };

  app.get("/api/rooms/:roomId/databases/discover", handleDiscover);
  app.post("/api/rooms/:roomId/databases/discover", handleDiscover);

  // 7. Get Catalog
  app.get("/api/databases/connections/:id/catalog", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { id } = request.params as { id: string };
      const query = request.query as { database?: string; mode?: "user" | "admin" };
      const mode = query.mode || getRequestMode(request);
      const adapter = await databasesService.getAdapter(id, request.user, mode);
      const catalog = await adapter.getCatalog(query.database);
      return reply.send({ ok: true, catalog });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ ok: false, error: { message } });
    }
  });

  // 8. Get Table Data
  app.get("/api/databases/connections/:id/tables/:tableName/data", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { id, tableName } = request.params as { id: string; tableName: string };
      const query = databaseTableDataQuerySchema.parse(request.query);
      const mode = getRequestMode(request);
      const adapter = await databasesService.getAdapter(id, request.user, mode);
      const data = await adapter.getTableData(tableName, query);
      return reply.send({ ok: true, ...data });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ ok: false, error: { message } });
    }
  });

  // 9. Mutate Row (INSERT)
  app.post("/api/databases/connections/:id/tables/:tableName/rows", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { id, tableName } = request.params as { id: string; tableName: string };
      const body = request.body as { schema?: string; values: Record<string, unknown> };
      const mode = getRequestMode(request);
      const adapter = await databasesService.getAdapter(id, request.user, mode);
      const result = await adapter.mutateRow(tableName, {
        action: "INSERT",
        schema: body.schema,
        values: body.values
      });
      return reply.send(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ ok: false, error: { message } });
    }
  });

  // 10. Mutate Row (UPDATE)
  app.put("/api/databases/connections/:id/tables/:tableName/rows", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { id, tableName } = request.params as { id: string; tableName: string };
      const body = request.body as { schema?: string; keys: Record<string, unknown>; values: Record<string, unknown> };
      const mode = getRequestMode(request);
      const adapter = await databasesService.getAdapter(id, request.user, mode);
      const result = await adapter.mutateRow(tableName, {
        action: "UPDATE",
        schema: body.schema,
        keys: body.keys,
        values: body.values
      });
      return reply.send(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ ok: false, error: { message } });
    }
  });

  // 11. Mutate Row (DELETE)
  app.delete("/api/databases/connections/:id/tables/:tableName/rows", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { id, tableName } = request.params as { id: string; tableName: string };
      const body = request.body as { schema?: string; keys: Record<string, unknown> };
      const mode = getRequestMode(request);
      const adapter = await databasesService.getAdapter(id, request.user, mode);
      const result = await adapter.mutateRow(tableName, {
        action: "DELETE",
        schema: body.schema,
        keys: body.keys
      });
      return reply.send(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ ok: false, error: { message } });
    }
  });

  // 12. Create Table
  app.post("/api/databases/connections/:id/tables", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { id } = request.params as { id: string };
      const body = request.body as {
        tableName: string;
        schema?: string;
        columns: Array<{ name: string; type: string; nullable?: boolean; defaultValue?: string; isPrimaryKey?: boolean }>;
      };
      const mode = getRequestMode(request);
      const adapter = await databasesService.getAdapter(id, request.user, mode);
      const result = await adapter.alterTable(body.tableName, {
        action: "CREATE_TABLE",
        schema: body.schema,
        tableName: body.tableName,
        columns: body.columns
      });
      return reply.send(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ ok: false, error: { message } });
    }
  });

  // 13. Alter Table Structure
  app.put("/api/databases/connections/:id/tables/:tableName/structure", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { id, tableName } = request.params as { id: string; tableName: string };
      const body = request.body as {
        action: "ADD_COLUMN" | "DROP_COLUMN" | "ADD_INDEX" | "DROP_INDEX";
        schema?: string;
        column?: { name: string; type: string; nullable?: boolean; defaultValue?: string };
        columnName?: string;
        index?: { name: string; columns: string[]; unique?: boolean };
        indexName?: string;
      };
      const mode = getRequestMode(request);
      const adapter = await databasesService.getAdapter(id, request.user, mode);
      const result = await adapter.alterTable(tableName, {
        action: body.action,
        schema: body.schema,
        tableName,
        column: body.column,
        columnName: body.columnName,
        index: body.index,
        indexName: body.indexName
      });
      return reply.send(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ ok: false, error: { message } });
    }
  });

  // 14. Drop Table
  app.delete("/api/databases/connections/:id/tables/:tableName", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { id, tableName } = request.params as { id: string; tableName: string };
      const query = request.query as { schema?: string };
      const mode = getRequestMode(request);
      const adapter = await databasesService.getAdapter(id, request.user, mode);
      const result = await adapter.alterTable(tableName, {
        action: "DROP_TABLE",
        schema: query.schema,
        tableName
      });
      return reply.send(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ ok: false, error: { message } });
    }
  });

  // 15. Execute SQL Session
  app.post("/api/databases/sessions/execute", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = databaseExecuteSqlRequestSchema.parse(request.body);
      const mode = getRequestMode(request);
      const adapter = await databasesService.getAdapter(body.connectionId, request.user, mode);
      const result = await adapter.executeSql({
        sql: body.sql,
        database: body.database,
        schema: body.schema,
        limit: body.limit
      });
      return reply.send({ ok: true, ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ ok: false, error: message });
    }
  });

  // 16. Cancel SQL Session
  app.post("/api/databases/sessions/:sessionId/cancel", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { sessionId } = request.params as { sessionId: string };
      const query = request.query as { connectionId?: string };
      if (!query.connectionId) {
        return reply.status(400).send({ ok: false, error: "connectionId query parameter is required." });
      }
      const mode = getRequestMode(request);
      const adapter = await databasesService.getAdapter(query.connectionId, request.user, mode);
      if (typeof adapter.cancelSql === "function") {
        const result = await adapter.cancelSql(sessionId);
        return reply.send(result);
      }
      return reply.send({ ok: false, message: "Cancellation not supported for this engine." });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ ok: false, error: { message } });
    }
  });

  // 17. Export Data
  app.post("/api/databases/connections/:id/transfers/export", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { id } = request.params as { id: string };
      const body = request.body as {
        format: "SQL" | "CSV";
        table?: string;
        schema?: string;
        includeStructure?: boolean;
        includeData?: boolean;
      };
      const mode = getRequestMode(request);
      const adapter = await databasesService.getAdapter(id, request.user, mode);
      const content = await adapter.exportData(body);
      const mime = body.format === "CSV" ? "text/csv" : "application/sql";
      const filename = `${body.table || "export"}_${Date.now()}.${body.format.toLowerCase()}`;
      return reply
        .header("Content-Type", `${mime}; charset=utf-8`)
        .header("Content-Disposition", `attachment; filename="${filename}"`)
        .send(content);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ ok: false, error: { message } });
    }
  });

  // 18. Import Data
  app.post("/api/databases/connections/:id/transfers/import", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { id } = request.params as { id: string };
      const body = request.body as {
        format: "SQL" | "CSV";
        table?: string;
        schema?: string;
        content: string;
      };
      const mode = getRequestMode(request);
      const adapter = await databasesService.getAdapter(id, request.user, mode);
      const result = await adapter.importData(body);
      return reply.send(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ ok: false, error: { message } });
    }
  });
}
