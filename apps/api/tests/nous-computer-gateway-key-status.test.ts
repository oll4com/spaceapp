import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { TLSSocket } from "node:tls";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGatewayKeyStatus, gatewayTenantId } from "../src/computer/gateway-key-status.js";

// The API's mTLS client for the gateway's POST /tenants/:id/status, against a throwaway CA (openssl) and a listener with the gateway's TLS options.
describe("Nous Gateway key status client (mTLS)", () => {
  const dir = mkdtempSync(join(tmpdir(), "api-ngw-pki-"));
  const at = (name: string) => join(dir, name);
  const ssl = (...args: string[]) => execFileSync("openssl", args, { stdio: "pipe" });
  const ec = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes"];
  ssl("req", "-x509", ...ec, "-keyout", at("ca.key"), "-out", at("ca.crt"), "-subj", "/CN=ngw-ca", "-days", "1");
  writeFileSync(at("san.ext"), "subjectAltName=IP:127.0.0.1\n");
  const issue = (name: string, subject: string) => {
    ssl("req", ...ec, "-keyout", at(`${name}.key`), "-out", at(`${name}.csr`), "-subj", subject);
    ssl("x509", "-req", "-in", at(`${name}.csr`), "-CA", at("ca.crt"), "-CAkey", at("ca.key"), "-CAcreateserial", "-out", at(`${name}.crt`), "-days", "1",
      ...(name === "server" ? ["-extfile", at("san.ext")] : []));
    return { cert: readFileSync(at(`${name}.crt`)), key: readFileSync(at(`${name}.key`)) };
  };
  const ca = readFileSync(at("ca.crt")), server = issue("server", "/CN=ngw-gateway-admin"), api = issue("api", "/OU=service/CN=space-api");
  const seen: Array<{ cn: string; url?: string; body: unknown }> = [];
  let answer = 200, port = 0, listener: Server;

  beforeAll(async () => {
    listener = createServer({ ...server, ca, requestCert: true, rejectUnauthorized: true, minVersion: "TLSv1.3" }, (req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const subject = (req.socket as TLSSocket).getPeerCertificate().subject as unknown as Record<string, string>;
        seen.push({ cn: `${subject.OU}:${subject.CN}`, url: req.url, body: JSON.parse(body) });
        res.writeHead(answer, { "content-type": "application/json" }).end(answer === 200 ? '{"keys":1}' : '{"error":{"code":"invalid_request","message":"id: bad"}}');
      });
    });
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    port = (listener.address() as { port: number }).port;
  });
  afterAll(async () => {
    await new Promise((resolve) => listener.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });

  it("maps a Space tenant id onto the gateway's id alphabet one to one", () => {
    expect(gatewayTenantId("tenant:Ab_-9xYz0123")).toBe("tenant.Ab_-9xYz0123");
    expect(gatewayTenantId("tenant:Ab_-9xYz0123")).toMatch(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/);
  });

  it("POSTs the status with the service certificate and fails on a refusal or a client without a certificate", async () => {
    const keys = createGatewayKeyStatus({ url: `https://127.0.0.1:${port}`, ca, ...api });
    await keys.setStatus("tenant:Ab_-9xYz0123", "FROZEN", "account suspended by staff");
    expect(seen).toEqual([{ cn: "service:space-api", url: "/tenants/tenant.Ab_-9xYz0123/status", body: { status: "FROZEN", reason: "account suspended by staff" } }]);
    answer = 400;
    await expect(keys.setStatus("tenant:x", "ACTIVE", "reopened")).rejects.toThrow(/refused ACTIVE for tenant:x: 400 id: bad/);
    answer = 200;
    const noCert = createGatewayKeyStatus({ url: `https://127.0.0.1:${port}/`, ca, cert: "", key: "" });
    await expect(noCert.setStatus("tenant:x", "ACTIVE", "reopened")).rejects.toThrow();
    expect(seen).toHaveLength(2);
    expect(() => createGatewayKeyStatus({ url: "http://127.0.0.1:1", ca, ...api })).toThrow(/https/);
  });
});
