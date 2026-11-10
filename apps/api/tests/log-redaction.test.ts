import { Writable } from "node:stream";
import Fastify from "fastify";
import { expect, it } from "vitest";
import { apiLoggerOptions, apiLogRedaction, redactSecretText } from "../src/request-logging.js";

it("redacts nested link URLs from incoming request logs without changing handler input (OBS-006)", async () => {
  const lines: string[] = [];
  const stream = new Writable({ write(chunk, _encoding, callback) { lines.push(String(chunk)); callback(); } });
  const app = Fastify({ logger: apiLoggerOptions(stream) });
  // Exercise the production logger without invoking link inspection or any upstream network request.
  app.get("/api/links/inspect", async (request) => ({ query: request.query, url: request.url }));
  const nestedUrl = "https://obs006-user:obs006-password%3Aprobe@private.example.test/private-path?accessToken=obs006-token%2Fprobe#private-fragment";
  const url = `/api/links/inspect?${new URLSearchParams({ url: nestedUrl, safe: "kept" })}`;
  try {
    const response = await app.inject({ method: "GET", url });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ query: { url: nestedUrl, safe: "kept" }, url });
  } finally {
    await app.close();
  }

  const output = lines.join("");
  const entries = output.trim().split("\n").map((line) => JSON.parse(line));
  const incoming = entries.find((entry) => entry.msg === "incoming request");
  expect(incoming?.req.url).toBe("/api/links/inspect?url=%5BREDACTED%5D&safe=kept");
  for (const secret of ["obs006-user", "obs006-password:probe", "obs006-token/probe", "private.example.test", "private-path", "private-fragment"]) {
    for (const value of [secret, encodeURIComponent(secret), encodeURIComponent(encodeURIComponent(secret))]) {
      expect(output, value).not.toContain(value);
    }
  }
});

it("redacts credentials in structured API log objects", async () => {
  const lines: string[] = [];
  const stream = new Writable({ write(chunk, _encoding, callback) { lines.push(String(chunk)); callback(); } });
  const app = Fastify({ logger: { level: "info", redact: apiLogRedaction, stream } });
  await app.ready();
  app.log.info({
    password: "top-level-password",
    token: "top-level-token",
    body: { password: "body-password", apiKey: "body-api-key", note: "kept" },
    err: { config: { headers: { authorization: "Bearer upstream-token" } } },
    provider: { credentials: { secret: "nested-secret", token: "nested-token" }, accessToken: "access-token" },
    session: { refreshToken: "refresh-token", clientSecret: "client-secret", userId: "user:visible" },
    req: { headers: { "x-space-control-token": "ctl-secret-1", "x-space-cli-browser-token": "bridge-secret-2", "x-space-cli-agent-files-token": "files-secret-3" } },
    upstream: { headers: { "x-space-control-token": "ctl-secret-4" } }
  }, "credential redaction probe");
  await app.close();
  const output = lines.join("");
  for (const secret of ["top-level-password", "top-level-token", "body-password", "body-api-key", "upstream-token",
    "nested-secret", "nested-token", "access-token", "refresh-token", "client-secret", "ctl-secret-1", "bridge-secret-2", "files-secret-3", "ctl-secret-4"]) {
    expect(output, secret).not.toContain(secret);
  }
  expect(output).toContain("[REDACTED]");
  expect(output).toContain("kept");
  expect(output).toContain("user:visible");
});

it("logs an error's type, code, status, message and stack only, with credential-shaped text removed (1.1.8)", async () => {
  const lines: string[] = [];
  const stream = new Writable({ write(chunk, _encoding, callback) { lines.push(String(chunk)); callback(); } });
  const app = Fastify({ logger: apiLoggerOptions(stream) });
  await app.ready();
  const upstream = Object.assign(new Error("upstream said: invalid key sk-live-error-secret-1234 for https://bot:hunter2pass@api.example.test/v1, Bearer abcdefghij123"), {
    code: "E_UPSTREAM", statusCode: 401, config: { headers: { "x-api-key": "header-secret-5678" }, data: "request body secret" },
    cause: new Error("token=cause-secret-9999")
  });
  app.log.error({ err: upstream, event: "probe" }, "error serializer probe");
  await app.close();
  const output = lines.join("");
  for (const secret of ["sk-live-error-secret-1234", "hunter2pass", "abcdefghij123", "header-secret-5678", "request body secret", "cause-secret-9999"]) {
    expect(output, secret).not.toContain(secret);
  }
  const entry = JSON.parse(lines.find((line) => line.includes("error serializer probe"))!);
  expect(entry.err).toMatchObject({ type: "Error", code: "E_UPSTREAM", statusCode: 401 });
  expect(entry.err.message).toContain("upstream said: invalid key [REDACTED] for https://[REDACTED]@api.example.test/v1, Bearer [REDACTED]");
  expect(entry.err.cause.message).toBe("token=[REDACTED]");
  expect(entry.err.config).toBeUndefined();
  expect(redactSecretText('{"password": "pw-secret-1"} token expired')).toBe('{"password": "[REDACTED]"} token expired');
  // Paths and digests in stacks stay readable.
  expect(redactSecretText("at /opt/spaceapp/apps/api/src/app.ts:12 image sha256:" + "a".repeat(64))).toBe("at /opt/spaceapp/apps/api/src/app.ts:12 image sha256:" + "a".repeat(64));
});
