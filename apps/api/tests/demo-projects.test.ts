import { cp, mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryDemoProjectsRepository } from "@space/db";
import { DemoCredentialStore } from "../src/demo-projects/credentials.js";
import { DemoProjectsService } from "../src/demo-projects/service.js";
import { DemoRunError, redactDemoLogLine } from "../src/demo-projects/runner.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const realDemoRoot = join(repositoryRoot, "demos");
const projectTwoVariant = join("project-2-crud-playground", "javascript-react-node");
const projectTwoEntry = join(realDemoRoot, projectTwoVariant, "web", "dist", "index.html");
const templatesBuilt = existsSync(projectTwoEntry);

interface TestContext {
  root: string;
  varRoot: string;
  demoRoot: string;
  repository: InMemoryDemoProjectsRepository;
  service: DemoProjectsService;
}

async function createContext(healthTimeoutMs = 12_000): Promise<TestContext> {
  const root = await mkdtemp(join(tmpdir(), "space-demo-projects-"));
  const varRoot = join(root, "var");
  const demoRoot = join(root, "demos");
  await mkdir(varRoot, { recursive: true });
  await cp(join(realDemoRoot, "project-2-crud-playground"), join(demoRoot, "project-2-crud-playground"), { recursive: true });
  const repository = new InMemoryDemoProjectsRepository();
  const service = new DemoProjectsService({
    repository,
    demoRoot,
    varRoot,
    apiPort: 1,
    publicOrigin: "https://space.example",
    portRangeStart: 51_500,
    portRangeEnd: 51_560,
    healthTimeoutMs,
    credentialStore: new DemoCredentialStore(join(varRoot, "secrets"))
  });
  await service.initialize();
  return { root, varRoot, demoRoot, repository, service };
}

let context: TestContext | null = null;

beforeEach(async () => {
  context = await createContext();
});

afterEach(async () => {
  if (!context) return;
  await context.service.dispose();
  await rm(context.root, { recursive: true, force: true });
  context = null;
});

describe.skipIf(!templatesBuilt)("demo projects run lifecycle", () => {
  it("starts a real demo process, reports health, captures logs and stops it", async () => {
    const service = context!.service;
    const started = await service.runs.start({
      ownerUserId: "user:test",
      projectId: "project-2-crud-playground",
      variantId: "javascript-react-node",
      mode: "SAMPLE"
    });
    expect(started.run.status).toBe("RUNNING");
    expect(started.run.port).toBeGreaterThan(0);
    expect(started.run.health?.ok).toBe(true);

    const health = await fetch(`http://127.0.0.1:${started.run.port}/healthz`).then((response) => response.json());
    expect(health).toMatchObject({ ok: true, mode: "SAMPLE", projectId: "project-2-crud-playground" });

    const logs = await service.runs.readLogs("user:test", started.run.id, 0);
    expect(logs.entries.length).toBeGreaterThan(0);
    expect(logs.entries.some((entry) => entry.line.includes("demo server ready"))).toBe(true);
    expect(JSON.stringify(logs.entries)).not.toContain(started.run.previewToken);

    const stopped = await service.runs.stop("user:test", started.run.id);
    expect(stopped.status).toBe("STOPPED");
    expect(stopped.port).toBeNull();
    await expect(fetch(`http://127.0.0.1:${started.run.port}/healthz`, { signal: AbortSignal.timeout(1_500) })).rejects.toBeTruthy();
  });

  it("keeps runs isolated per owner and refuses unknown variants", async () => {
    const service = context!.service;
    await expect(
      service.runs.start({ ownerUserId: "user:test", projectId: "project-2-crud-playground", variantId: "python-fastapi", mode: "SAMPLE" })
    ).rejects.toMatchObject({ code: "DEMO_VARIANT_UNKNOWN" });

    const started = await service.runs.start({
      ownerUserId: "user:test",
      projectId: "project-2-crud-playground",
      variantId: "javascript-react-node",
      mode: "SAMPLE"
    });
    expect(await service.runs.getOwnedRun("user:other", started.run.id)).toBeNull();
    await expect(service.runs.requireOwnedRun("user:other", started.run.id)).rejects.toBeInstanceOf(DemoRunError);
    await service.runs.stop("user:test", started.run.id);
  });

  it(
    "reports a failed start when the health check never answers",
    async () => {
      await context!.service.dispose();
      await rm(context!.root, { recursive: true, force: true });
      context = await createContext(1_200);
      const broken = join(context.demoRoot, "project-2-crud-playground", "javascript-react-node", "server", "index.mjs");
      await writeFile(broken, "process.stdout.write('starting but never listening\\n');\n", "utf8");
      await expect(
        context.service.runs.start({
          ownerUserId: "user:test",
          projectId: "project-2-crud-playground",
          variantId: "javascript-react-node",
          mode: "SAMPLE",
          connectionStatus: async () => true
        })
      ).rejects.toMatchObject({ code: "DEMO_START_FAILED" });
      const runs = await context.repository.listRuns("user:test", 5);
      expect(runs[0]?.status).toBe("FAILED");
      expect(runs[0]?.lastError).toBeTruthy();
    },
    30_000
  );

  it("requires live connections before a LIVE run can start", async () => {
    await expect(
      context!.service.runs.start({
        ownerUserId: "user:test",
        projectId: "project-1-salesforce-crm",
        variantId: "javascript-react-node",
        mode: "LIVE",
        connectionStatus: async () => false
      })
    ).rejects.toMatchObject({ code: "DEMO_CONNECTION_REQUIRED" });
  });

  it("runs the shared business checks against the started demo", async () => {
    const service = context!.service;
    const started = await service.runs.start({
      ownerUserId: "user:test",
      projectId: "project-2-crud-playground",
      variantId: "javascript-react-node",
      mode: "SAMPLE"
    });
    const testRun = await service.testRunner.run({
      ownerUserId: "user:test",
      run: started.run,
      projectId: "project-2-crud-playground",
      variantId: "javascript-react-node"
    });
    expect(testRun.status).toBe("PASSED");
    expect(testRun.steps.map((step) => step.key)).toContain("create");
    expect(testRun.steps.some((step) => step.key === "isolation" && step.status === "PASSED")).toBe(true);
    await service.runs.stop("user:test", started.run.id);
  });
});

describe("demo projects catalog and selection", () => {
  it("lists two projects with generated variants", async () => {
    const catalog = await context!.service.catalog();
    expect(catalog.projects.map((project) => project.id)).toEqual([
      "project-1-salesforce-crm",
      "project-2-crud-playground"
    ]);
    expect(catalog.variants).toHaveLength(4);
    expect(catalog.variants.filter((variant) => variant.available === false).every((variant) => variant.unavailableReason !== null)).toBe(true);
  });

  it("persists the selection per user and project", async () => {
    const service = context!.service;
    await service.saveSelection("user:one", { projectId: "project-2-crud-playground", variantId: "typescript-react-node", mode: "SAMPLE" });
    await service.saveSelection("user:two", { projectId: "project-1-salesforce-crm", variantId: "javascript-react-node", mode: "LIVE" });
    expect(await service.selection("user:one")).toEqual({
      projectId: "project-2-crud-playground",
      variantId: "typescript-react-node",
      mode: "SAMPLE"
    });
    expect(await service.selection("user:two")).toEqual({
      projectId: "project-1-salesforce-crm",
      variantId: "javascript-react-node",
      mode: "LIVE"
    });
    await expect(
      service.saveSelection("user:one", { projectId: "project-2-crud-playground", variantId: "nope", mode: "SAMPLE" })
    ).rejects.toMatchObject({ code: "DEMO_VARIANT_UNKNOWN" });
  });

  it("lists variant files with live line counts", async () => {
    const service = context!.service;
    const result = await service.listVariantFiles("javascript-react-node", "project-2-crud-playground");
    expect(result.files.length).toBeGreaterThan(0);
    expect(result.files.every((file) => typeof file.lines === "number" && file.lines > 0)).toBe(true);
    const serverFile = result.files.find((f) => f.group === "server");
    expect(serverFile).toBeDefined();
    expect(serverFile!.lines).toBeGreaterThan(5);
  });
});

describe("demo credential storage", () => {
  it("encrypts payloads at rest and rejects tampering", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-demo-secrets-"));
    try {
      const store = new DemoCredentialStore(root);
      await store.initialize();
      await store.write("demo-salesforce-abc12345", { refreshToken: "refresh-value", clientSecret: "secret-value" });
      const { readdir } = await import("node:fs/promises");
      const files = await readdir(join(root, "credentials"));
      expect(files).toHaveLength(1);
      const raw = await readFile(join(root, "credentials", files[0]!), "utf8");
      expect(raw).not.toContain("refresh-value");
      expect(raw).not.toContain("secret-value");
      expect(await store.read("demo-salesforce-abc12345")).toMatchObject({ refreshToken: "refresh-value" });
      const tampered = JSON.parse(raw) as { data: string };
      tampered.data = Buffer.from("tampered").toString("base64");
      await writeFile(join(root, "credentials", files[0]!), `${JSON.stringify(tampered)}\n`, { mode: 0o600 });
      await expect(store.read("demo-salesforce-abc12345")).rejects.toBeTruthy();
      await store.delete("demo-salesforce-abc12345");
      await expect(store.read("demo-salesforce-abc12345")).rejects.toBeTruthy();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("self-heals drifted permissions on master key and credential files", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-demo-secrets-drift-"));
    try {
      const store = new DemoCredentialStore(root);
      await store.initialize();
      await store.write("demo-provider-ref123", { token: "token-secret-xyz" });

      const { chmod, stat, readdir } = await import("node:fs/promises");
      const files = await readdir(join(root, "credentials"));
      const credPath = join(root, "credentials", files[0]!);
      const keyPath = join(root, "master.key");

      // Simulate permission drift (e.g., group write permission 0620/0660)
      await chmod(keyPath, 0o620);
      await chmod(credPath, 0o660);

      // A fresh store instance with cleared cache
      const freshStore = new DemoCredentialStore(root);
      await freshStore.initialize();

      const keyStat = await stat(keyPath);
      expect(keyStat.mode & 0o777).toBe(0o600);

      const payload = await freshStore.read("demo-provider-ref123");
      expect(payload).toEqual({ token: "token-secret-xyz" });

      const credStat = await stat(credPath);
      expect(credStat.mode & 0o777).toBe(0o600);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("demo log redaction", () => {
  it("removes run tokens, bearer values and provider ids", () => {
    const redacted = redactDemoLogLine(
      "run token=abc123tokenvalue Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9 account 0011000001ABCDEFG",
      ["abc123tokenvalue"]
    );
    expect(redacted).not.toContain("abc123tokenvalue");
    expect(redacted).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    expect(redacted).not.toContain("0011000001ABCDEFG");
  });
});
