import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createReadStream } from "node:fs";
import { lstat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  fileListQuerySchema,
  fileReadQuerySchema,
  fileWriteRequestSchema,
  fileCreateRequestSchema,
  fileRenameRequestSchema,
  fileChmodRequestSchema,
  fileDeleteRequestSchema,
  fileSearchQuerySchema
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
  FilesystemError,
  WORKSPACE_ROOT
} from "./files-service.js";
import { initFilesCache, getDiskUsageAndCache } from "./files-cache.js";

function handleFileError(error: unknown, reply: FastifyReply) {
  if (error instanceof FilesystemError) {
    return reply.status(error.statusCode).send({
      ok: false,
      error: {
        code: "FILESYSTEM_ERROR",
        message: error.message
      }
    });
  }
  const message = error instanceof Error ? error.message : "Internal filesystem error";
  return reply.status(500).send({
    ok: false,
    error: {
      code: "INTERNAL_ERROR",
      message
    }
  });
}

export function registerFilesRoutes(app: FastifyInstance) {
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
      const { resolvedPath } = assertAccessAllowed(query.path, query.mode, request.user, WORKSPACE_ROOT);
      const stats = await lstat(resolvedPath);
      if (stats.isDirectory()) {
        return reply.status(400).send({ ok: false, error: "Cannot stream directory." });
      }

      const mimeType = detectMimeType(resolvedPath);
      const filename = path.basename(resolvedPath);

      reply.header("Content-Type", mimeType);
      reply.header("Content-Length", stats.size);
      if (query.raw === "true") {
        reply.header("Content-Disposition", `attachment; filename="${encodeURIComponent(filename)}"`);
      } else {
        reply.header("Content-Disposition", `inline; filename="${encodeURIComponent(filename)}"`);
      }

      const stream = createReadStream(resolvedPath);
      return reply.send(stream);
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
    try {
      if (!request.isMultipart()) {
        return reply.status(400).send({ ok: false, error: "Upload must be multipart/form-data" });
      }

      let targetDir = WORKSPACE_ROOT;
      let mode: "user" | "admin" = "user";
      const uploadedFiles: string[] = [];

      for await (const part of request.parts()) {
        if (part.type === "field") {
          if (part.fieldname === "targetDir" && typeof part.value === "string") {
            targetDir = part.value;
          }
          if (part.fieldname === "mode" && (part.value === "user" || part.value === "admin")) {
            mode = part.value;
          }
          continue;
        }

        if (part.type === "file") {
          if (mode !== "admin") {
            throw new FilesystemError("File upload strictly requires Admin Mode.", 403);
          }
          const { resolvedPath: dirPath } = assertAccessAllowed(targetDir, mode, request.user, WORKSPACE_ROOT);
          const safeFilename = path.basename(part.filename);
          const destination = path.join(dirPath, safeFilename);

          const chunks: Buffer[] = [];
          for await (const chunk of part.file) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          const buffer = Buffer.concat(chunks);
          await writeFile(destination, buffer);
          uploadedFiles.push(destination);
        }
      }

      return reply.send({
        ok: true,
        uploadedCount: uploadedFiles.length,
        files: uploadedFiles
      });
    } catch (error) {
      return handleFileError(error, reply);
    }
  });
}
