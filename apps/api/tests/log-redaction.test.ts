import { Writable } from "node:stream";
import Fastify from "fastify";
import { expect, it } from "vitest";
import { apiLoggerOptions, apiLogRedaction, redactSecretText } from "../src/request-logging.js";

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
