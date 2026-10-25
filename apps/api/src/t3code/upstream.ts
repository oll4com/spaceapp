import { request } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import { z } from "zod";
import { t3CodeRuntimeVersionSchema } from "@space/contracts";
import { T3_GATEWAY_SOCKET, T3GatewayError } from "./gateway-policy.js";
import type { T3PaneScope } from "./access.js";

// T3 0.1.0's own threads carry colons (thread:project:<id>:<id>, <command>:fork); user threads are UUIDs.
const id = z.string().regex(/^[A-Za-z0-9_:-]{1,200}$/);
const descriptor = z.object({ environmentId: id, serverVersion: z.string().min(1).max(64), orchestrationProtocolVersion: z.number().int().min(1).max(99).optional() });
const shell = z.object({
  projects: z.array(z.object({ id, title: z.string(), workspaceRoot: z.string().min(1).max(4096) })).max(100_000),
  threads: z.array(z.object({ id, projectId: id })).max(500_000)
});
export type T3Shell = z.infer<typeof shell>;
const sessions = z.object({
  // T3 0.0.45 marks a running thread with its provider session, T3 0.1.0 with activeRunId.
  threads: z.array(z.object({ session: z.object({ status: z.string().max(32), activeTurnId: z.string().max(128).nullable().optional() }).nullable().optional(),
    activeRunId: z.string().max(128).nullable().optional() })).max(500_000)
});
// T3 0.1.0 (orchestration protocol 2) requires this header on its orchestration reads; 0.0.45 (protocol 1) has none.
export const T3_ORCHESTRATION_PROTOCOL_HEADER = "x-t3-orchestration-protocol";
// The bridge needs only the verified identity, never pane or room content.
export type T3UpstreamIdentity = Pick<T3PaneScope, "userId" | "paneId" | "sessionId">;

// Private fixed transport. No browser-selected URL, shell command or host.
export class T3Upstream {
  // The orchestration protocol of the running T3, from its environment descriptor. Kept for a minute, so a T3 reinstall
  // (0.0.45 <-> 0.1.0) is noticed without asking the descriptor before every call.
  private protocolCache: { value: number; expires: number } | null = null;
  constructor(private readonly socketPath = T3_GATEWAY_SOCKET, private readonly timeoutMs = 10_000) {}
  private json(scope: T3UpstreamIdentity, path: string, command?: object, extraHeaders: Record<string, string> = {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const body = command === undefined ? undefined : Buffer.from(JSON.stringify(command));
      const fail = () => reject(new T3GatewayError(502, "T3_UPSTREAM_UNAVAILABLE"));
      const req = request({ socketPath: this.socketPath, path, method: body ? "POST" : "GET", headers: {
        "x-space-user-id": scope.userId, "x-space-pane-id": scope.paneId, "x-space-session-id": scope.sessionId,
        accept: "application/json", ...extraHeaders, ...(body ? { "content-type": "application/json", "content-length": body.length } : {})
      } }, res => {
        const chunks: Buffer[] = []; let size = 0;
        res.on("data", chunk => { size += chunk.length; if (size > 8 * 1024 * 1024) req.destroy(); else chunks.push(chunk); });
        res.once("error", fail); res.once("aborted", fail);
        res.once("end", () => {
          clearTimeout(timer);
          if (res.statusCode === 403 && path === "/__space/workspace/validate") { reject(new T3GatewayError(403, "T3_WORKSPACE_FORBIDDEN")); return; }
          if (res.statusCode !== 200) { fail(); return; }
          try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { fail(); }
        });
      });
      const timer = setTimeout(() => req.destroy(), this.timeoutMs); timer.unref();
      req.once("error", () => { clearTimeout(timer); fail(); }); req.end(body);
    });
  }
  async descriptor(scope: T3UpstreamIdentity) {
    const result = descriptor.safeParse(await this.json(scope, "/.well-known/t3/environment"));
    if (!result.success) throw new T3GatewayError(502, "T3_UPSTREAM_INVALID");
    this.protocolCache = { value: result.data.orchestrationProtocolVersion ?? 1, expires: Date.now() + 60_000 };
    return result.data;
  }
  async protocol(scope: T3UpstreamIdentity): Promise<number> {
    if (this.protocolCache && this.protocolCache.expires > Date.now()) return this.protocolCache.value;
    return (await this.descriptor(scope)).orchestrationProtocolVersion ?? 1;
  }
  private async orchestrationHeaders(scope: T3UpstreamIdentity): Promise<Record<string, string>> {
    const version = await this.protocol(scope);
    return version >= 2 ? { [T3_ORCHESTRATION_PROTOCOL_HEADER]: String(version) } : {};
  }
  async shell(scope: T3UpstreamIdentity): Promise<T3Shell> {
    const result = shell.safeParse(await this.json(scope, "/api/orchestration/shell", undefined, await this.orchestrationHeaders(scope)));
    if (!result.success) throw new T3GatewayError(502, "T3_UPSTREAM_INVALID");
    return result.data;
  }
  // Threads whose provider session is starting or running a turn.
  async activeRuns(scope: T3UpstreamIdentity): Promise<number> {
    const result = sessions.safeParse(await this.json(scope, "/api/orchestration/shell", undefined, await this.orchestrationHeaders(scope)));
    if (!result.success) throw new T3GatewayError(502, "T3_UPSTREAM_INVALID");
    return result.data.threads.filter(t => Boolean(t.activeRunId) ||
      Boolean(t.session && (["starting", "running"].includes(t.session.status) || Boolean(t.session.activeTurnId)))).length;
  }
  async createProject(scope: T3PaneScope, command: { type: "project.create"; commandId: string; projectId: string; title: string;
    workspaceRoot: string; createWorkspaceRootIfMissing: boolean; createdAt: string }) {
    // T3 0.1.0 replaced the orchestration dispatch route with project mutations (no createdAt).
    if (await this.protocol(scope) >= 2) {
      const { createdAt: _createdAt, ...mutation } = command;
      await this.json(scope, "/api/projects/mutate", mutation);
    } else await this.json(scope, "/api/orchestration/dispatch", command);
  }
  async workspace(scope: T3PaneScope, candidate: string, allowMissing = false) {
    const result = z.object({ path: z.string().min(1).max(4096).startsWith("/") }).safeParse(await this.json(scope, "/__space/workspace/validate", { path: candidate, ...(allowMissing ? { allowMissing: true } : {}) }));
    if (!result.success) throw new T3GatewayError(502, "T3_UPSTREAM_INVALID");
    return result.data.path;
  }
}

// The manifest lists every runtime file; parse it once per installed runtime.
let versionCache: { key: string; value: ReturnType<typeof t3CodeRuntimeVersionSchema.parse> } | null = null;
export async function installedT3Version(manifestPath = "/opt/spaceapp/var/cli-versions/t3code/current/runtime-manifest.json") {
  try {
    const resolved = await realpath(manifestPath), key = `${resolved}:${(await stat(resolved)).mtimeMs}`;
    if (versionCache?.key === key) return versionCache.value;
    const manifest = JSON.parse(await readFile(resolved, "utf8"));
    const value = t3CodeRuntimeVersionSchema.parse({ tag: manifest.source.tag, commit: manifest.source.commit,
      packageVersion: manifest.source.packageVersion, integrationRevision: manifest.source.integrationRevision, runtimeId: manifest.runtimeId });
    versionCache = { key, value };
    return value;
  } catch { return null; }
}

// Revision 6 (P08) reads the gateway's inline document bootstrap; earlier
// runtimes would open the binding again themselves.
export const T3_INLINE_BOOTSTRAP_REVISION = 6;
export async function t3InlineBootstrapSupported() {
  return ((await installedT3Version())?.integrationRevision ?? 0) >= T3_INLINE_BOOTSTRAP_REVISION;
}
