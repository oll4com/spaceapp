import { describe, expect, it } from "vitest";
import * as policy from "../src/t3code/gateway-policy.js";

describe("T3 pane gateway boundaries", () => {
  it("accepts a pane namespace and preserves a bounded safe query", () => {
    expect(policy.parseT3GatewayPath("/api/t3code/panes/pane:owned123/app/api/orchestration/shell?since=10")).toEqual({
      paneId: "pane:owned123", basePath: "/api/t3code/panes/pane:owned123/app/", upstreamPath: "/api/orchestration/shell?since=10",
    });
  });
  it.each([
    "/api/t3code/panes/pane:owned123/app/../auth/session",
    "/api/t3code/panes/pane:owned123/app/%2e%2e/secrets",
    "/api/t3code/panes/pane:owned123/app/%252e%252e/secrets",
    "/api/t3code/panes/pane:owned123/app/api%2fsecret",
    "/api/t3code/panes/pane:owned123/app/\\evil",
    "/api/t3code/panes/pane:owned123/app//evil.test",
    "/api/t3code/panes/pane:owned123/app/ws?ticket=secret",
    "/api/t3code/panes/pane:owned123/app/api?target=https://evil.test",
    "/api/t3code/panes/pane:owned123/app/%00",
  ])("rejects ambiguous or credential-bearing path %s", path => {
    expect(() => policy.parseT3GatewayPath(path)).toThrow();
  });
  it("requires an explicit mapping for HTTP methods and privileged endpoints", () => {
    expect(policy.isAllowedT3Http("GET", "/api/orchestration/snapshot")).toBe(true);
    expect(policy.isAllowedT3Http("POST", "/api/orchestration/dispatch")).toBe(true);
    expect(policy.isAllowedT3Http("POST", "/api/observability/v1/traces")).toBe(true);
    expect(policy.isAllowedT3Http("GET", "/api/observability/v1/traces")).toBe(false);
    expect(policy.isAllowedT3Http("GET", "/settings/providers")).toBe(true);
    expect(policy.isAllowedT3Http("GET", "/assets/index-abc123.js")).toBe(true);
    for (const path of ["/oauth/token", "/api/auth/browser-session", "/api/auth/clients", "/api/connect/mint-credential", "/helper/anything", "/api/unknown", "/assets/index.js.map"]) {
      expect(policy.isAllowedT3Http("GET", path)).toBe(false);
      expect(policy.isAllowedT3Http("POST", path)).toBe(false);
    }
    expect(policy.isAllowedT3Http("POST", "/settings/providers")).toBe(false);
  });
  it("allows the T3 0.1.0 thread reads and project mutations, never its MCP OAuth or inbound hook routes", () => {
    for (const path of ["/api/orchestration/threads/thread_1/bounded", "/api/orchestration/threads/thread_1/history?cursor=abc&limit=50",
      "/api/orchestration/threads/thread_1/transcript", "/api/orchestration/shell", "/api/orchestration/threads/thread_1"]) {
      expect(policy.isAllowedT3Http("GET", path), path).toBe(true);
      expect(policy.isAllowedT3Http("POST", path), path).toBe(false);
    }
    expect(policy.isAllowedT3Http("POST", "/api/projects/mutate")).toBe(true);
    expect(policy.isAllowedT3Http("GET", "/api/projects/mutate")).toBe(false);
    for (const path of ["/api/projects", "/api/orchestration/threads/thread_1/other", "/api/orchestration/threads/a/b/history",
      "/.well-known/oauth-protected-resource/mcp", "/oauth/mcp/authorize", "/oauth/mcp/approval", "/oauth/mcp/decision",
      "/oauth/mcp/register", "/oauth/mcp/token", "/v1/environments/env-real/hooks/wake"]) {
      expect(policy.isAllowedT3Http("GET", path), path).toBe(false);
      expect(policy.isAllowedT3Http("POST", path), path).toBe(false);
    }
  });
  it("serves the pinned upstream SPA routes and public icon files under a pane", () => {
    for (const path of ["/primary/thread_123", "/primary/thread:project:9f99c9ff-f72c-4dbe-af75-bc88aaac86a3:c69c5fb7-d17e-486a-9655-188b7d29554b",
      "/projects/project_123", "/pull-requests", "/usage", "/favicon-32x32.png", "/assets/iphone-duo-Cu4Xx1NH.glb"]) {
      expect(policy.isAllowedT3Http("GET", path), path).toBe(true);
    }
  });
  it("keeps read handles alive across the upstream 30 minute asset refresh interval", () => {
    let now = 1000;
    const handles = new policy.T3AssetHandles({ now: () => now });
    const scope = { sessionId: "session-a", paneId: "pane:owned123" };
    const path = handles.issue(scope, "/api/assets/private-token/file", now + 3_600_000, "read");
    now += 31 * 60_000;
    expect(handles.resolve(scope, path, "GET")).not.toBeNull();
    now += 30 * 60_000;
    expect(handles.resolve(scope, path, "GET")).toBeNull();
  });
  it("rewrites same-upstream redirects within the exact pane and rejects off-site redirects", () => {
    const base = "/api/t3code/panes/pane:owned123/app/";
    expect(policy.t3RedirectLocation("/settings/providers", base)).toBe(base + "settings/providers");
    expect(() => policy.t3RedirectLocation("https://other.test/", base)).toThrow();
    expect(() => policy.t3RedirectLocation("/oauth/token?token=secret", base)).toThrow();
  });
  it("binds sealed asset handles to session, pane, kind and expiry, and keeps them across API restarts", () => {
    let now = 1000;
    const handles = new policy.T3AssetHandles({ secret: "session-secret", now: () => now });
    const scope = { sessionId: "session-a", paneId: "pane:owned123" };
    const url = handles.issue(scope, "/api/assets/opaque-signed-value/file.bin", 2000, "read");
    expect(url).toMatch(/^\/__space\/assets\/[A-Za-z0-9_-]{40,}$/);
    expect(url).not.toContain("signed-value");
    expect(handles.resolve(scope, url, "GET")).toBe("/api/assets/opaque-signed-value/file.bin");
    // A restarted API derives the same key from the same session secret.
    expect(new policy.T3AssetHandles({ secret: "session-secret", now: () => now }).resolve(scope, url, "HEAD")).toBe("/api/assets/opaque-signed-value/file.bin");
    expect(new policy.T3AssetHandles({ secret: "other-secret", now: () => now }).resolve(scope, url, "GET")).toBeNull();
    expect(handles.resolve({ ...scope, paneId: "pane:sibling1" }, url, "GET")).toBeNull();
    expect(handles.resolve({ ...scope, sessionId: "session-b" }, url, "GET")).toBeNull();
    expect(handles.resolve(scope, url, "POST")).toBeNull();
    expect(handles.resolve(scope, url.replace("/__space/assets/", "/__space/uploads/"), "POST")).toBeNull();
    const token = url.slice(url.lastIndexOf("/") + 1);
    const tampered = token.slice(0, -2) + (token.endsWith("AA") ? "BB" : "AA");
    expect(handles.resolve(scope, url.replace(token, tampered), "GET")).toBeNull();
    expect(handles.resolve(scope, url + "?x=1", "GET")).toBeNull();
    const upload = handles.issue(scope, "/api/attachments/upload/slot_1", 900_000, "upload");
    expect(handles.resolve(scope, upload, "POST")).toBe("/api/attachments/upload/slot_1");
    expect(handles.resolve(scope, upload, "GET")).toBeNull();
    expect(() => handles.issue(scope, "/api/orchestration/shell", 3000, "read")).toThrow();
    now = 2000;
    expect(handles.resolve(scope, url, "GET")).toBeNull();
  });
});
