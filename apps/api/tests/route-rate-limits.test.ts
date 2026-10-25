import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { getApiConfig } from "../src/config.js";

// On loaded hosts (2026-10-11) parsing app.ts took up to 10 s, and starting
// and closing the whole API up to 15 s plus 11-38 s, so the default 5 s limit
// says nothing about correctness.
const SLOW_TEST_TIMEOUT_MS = 60_000;

const routeMethods = new Set(["delete", "get", "patch", "post", "put"]);
const namedRateLimitOptions = new Set([
  "defaultRouteRateLimitOptions",
  "defaultWebsocketRateLimitOptions"
]);

// The composition root and the route modules moved verbatim out of it keep explicit per-route limits.
const compositionRouteSources = [
  "../src/app.ts",
  "../src/shared-chat-routes.ts",
  "../src/health-routes.ts",
  "../src/desktop-release-routes.ts",
  "../src/setup-routes.ts",
  "../src/auth-routes.ts",
  "../src/app-diagnostics-routes.ts",
  "../src/activity-log-routes.ts",
  "../src/agent-session-routes.ts",
  "../src/room-routes.ts",
  "../src/proof-room-routes.ts",
  "../src/admin-ops-routes.ts",
  "../src/browser-evidence-routes.ts",
  "../src/artifact-routes.ts",
  "../src/shared-task-routes.ts",
  "../src/memory-routes.ts",
  "../src/mcp-routes.ts",
  "../src/settings-routes.ts",
  "../src/source-control-connection-routes.ts",
  "../src/release-routes.ts",
  "../src/system-analytics-routes.ts",
  "../src/admin-toolbar-routes.ts",
  "../src/codex-history-purge-routes.ts",
  "../src/cli-auth-handoff-routes.ts",
  "../src/turn-routes.ts",
  "../src/event-routes.ts",
  "../src/voice-routes.ts",
  "../src/live-routes.ts",
  "../src/room-agent-routes.ts",
  "../src/agent-pane-routes.ts",
  "../src/pane-cli-session-routes.ts",
  "../src/internal-agent-action-routes.ts",
  "../src/cli-browser-bridge-routes.ts",
  "../src/pane-browser-routes.ts",
  "../src/pane-stream-routes.ts",
  "../src/pane-routes.ts",
  "../src/pane-cli-routes.ts",
  "../src/cli-runtime-routes.ts",
  "../src/cli-account-routes.ts",
  "../src/link-inspect-routes.ts",
  "../src/client-error-routes.ts"
];

it("declares an explicit CodeQL-visible rate limit on every Fastify route", async () => {
  const missing: string[] = [];
  for (const relativePath of compositionRouteSources) {
    const appPath = fileURLToPath(new URL(relativePath, import.meta.url));
    const sourceText = await readFile(appPath, "utf8");
    const source = ts.createSourceFile(appPath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "app" &&
        routeMethods.has(node.expression.name.text)
      ) {
        const route = node.arguments[0]?.getText(source) ?? "<unknown>";
        const options = node.arguments[1];
        const hasRateLimit =
          node.arguments.length >= 3 &&
          Boolean(options) &&
          (
            options!.getText(source).includes("rateLimit") ||
            (ts.isIdentifier(options!) && namedRateLimitOptions.has(options!.text))
          );
        if (!hasRateLimit) {
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
          missing.push(`${relativePath}:${line}: ${route}`);
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(source);
  }
  expect(missing, `Routes without explicit rate limits:\n${missing.join("\n")}`).toEqual([]);
}, SLOW_TEST_TIMEOUT_MS);

it("registers the global limiter before the request-phase hooks", async () => {
  const appPath = fileURLToPath(new URL("../src/app.ts", import.meta.url));
  const sourceText = await readFile(appPath, "utf8");
  const limiterRegistration = sourceText.indexOf("await app.register(rateLimit");

  expect(limiterRegistration).toBeGreaterThan(-1);
  // Only hooks on the request path matter for limiter ordering. onClose/onReady
  // cleanups are registered wherever a resource is created (sometimes inside a
  // helper defined above the limiter) and never run for a request.
  for (const hook of [
    'app.addHook("onRequest"',
    'app.addHook("onResponse"',
    'app.addHook("preHandler"'
  ]) {
    expect(
      sourceText.indexOf(hook),
      `${hook} must remain behind the registered global limiter`
    ).toBeGreaterThan(limiterRegistration);
  }
});

it("enforces the configured default limit on routes without stricter overrides", async () => {
  const app = await createApp({
    config: {
      ...getApiConfig({}),
      apiRateLimitMax: 2
    },
    auth: {
      sessionSecret: "route-rate-limit-test-secret",
      devLogin: false,
      secureCookies: false
    }
  });

  try {
    const responses = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      responses.push(await app.inject({ method: "GET", url: "/healthz" }));
    }

    expect(responses.map((response) => response.statusCode)).toEqual([200, 200, 429]);
    expect(responses.find((response) => response.statusCode === 429)?.json()).toMatchObject({
      error: {
        code: "RATE_LIMITED",
        requestId: expect.stringMatching(/^req:/)
      }
    });
  } finally {
    await app.close();
  }
}, SLOW_TEST_TIMEOUT_MS);

it("applies the global limiter to routes registered by domain modules", async () => {
  // Domain modules (files, databases, t3code, Space Control, memory graph,
  // worktrees, Harness) rely on the global limiter instead of per-route options.
  // Prove that it reaches each module: the third request inside the window is
  // rejected before authentication or the handler runs.
  const app = await createApp({
    config: {
      ...getApiConfig({}),
      apiRateLimitMax: 2
    },
    auth: {
      sessionSecret: "route-rate-limit-module-test-secret",
      devLogin: false,
      secureCookies: false
    }
  });
  try {
    await app.ready();
    const moduleRoutes = [
      "/api/files/list",
      "/api/databases/connections",
      "/api/t3code/sessions",
      "/api/control/v1/capabilities",
      "/api/admin/memory/graph/overview",
      "/api/worktrees",
      "/api/harness/healthz"
    ];
    const unlimited: string[] = [];
    for (const url of moduleRoutes) {
      expect(app.hasRoute({ method: "GET", url }), `${url} is registered`).toBe(true);
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 3; attempt += 1) {
        statuses.push((await app.inject({ method: "GET", url, remoteAddress: `198.51.100.${moduleRoutes.indexOf(url) + 1}` })).statusCode);
      }
      if (statuses[2] !== 429) unlimited.push(`${url}: ${statuses.join(",")}`);
    }
    expect(unlimited, `Module routes outside the global limiter:\n${unlimited.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
  }
}, SLOW_TEST_TIMEOUT_MS);

