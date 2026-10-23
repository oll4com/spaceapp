import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { InMemoryAppDiagnosticsRepository } from "@space/db";
import { createApp, type CreateAppOptions } from "../src/app.js";
import { AppDiagnosticsService } from "../src/app-diagnostics.js";
import { getApiConfig } from "../src/config.js";
import { cookieName, createCsrfToken, signSession } from "../src/auth.js";

const boundary = vi.hoisted(() => ({ root: "", directories: [] as string[], incidents: [] as { path: string; data: string }[] }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const privatePath = (path: unknown) => {
    const inside = relative(resolve(boundary.root), resolve(String(path)));
    return boundary.root && inside !== ".." && !inside.startsWith("../") && !inside.startsWith("..\\") && !isAbsolute(inside);
  };
  return { ...actual,
    mkdir: vi.fn(async (path: Parameters<typeof actual.mkdir>[0], options: Parameters<typeof actual.mkdir>[1]) => {
      if (String(path).endsWith("live-voice-logs")) { boundary.directories.push(String(path)); return; }
      if (!privatePath(path)) throw new Error("Test blocked mkdir outside its private fixture.");
      return actual.mkdir(path, options);
    }),
    appendFile: vi.fn(async (path: unknown, data: unknown) => {
      boundary.incidents.push({ path: String(path), data: String(data) });
      // Both old installed and corrected dev destinations are virtualized.
    }),
    writeFile: vi.fn(async (path: Parameters<typeof actual.writeFile>[0], data: Parameters<typeof actual.writeFile>[1], options: Parameters<typeof actual.writeFile>[2]) => {
      if (!privatePath(path)) throw new Error("Test blocked write outside its private fixture.");
      return actual.writeFile(path, data, options);
    })
  };
});
let app: Awaited<ReturnType<typeof createApp>> | undefined;
afterEach(async () => {
  await app?.close(); app = undefined;
  vi.unstubAllEnvs();
  if (boundary.root) {
    const inside = relative(resolve(tmpdir()), resolve(boundary.root));
    if (!inside.startsWith("space-dev-incident-") || isAbsolute(inside) || inside.includes("/") || inside.includes("\\")) throw new Error("Unexpected fixture cleanup path.");
    await rm(boundary.root, { recursive: true, force: true });
  }
  boundary.root = ""; boundary.directories.length = 0; boundary.incidents.length = 0;
});

it("retains actual full-room failure and writes its diagnostic only to private dev storage", async () => {
  boundary.root = await mkdtemp(join(tmpdir(), "space-dev-incident-"));
  vi.stubEnv("SPACE_INSTANCE", "dev");
  vi.stubEnv("SPACE_INSTALL_ROOT", join(boundary.root, "install"));
  const store = new InMemorySpaceStore();
  const user = { id: "user:dev-capacity", role: "ADMIN" as const, email: "synthetic@example.invalid" };
  store.upsertUser(user);
  const room = store.createRoom({ name: "Full private dev room", initialPaneCount: 0, kind: "AGENT_PROOF" });
  for (let index = 0; index < room.paneCap; index++) store.createPane({ roomId: room.id, title: `Synthetic pane ${index}`, mode: "TERMINAL" });
  const secret = "synthetic-dev-incident-test-session";
  app = await createApp({ store,
    config: getApiConfig({ SPACE_INSTANCE: "dev", SPACE_OPTIONAL_MODULES: "none", SPACE_PUBLIC_DISTRIBUTION: "true", SPACE_LOG_LEVEL: "silent", SPACE_CLI_ENABLED: "false", SPACE_CLI_COMMAND_PATH: "/nonexistent-dev-bin", SPACE_T3CODE_ENABLED: "false", SPACE_ARTIFACT_ROOT: boundary.root, SPACE_APP_DIAGNOSTICS_ROOT: join(boundary.root, "diagnostics") }),
    auth: { sessionSecret: secret, devLogin: false, secureCookies: false },
    // Personal Git is outside this test; prevent its Unix-only credential-store
    // constructor from running on native Windows, and do not contact providers.
    sourceControlService: { close: async () => undefined } as unknown as CreateAppOptions["sourceControlService"],
    streamingService: { initialize: async () => undefined, dispose: async () => undefined } as unknown as CreateAppOptions["streamingService"],
    appDiagnosticsService: new AppDiagnosticsService({ repository: new InMemoryAppDiagnosticsRepository(), root: join(boundary.root, "diagnostics") })
  });
  const token = signSession(user, secret);
  const response = await app.inject({ method: "POST", url: "/api/control/v1/commands",
    headers: { cookie: `${cookieName}=${token}`, "x-space-csrf-token": createCsrfToken(token, secret)! },
    payload: { roomId: room.id, requestId: "dev-capacity-negative-path", actions: [{ kind: "resource", operation: "panes.open", input: { counts: { opencode: 1 } } }] }
  });
  expect(response.statusCode).toBe(200);
  expect(response.json().status).toBe("FAILED");
  expect(JSON.stringify(response.json())).toMatch(/capacity exceeded/i);
  await vi.waitFor(() => expect(boundary.incidents).toHaveLength(1));
  const directory = join(boundary.root, "install", "var", "live-voice-logs");
  expect(boundary.directories).toEqual([directory]);
  expect(boundary.incidents[0]!.path).toBe(`${directory}/debug-incidents.jsonl`);
  expect(JSON.parse(boundary.incidents[0]!.data)).toMatchObject({ operation: "panes.open", roomId: room.id, roomCapacity: { freeSlots: 0 } });
  expect(store.listPanes(room.id)).toHaveLength(room.paneCap);
});
