import { realpath } from "node:fs/promises";
import { relative, isAbsolute, join } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { gitOperationSchema, openProjectInputSchema, repositoryProviderIdSchema, repositoryTargetListInputSchema, setProjectDefaultRepoSchema, type GitOperation } from "@space/contracts";
import type { SpaceStore } from "@space/runtime";
import { WORKSPACE_ROOT } from "../files-service.js";
import { GitControlError } from "./errors.js";
import type { SourceControlService } from "./service.js";
import { ProjectSourceOpener } from "./project-sources.js";

export interface SourceControlRoutesOptions { service: SourceControlService; store: SpaceStore; rateLimitOptions: Record<string, unknown>; authenticatedOwner: (request: FastifyRequest) => Promise<string> }
export function registerSourceControlRoutes(app: FastifyInstance, options: SourceControlRoutesOptions) {
  const { service, rateLimitOptions } = options;
  const owner = async (request: FastifyRequest) => {
    if (!request.user) throw new GitControlError("UNAUTHENTICATED", "Sign in to use Source Control.", 401);
    return options.authenticatedOwner(request);
  };
  const authorizeRoot = async (request: FastifyRequest, path: string) => {
    const root = await realpath(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") throw new GitControlError("PATH_NOT_FOUND", "Folder was not found on the Space host.", 404);
      if (error.code === "EACCES" || error.code === "EPERM") throw new GitControlError("PROJECT_FORBIDDEN", "Space cannot access this folder.", 403);
      throw error;
    });
    if (request.user?.role === "ADMIN" || request.user?.role === "OPERATOR") return root;
    const workspace = await realpath(WORKSPACE_ROOT); const offset = relative(workspace, root);
    if (offset.startsWith("..") || isAbsolute(offset)) throw new GitControlError("PROJECT_FORBIDDEN", "Project is outside your workspace.", 403);
    return root;
  };
  const handler = (action: (request: FastifyRequest) => Promise<unknown>) => async (request: FastifyRequest, reply: import("fastify").FastifyReply) => {
    try { return await action(request); } catch (error) {
      if (error instanceof GitControlError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
      if (error instanceof z.ZodError) return reply.code(400).send({ error: { code: "INVALID_INPUT", message: "Source Control request is invalid." } });
      request.log.error({ err: error }, "Source Control could not complete this request.");
      return reply.code(500).send({ error: { code: "SOURCE_CONTROL_FAILED", message: "Source Control could not complete this request." } });
    }
  };
  app.get("/api/source-control/providers", rateLimitOptions, handler(async request => service.providers(await owner(request))));
  app.get("/api/source-control/connections", rateLimitOptions, handler(async request => service.connections(await owner(request))));
  app.get("/api/source-control/targets", rateLimitOptions, handler(async request => service.targets(await owner(request), repositoryTargetListInputSchema.parse(request.query))));
  app.get("/api/source-control/repositories", rateLimitOptions, handler(async request => {
    const query = z.object({ provider: repositoryProviderIdSchema, page: z.coerce.number().int().min(1).max(1000).optional(), cursor: z.string().min(1).max(4096).optional(), query: z.string().trim().max(300).optional(), targetId: z.string().min(1).max(1024).optional() }).strict()
      .refine(value => value.page === undefined || value.cursor === undefined, "Choose page or cursor.").parse(request.query);
    const ownerId = await owner(request);
    if ((query.provider === "github" || query.provider === "gitea") && query.cursor === undefined && query.query === undefined && query.targetId === undefined) {
      const page = query.page ?? 1, data = await service.repositories(ownerId, query.provider, page);
      return { data, nextPage: data.length === 50 ? page + 1 : null };
    }
    return service.listRepositories(ownerId, query);
  }));
  app.get("/api/source-control/bindings", rateLimitOptions, handler(async request => service.bindings(await owner(request))));
  app.post("/api/source-control/bindings", rateLimitOptions, handler(async request => {
    const local = z.object({ projectPath: z.string().min(1).max(4096), kind: z.literal("local") }).strict().safeParse(request.body);
    if (local.success) {
      const ownerId = await owner(request); const root = await authorizeRoot(request, local.data.projectPath);
      return service.bindLocal(ownerId, root);
    }
    const body = z.object({ projectPath: z.string().min(1).max(4096), provider: repositoryProviderIdSchema, repositoryId: z.string().min(1).max(1024).optional(), repositoryFullName: z.string().min(1).max(300).optional() }).strict().refine(value => !(value.repositoryId && value.repositoryFullName) && (!value.repositoryFullName || value.provider === "github" || value.provider === "gitea"), "Use a stable repository ID.").parse(request.body);
    const ownerId = await owner(request); const root = await authorizeRoot(request, body.projectPath);
    if (body.repositoryFullName && (body.provider === "github" || body.provider === "gitea")) return service.bind(ownerId, root, body.provider, body.repositoryFullName);
    return service.bindRepository(ownerId, root, body.provider, body.repositoryId);
  }));
  // Users without ADMIN/OPERATOR may only create or clone projects here, never elsewhere in the install tree.
  const opener = new ProjectSourceOpener(service, process.env.SPACE_USER_PROJECTS_ROOT || join(WORKSPACE_ROOT, "projects"));
  app.post("/api/projects/open", rateLimitOptions, handler(async request => {
    const input = openProjectInputSchema.parse(request.body); const ownerId = await owner(request);
    const restricted = request.user?.role !== "ADMIN" && request.user?.role !== "OPERATOR";
    return opener.open(ownerId, input, { authorize: path => authorizeRoot(request, path), restricted });
  }));
  app.get("/api/source-control/defaults", rateLimitOptions, handler(async request => {
    const query = z.object({ projectPath: z.string().min(1).max(4096) }).parse(request.query);
    const ownerId = await owner(request); const root = await authorizeRoot(request, query.projectPath);
    return service.getProjectDefaults(ownerId, root);
  }));
  app.post("/api/source-control/defaults", rateLimitOptions, handler(async request => {
    const body = setProjectDefaultRepoSchema.parse(request.body);
    const ownerId = await owner(request); const root = await authorizeRoot(request, body.projectPath);
    return service.setProjectDefault(ownerId, root, body.provider, { fullName: body.repositoryFullName ?? null, repositoryId: body.repositoryId ?? null });
  }));
  const authorizedBinding = async (request: FastifyRequest, id: string) => {
    const ownerId = await owner(request); const binding = await service.binding(ownerId, id);
    await authorizeRoot(request, binding.projectPath); return ownerId;
  };
  app.get("/api/source-control/status", rateLimitOptions, handler(async request => {
    const { bindingId } = z.object({ bindingId: z.string().min(1).max(160) }).parse(request.query);
    return service.status(await authorizedBinding(request, bindingId), bindingId);
  }));
  app.get("/api/source-control/diff", rateLimitOptions, handler(async request => {
    const query = z.object({ bindingId: z.string().min(1).max(160), path: z.string().min(1).max(4096), staged: z.enum(["true", "false"]).default("false"), comparison: z.enum(["local", "remote"]).default("local") }).parse(request.query);
    return service.diff(await authorizedBinding(request, query.bindingId), query.bindingId, query.path, query.staged === "true", query.comparison === "remote");
  }));
  app.get("/api/source-control/publish-pending", rateLimitOptions, handler(async request => {
    const query = z.object({ projectPath: z.string().min(1).max(4096) }).strict().parse(request.query);
    const ownerId = await owner(request); const root = await authorizeRoot(request, query.projectPath);
    return service.pendingPublishes(ownerId, root);
  }));
  app.post("/api/source-control/publish-dismiss", rateLimitOptions, handler(async request => {
    // The caller must confirm it checked the provider: dismissing makes a new create possible.
    const body = z.object({ bindingId: z.string().min(1).max(160), operationId: z.string().min(1).max(160), confirmed: z.literal(true) }).strict().parse(request.body);
    return service.dismissPublish(await authorizedBinding(request, body.bindingId), body.bindingId, body.operationId);
  }));
  app.post("/api/source-control/publish-preview", rateLimitOptions, handler(async request => {
    const input = gitOperationSchema.parse(request.body); return service.previewPublish(await authorizedBinding(request, input.bindingId), input);
  }));
  const operations: GitOperation[] = ["initialize", "clone", "publish", "stage", "unstage", "discard", "commit", "commit-push", "fetch", "pull", "push"];
  for (const operation of operations) app.post(`/api/source-control/${operation}`, rateLimitOptions, handler(async request => {
    const input = gitOperationSchema.parse(request.body); const ownerId = await authorizedBinding(request, input.bindingId);
    return service.operate(ownerId, operation, input, { name: request.user!.email.split("@")[0] || "Space user", email: request.user!.email });
  }));
}
