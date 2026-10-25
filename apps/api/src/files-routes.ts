import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import path from "node:path";
import {
  fileListQuerySchema,
  fileReadQuerySchema,
  fileWriteRequestSchema,
  fileCreateRequestSchema,
  fileRenameRequestSchema,
  fileChmodRequestSchema,
  fileDeleteRequestSchema,
  fileSearchQuerySchema,
  categorizeFailureCode
} from "@space/contracts";
import {
  listDirectory,
  readFileContent,
  writeFileContent,
  createEntry,
  renameEntry,
  chmodEntry,
  deleteEntry,
  searchFiles,
  assertAccessAllowed,
  detectMimeType,
  openFileForRead,
  FilesystemError,
  WORKSPACE_ROOT,
  configureFilesHostMode
} from "./files-service.js";
import type {} from "./request-context.js";
import type { SpaceStore } from "@space/runtime";
import { recordAudit } from "./request-audit.js";
import { applyFileResponsePolicy } from "./file-response-policy.js";
import { acquireFileUpload, stageFileUpload, fileUploadLimits, type StagedUpload } from "./file-upload.js";
import { initFilesCache, getDiskUsageAndCache } from "./files-cache.js";

function handleFileError(error: unknown, reply: FastifyReply) {
  const requestId = reply.request?.requestIdForSpace ?? reply.request?.id;
  if (error instanceof FilesystemError) {
    return reply.status(error.statusCode).send({
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        // Additive: bounded category and the request id that correlates logs.
        category: categorizeFailureCode(error.code),
        requestId
      }
    });
  }
  // Unexpected errors can carry host paths or file content in their message:
  // log them server-side under the request id and return a fixed message.
  reply.request?.log?.error({ err: error, requestId }, "filesystem request failed");
  return reply.status(500).send({
    ok: false,
    error: {
      code: "INTERNAL_ERROR",
      message: "Internal filesystem error.",
      category: "INTERNAL",
      requestId
    }
  });
}

export function registerFilesRoutes(app: FastifyInstance, options: {
  hostModeEnabled?: boolean;
  store?: Pick<SpaceStore, "upsertUser" | "recordAuditEvent">;
} = {}) {
  configureFilesHostMode(options.hostModeEnabled ?? true);
  // Every Admin Mode change is audited: it can reach any host path the API user can write.
  const auditAdminChange = async (request: FastifyRequest, mode: string | undefined, action: string, target: string) => {
    if (mode === "admin" && options.store) {
      await recordAudit(options.store, request, { action: `files.${action}`, targetType: "path", targetId: target });
    }
  };
  // Initialize background 24h disk & folder size cache
  initFilesCache();

  // 1. List directory entries
  app.get("/api/files/list", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const query = fileListQuerySchema.parse(request.query);
      const result = await listDirectory({
        targetPath: query.path,
        showHidden: query.showHidden === "true",
        mode: query.mode,
        user: request.user
      });
      return reply.send(result);
    } catch (error) {
      return handleFileError(error, reply);
    }
  });

  // 1b. Disk usage statistics and cache info (runs background 24h scan)
  app.get("/api/files/disk-usage", async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const data = await getDiskUsageAndCache();
      return reply.send({
        ok: true,
        disk: data.disk,
        lastUpdated: data.lastUpdated
      });
    } catch (error) {
      return handleFileError(error, reply);
    }
  });

  // 2. Read file content (metadata + text or binary flag)
  app.get("/api/files/read", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const query = fileReadQuerySchema.parse(request.query);
      const result = await readFileContent({
        targetPath: query.path,
        mode: query.mode,
        user: request.user
      });
      return reply.send(result);
    } catch (error) {
      return handleFileError(error, reply);
    }
  });

  // 3. Raw file stream (for direct image/video/audio preview and download)
  app.get("/api/files/raw", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const query = fileReadQuerySchema.parse(request.query);
      const handle = await openFileForRead({ targetPath: query.path, mode: query.mode, user: request.user });
      try {
        const stats = await handle.stat();
        applyFileResponsePolicy(reply, detectMimeType(query.path), path.basename(query.path), query.raw === "true");
        reply.header("content-length", stats.size);
        return reply.send(handle.createReadStream());
      } catch (error) {
        await handle.close();
        throw error;
      }
    } catch (error) {
      return handleFileError(error, reply);
    }
  });

  // 4. Write / Save file content
  app.put("/api/files/write", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = fileWriteRequestSchema.parse(request.body);
      const result = await writeFileContent({
        targetPath: body.path,
        content: body.content,
        mode: body.mode,
        user: request.user
      });
      await auditAdminChange(request, body.mode, "write", body.path);
      return reply.send(result);
    } catch (error) {
      return handleFileError(error, reply);
    }
  });

  // 5. Create new file or directory
  app.post("/api/files/create", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = fileCreateRequestSchema.parse(request.body);
      const result = await createEntry({
        targetPath: body.path,
        type: body.type,
        mode: body.mode,
        user: request.user
      });
      await auditAdminChange(request, body.mode, "create", body.path);
      return reply.send(result);
    } catch (error) {
      return handleFileError(error, reply);
    }
  });

  // 6. Rename / Move entry
  app.post("/api/files/rename", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = fileRenameRequestSchema.parse(request.body);
      const result = await renameEntry({
        oldPath: body.oldPath,
        newPath: body.newPath,
        mode: body.mode,
        user: request.user
      });
      await auditAdminChange(request, body.mode, "rename", `${body.oldPath} -> ${body.newPath}`);
      return reply.send(result);
    } catch (error) {
      return handleFileError(error, reply);
    }
  });

  // 7. Chmod permissions (admin only)
  app.post("/api/files/chmod", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = fileChmodRequestSchema.parse(request.body);
      const result = await chmodEntry({
        targetPath: body.path,
        octalPermissions: body.octalPermissions,
        mode: body.mode,
        user: request.user
      });
      await auditAdminChange(request, body.mode, "chmod", body.path);
      return reply.send(result);
    } catch (error) {
      return handleFileError(error, reply);
    }
  });

  // 8. Delete file or directory
  app.delete("/api/files/delete", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = fileDeleteRequestSchema.parse(request.body);
      const result = await deleteEntry({
        targetPath: body.path,
        recursive: body.recursive,
        mode: body.mode,
        user: request.user
      });
      await auditAdminChange(request, body.mode, body.recursive ? "delete-recursive" : "delete", result.path);
      return reply.send(result);
    } catch (error) {
      return handleFileError(error, reply);
    }
  });

  // 9. Fast search
  app.get("/api/files/search", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const query = fileSearchQuerySchema.parse(request.query);
      const result = await searchFiles({
        targetPath: query.path,
        query: query.query,
        limit: query.limit,
        mode: query.mode,
        user: request.user
      });
      return reply.send(result);
    } catch (error) {
      return handleFileError(error, reply);
    }
  });

  // 10. File upload (multipart)
  app.post("/api/files/upload", async (request: FastifyRequest, reply: FastifyReply) => {
    const staged: StagedUpload[] = [];
    let release: (() => void) | undefined;
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    request.raw.once("aborted", onAbort);
    try {
      if (!request.isMultipart()) {
        return reply.status(400).send({ ok: false, error: "Upload must be multipart/form-data" });
      }
      release = acquireFileUpload();
      let targetDir = WORKSPACE_ROOT;
      let mode: "user" | "admin" = "user";
      const budget = { bytes: 0 };
      for await (const part of request.parts()) {
        if (part.type === "field") {
          if (part.fieldname === "targetDir" && typeof part.value === "string") targetDir = part.value;
          if (part.fieldname === "mode" && (part.value === "user" || part.value === "admin")) mode = part.value;
          continue;
        }
        if (mode !== "admin") throw new FilesystemError("File upload strictly requires Admin Mode.", 403);
        if (staged.length >= fileUploadLimits.files) throw new FilesystemError("Too many files in one upload.", 413, "UPLOAD_LIMIT_EXCEEDED");
        const { resolvedPath: directory } = assertAccessAllowed(targetDir, mode, request.user, WORKSPACE_ROOT);
        staged.push(await stageFileUpload({ directory, filename: part.filename, source: part.file, budget, signal: abort.signal }));
      }
      // Validation and parsing failures never publish partial or truncated data. Files are then
      // published one by one, so a later failure says which ones were already saved.
      const saved: string[] = [];
      let failed: string | null = null;
      for (const file of staged) {
        try {
          await file.commit();
          saved.push(file.destination);
        } catch (error) {
          if (!saved.length) throw error;
          request.log.error({ err: error }, "file upload commit failed after earlier files were saved");
          failed = file.destination;
          break;
        }
      }
      if (saved.length) await auditAdminChange(request, mode, "upload", saved.join(", "));
      if (failed) {
        throw new FilesystemError(
          `${saved.length} of ${staged.length} files were saved (${saved.map((name) => path.basename(name)).join(", ")}); ${path.basename(failed)} and the files after it were not.`,
          500,
          "UPLOAD_PARTIALLY_SAVED"
        );
      }
      return reply.send({ ok: true, uploadedCount: staged.length, files: saved });
    } catch (error) {
      return handleFileError(error, reply);
    } finally {
      request.raw.off("aborted", onAbort);
      await Promise.allSettled(staged.map((file) => file.cleanup()));
      release?.();
    }
  });
}
