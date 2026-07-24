import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { getApiConfig } from "../src/config.js";

const routeMethods = new Set(["delete", "get", "patch", "post", "put"]);
const namedRateLimitOptions = new Set([
  "defaultRouteRateLimitOptions",
  "defaultWebsocketRateLimitOptions"
]);

it("declares an explicit CodeQL-visible rate limit on every Fastify route", async () => {
  const appPath = fileURLToPath(new URL("../src/app.ts", import.meta.url));
  const sourceText = await readFile(appPath, "utf8");
  const source = ts.createSourceFile(appPath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const missing: string[] = [];

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
        missing.push(`${line}: ${route}`);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  expect(missing, `Routes without explicit rate limits:\n${missing.join("\n")}`).toEqual([]);
});

it("registers the global limiter before request authentication and lifecycle hooks", async () => {
  const appPath = fileURLToPath(new URL("../src/app.ts", import.meta.url));
  const sourceText = await readFile(appPath, "utf8");
  const limiterRegistration = sourceText.indexOf("await app.register(rateLimit");

  expect(limiterRegistration).toBeGreaterThan(-1);
  for (const hook of [
    'app.addHook("onRequest"',
    'app.addHook("onResponse"',
    'app.addHook("onClose"',
    'app.addHook("onReady"',
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
});
