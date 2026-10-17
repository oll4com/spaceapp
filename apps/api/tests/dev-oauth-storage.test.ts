import Fastify from "fastify";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { getAuthConfig } from "../src/auth.js";
import { registerAuthRoutes } from "../src/auth-routes.js";
import { getApiConfig } from "../src/config.js";
import { instanceSecretDirectories } from "../src/instance-storage.js";
import { locations, serviceEnvironment } from "../../../scripts/dev-stack/state.mjs";

const files = vi.hoisted(() => ({
  values: new Map<string, string>(), reads: [] as string[], writes: [] as string[], directories: [] as string[]
}));

// Virtualize both installed and private OAuth boundaries. No baseline control can
// read a real operator file or mkdir/write /opt, /var, or a Windows drive root.
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual,
    existsSync: vi.fn((path: Parameters<typeof actual.existsSync>[0]) => {
      if (!String(path).endsWith("google-oauth.json")) return actual.existsSync(path);
      files.reads.push(String(path));
      return files.values.has(String(path));
    }),
    readFileSync: vi.fn((path: Parameters<typeof actual.readFileSync>[0], ...args: unknown[]) => {
      if (String(path).endsWith("google-oauth.json")) return files.values.get(String(path));
      return Reflect.apply(actual.readFileSync, actual, [path, ...args]);
    })
  };
});
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual,
    mkdir: vi.fn(async (path: unknown) => { files.directories.push(String(path)); }),
    writeFile: vi.fn(async (path: unknown, data: unknown) => {
      files.writes.push(String(path)); files.values.set(String(path), String(data));
    })
  };
});

function devEnvironment() {
  const config = locations(process.cwd(), {});
  return serviceEnvironment(config, { ports: config.ports, nonce: "0".repeat(32) },
    { password: "synthetic-database-value", session: "synthetic-session-value" }, {});
}
const synthetic = { clientId: "synthetic-client.apps.invalid", clientSecret: "synthetic-test-value" };
beforeEach(() => {
  files.values.clear(); files.reads.length = 0; files.writes.length = 0; files.directories.length = 0;
});
afterEach(() => vi.unstubAllEnvs());

describe("dev OAuth file isolation", () => {
  it("does not inspect installed credentials when using the launcher's actual private environment", () => {
    const env = devEnvironment();
    files.values.set("/opt/spaceapp/secrets/google-oauth.json", JSON.stringify(synthetic));
    files.values.set("/var/lib/spaceapp/google-oauth.json", JSON.stringify(synthetic));
    expect(getAuthConfig(env).googleClientId).toBeUndefined();
    expect(files.reads).toEqual([`${join(env.SPACE_INSTALL_ROOT, "secrets")}/google-oauth.json`]);
    const privateFile = files.reads[0]!;
    files.values.set(privateFile, JSON.stringify(synthetic)); files.reads.length = 0;
    expect(getAuthConfig(env)).toMatchObject({ googleClientId: synthetic.clientId, googleClientSecret: synthetic.clientSecret });
    expect(files.reads).toEqual([privateFile]);
  });

  it("preserves both stable loader candidates and their fallback order", () => {
    expect(instanceSecretDirectories({})).toEqual(["/opt/spaceapp/secrets", "/var/lib/spaceapp"]);
    files.values.set("/var/lib/spaceapp/google-oauth.json", JSON.stringify(synthetic));
    expect(getAuthConfig({})).toMatchObject({ googleClientId: synthetic.clientId });
    expect(files.reads).toEqual(["/opt/spaceapp/secrets/google-oauth.json", "/var/lib/spaceapp/google-oauth.json"]);
  });

  it("saves synthetic settings through the real admin route only to the dev-private file", async () => {
    const env = devEnvironment();
    vi.stubEnv("SPACE_INSTANCE", env.SPACE_INSTANCE);
    vi.stubEnv("SPACE_INSTALL_ROOT", env.SPACE_INSTALL_ROOT);
    const app = Fastify();
    const user = { id: "user:synthetic-dev-owner", email: "synthetic@example.invalid", role: "ADMIN" as const };
    app.decorateRequest("user", null);
    app.addHook("onRequest", async request => { request.user = user; });
    type Options = Parameters<typeof registerAuthRoutes>[1];
    const unused = new Proxy({}, { get() { throw new Error("This offline storage test must not use browser/OAuth services."); } });
    registerAuthRoutes(app, {
      // Route options do not launch Unix-only CLI hosts; OAuth still consumes the
      // exact launcher environment above on both native Windows and hosted POSIX.
      config: { ...getApiConfig({}), instance: "dev" }, auth: getAuthConfig(env), store: new InMemorySpaceStore(), routeOptions: {},
      browserSessionManager: unused as Options["browserSessionManager"],
      connectorStateTools: unused as Options["connectorStateTools"], connectorServiceRef: { current: null },
      googleAccountBrowserStatuses: async () => new Map(), dotsAuthenticatedOwner: async () => user.id,
      persistRevocation: async pending => { await pending; }
    });
    try {
      const response = await app.inject({ method: "POST", url: "/api/auth/google/configure", payload: synthetic });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true, googleAuthEnabled: true });
      const directory = join(env.SPACE_INSTALL_ROOT, "secrets");
      expect(files.directories).toEqual([directory]);
      expect(files.writes).toEqual([`${directory}/google-oauth.json`]);
      expect(getAuthConfig(env)).toMatchObject({ googleClientId: synthetic.clientId, googleClientSecret: synthetic.clientSecret });
    } finally { await app.close(); }
  });
});
