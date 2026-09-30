import { timingSafeEqual } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import type {
  DemoCatalogResponse,
  DemoConnection,
  DemoConnectionProvider,
  DemoSelection,
  DemoSheetsTarget,
  DemoStateResponse,
  DemoVariantFile,
  DemoVariantFileContent,
  DemoVariantFilesResponse
} from "@space/contracts";
import type { DemoProjectsRepository, DemoRunRecord, DemoSheetsTargetRecord } from "@space/db";
import {
  buildDemoCatalog,
  defaultDemoProjectId,
  defaultDemoVariantId,
  findDemoProject,
  findDemoVariant,
  resolveTemplateDirectory,
  variantsForProject
} from "./catalog.js";
import { DemoConnectionError, DemoConnectionsService } from "./connections.js";
import { DemoCredentialStore } from "./credentials.js";
import { DemoOperationError, DemoOperationsService } from "./operations.js";
import { DemoRunError, DemoRunManager } from "./runner.js";
import { DemoTestRunner } from "./tests.js";

const sourceFileExtensions = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".ts",
  ".tsx",
  ".json",
  ".css",
  ".html",
  ".md"
]);
const skippedDirectories = new Set(["node_modules", ".git", "dist", "server-dist", "coverage"]);
const maximumReadableFileBytes = 400 * 1024;
const maximumListedFiles = 400;

export interface DemoProjectsServiceOptions {
  repository: DemoProjectsRepository;
  demoRoot: string;
  varRoot: string;
  apiPort: number;
  publicOrigin: string | null;
  portRangeStart: number;
  portRangeEnd: number;
  healthTimeoutMs: number;
  credentialStore: DemoCredentialStore;
  log?: (event: string, detail?: Record<string, unknown>) => void;
  /** Overridable for tests: provider HTTP client. */
  fetchImpl?: typeof fetch;
}

export class DemoProjectsService {
  readonly connections: DemoConnectionsService;
  readonly operations: DemoOperationsService;
  readonly runs: DemoRunManager;
  readonly testRunner: DemoTestRunner;
  private initialization: Promise<void> | null = null;

  constructor(private readonly options: DemoProjectsServiceOptions) {
    this.connections = new DemoConnectionsService({
      repository: options.repository,
      credentialStore: options.credentialStore,
      fetchImpl: options.fetchImpl
    });
    this.operations = new DemoOperationsService({
      repository: options.repository,
      connections: this.connections,
      log: options.log,
      fetchImpl: options.fetchImpl
    });
    this.runs = new DemoRunManager({
      repository: options.repository,
      demoRoot: options.demoRoot,
      varRoot: options.varRoot,
      apiPort: options.apiPort,
      portRangeStart: options.portRangeStart,
      portRangeEnd: options.portRangeEnd,
      healthTimeoutMs: options.healthTimeoutMs,
      previewBasePath: "/api/demo-projects/preview",
      log: options.log
    });
    this.testRunner = new DemoTestRunner({ repository: options.repository, fetchImpl: options.fetchImpl });
  }

  /**
   * Initialization is lazy and memoized: the Space API must never fail to start
   * (or block startup) because of an optional feature's state directory. The
   * first request that needs Demo Projects performs the filesystem work, and a
   * failure is reported to that request instead of crashing the process.
   */
  initialize(): Promise<void> {
    this.initialization ??= (async () => {
      await this.options.credentialStore.initialize();
      await this.runs.initialize();
      this.operations.start();
    })();
    return this.initialization;
  }

  async dispose(): Promise<void> {
    this.operations.stop();
    this.runs.dispose();
  }

  get demoRoot(): string {
    return this.options.demoRoot;
  }

  async catalog(): Promise<DemoCatalogResponse> {
    return buildDemoCatalog(this.options.demoRoot);
  }

  async selection(ownerUserId: string): Promise<DemoSelection> {
    const preference = await this.options.repository.getLatestPreference(ownerUserId);
    const project = findDemoProject(preference?.projectId ?? defaultDemoProjectId) ?? findDemoProject(defaultDemoProjectId)!;
    const variants = variantsForProject(project.id);
    const variant = variants.find((candidate) => candidate.id === (preference?.variantId ?? defaultDemoVariantId)) ?? variants[0]!;
    return { projectId: project.id, variantId: variant.id, mode: preference?.mode ?? "SAMPLE" };
  }

  async saveSelection(ownerUserId: string, input: DemoSelection): Promise<DemoSelection> {
    const project = findDemoProject(input.projectId);
    const variant = findDemoVariant(input.projectId, input.variantId);
    if (!project || !variant) throw new DemoRunError("DEMO_VARIANT_UNKNOWN", "The requested demo variant is not in the catalog.", 404);
    await this.options.repository.upsertPreference({
      ownerUserId,
      projectId: project.id,
      variantId: variant.id,
      mode: input.mode
    });
    return { projectId: project.id, variantId: variant.id, mode: input.mode };
  }

  async state(ownerUserId: string, publicOrigin: string): Promise<DemoStateResponse> {
    const [catalog, selection, connections, sheets] = await Promise.all([
      this.catalog(),
      this.selection(ownerUserId),
      this.connections.listConnections(ownerUserId, publicOrigin),
      this.options.repository.getSheetsTarget(ownerUserId)
    ]);
    const run = await this.latestRun(ownerUserId, selection);
    const liveReady = connections
      .filter((connection) => this.requiredFor(selection.projectId).includes(connection.provider))
      .every((connection) => connection.status === "CONNECTED");
    return {
      catalog,
      selection,
      run: run ? this.publicRun(run) : null,
      connections,
      sheets: this.publicSheetsTarget(sheets),
      liveReady
    };
  }

  private requiredFor(projectId: string): DemoConnectionProvider[] {
    return findDemoProject(projectId)?.requiresConnections ? [...findDemoProject(projectId)!.requiresConnections] : [];
  }

  private async latestRun(ownerUserId: string, selection: DemoSelection): Promise<DemoRunRecord | null> {
    const runs = await this.options.repository.listRuns(ownerUserId, 20);
    const match = runs.find((run) => run.projectId === selection.projectId && run.variantId === selection.variantId);
    if (!match) return null;
    if ((match.status === "RUNNING" || match.status === "STARTING") && match.port) {
      const health = await this.runs.healthCheck(match.port);
      if (!health.ok) {
        return this.options.repository.upsertRun({ ...match, status: "FAILED", port: null, pid: null, health: null, lastError: health.detail ?? "The health check failed." });
      }
      return this.options.repository.upsertRun({ ...match, status: "RUNNING", health });
    }
    return match;
  }

  publicRun(run: DemoRunRecord): DemoStateResponse["run"] {
    return {
      id: run.id,
      projectId: run.projectId,
      variantId: run.variantId,
      mode: run.mode,
      status: run.status,
      port: run.port,
      previewPath: run.status === "RUNNING" && run.port ? this.runs.previewPath(run) : null,
      health: run.health,
      startedAt: run.startedAt,
      stoppedAt: run.stoppedAt,
      lastError: run.lastError,
      logEntries: 0
    };
  }

  publicSheetsTarget(target: DemoSheetsTargetRecord | null): DemoSheetsTarget {
    return {
      spreadsheetId: target?.spreadsheetId ?? null,
      spreadsheetUrl: target?.spreadsheetUrl ?? null,
      title: target?.title ?? null,
      tab: target?.tab ?? null,
      verified: Boolean(target?.verifiedAt),
      headerPresent: Boolean(target?.headerPresent),
      verifiedAt: target?.verifiedAt ?? null
    };
  }

  async previewTarget(runId: string, token: string): Promise<DemoRunRecord | null> {
    if (!token) return null;
    const record = await this.options.repository.getRun(runId);
    if (!record) return null;
    if (record.status !== "RUNNING" || !record.port) return null;
    return constantTimeEquals(record.previewToken, token) ? record : null;
  }

  async ownedRuns(ownerUserId: string, limit: number): Promise<DemoRunRecord[]> {
    return this.options.repository.listRuns(ownerUserId, limit);
  }

  async runTokenTarget(runId: string, token: string): Promise<DemoRunRecord | null> {
    return this.runs.findRunByRunToken(runId, token);
  }

  async listVariantFiles(variantId: string, projectId?: string): Promise<DemoVariantFilesResponse> {
    const variant = projectId ? findDemoVariant(projectId, variantId) : this.variantById(variantId);
    if (!variant) throw new DemoRunError("DEMO_VARIANT_UNKNOWN", "The requested demo variant is not in the catalog.", 404);
    const templateDirectory = resolveTemplateDirectory(this.options.demoRoot, variant);
    const files: DemoVariantFile[] = [];
    await collectFiles(templateDirectory, templateDirectory, files);
    files.sort((left, right) => left.path.localeCompare(right.path));
    return {
      variantId: variant.id,
      files: files.slice(0, maximumListedFiles),
      workspacePath: templateDirectory
    };
  }

  private variantById(variantId: string) {
    for (const project of ["project-1-salesforce-crm", "project-2-crud-playground"]) {
      const variant = findDemoVariant(project, variantId);
      if (variant) return variant;
    }
    return null;
  }

  async readVariantFile(variantId: string, inputPath: string, projectId?: string): Promise<DemoVariantFileContent> {
    const variant = projectId ? findDemoVariant(projectId, variantId) : this.variantById(variantId);
    if (!variant) throw new DemoRunError("DEMO_VARIANT_UNKNOWN", "The requested demo variant is not in the catalog.", 404);
    const templateDirectory = resolveTemplateDirectory(this.options.demoRoot, variant);
    const absolute = resolve(templateDirectory, inputPath);
    if (!absolute.startsWith(`${resolve(templateDirectory)}/`)) {
      throw new DemoRunError("DEMO_FILE_OUTSIDE_TEMPLATE", "Only files inside the variant template can be read.", 400);
    }
    const info = await stat(absolute).catch(() => null);
    if (!info?.isFile()) throw new DemoRunError("DEMO_FILE_NOT_FOUND", "The requested file was not found.", 404);
    if (info.size > maximumReadableFileBytes) {
      throw new DemoRunError("DEMO_FILE_TOO_LARGE", "The requested file is too large to display.", 413);
    }
    const content = await readFile(absolute, "utf8");
    return { path: relative(templateDirectory, absolute), content, truncated: false };
  }

  catalogConnections(ownerUserId: string, publicOrigin: string): Promise<DemoConnection[]> {
    return this.connections.listConnections(ownerUserId, publicOrigin);
  }

  describeError(error: unknown): { code: string; message: string; statusCode: number } {
    if (error instanceof DemoRunError || error instanceof DemoConnectionError || error instanceof DemoOperationError) {
      return { code: error.code, message: error.message, statusCode: error.statusCode };
    }
    return this.operations.describeFailure(error);
  }
}

function constantTimeEquals(expected: string, candidate: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const candidateBuffer = Buffer.from(candidate);
  if (expectedBuffer.length !== candidateBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, candidateBuffer);
}

async function collectFiles(root: string, directory: string, files: DemoVariantFile[]): Promise<void> {
  if (files.length >= maximumListedFiles) return;
  let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (files.length >= maximumListedFiles) return;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (skippedDirectories.has(entry.name)) continue;
      await collectFiles(root, absolute, files);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!sourceFileExtensions.has(extname(entry.name))) continue;
    const info = await stat(absolute).catch(() => null);
    if (!info) continue;
    let lines = 0;
    try {
      const content = await readFile(absolute, "utf8");
      lines = content.split("\n").length;
    } catch {
      // ignore reading errors for binary or unreadable files
    }
    const path = relative(root, absolute);
    files.push({ path, bytes: info.size, lines, group: fileGroup(path) });
  }
}

function fileGroup(path: string): DemoVariantFile["group"] {
  if (path.startsWith("server") || path.startsWith("src/")) return "server";
  if (path.startsWith("web/")) return "web";
  if (path.endsWith(".md")) return "docs";
  return "config";
}
