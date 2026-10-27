import { T3AssetHandles, T3GatewayError, type T3HandleScope } from "./gateway-policy.js";

// Fail-closed: only these RPC methods reach T3. Space manages the T3 runtime, pairing, the CLIs it provides and provider
// sign-in (providers use the accounts signed in once in Space), so sign-in, sign-out, ChatGPT handoff, cloud, devices and
// self-updates are not listed (provider.auth.subscribe stays readable for status). T3's own pinned, hash-verified
// installs remain. The first list is T3 0.0.45's methods without those, so a rollback keeps working.
const T3_0_0_45_METHODS = [
  "agentSessions.import", "agentSessions.scan",
  "assets.createUrl",
  "attachments.createUploadUrl", "attachments.delete",
  "filesystem.browse",
  "git.preparePullRequestThread", "git.resolvePullRequest", "git.runStackedAction",
  "orchestration.dispatchCommand", "orchestration.getArchivedShellSnapshot", "orchestration.getFullThreadDiff",
  "orchestration.getTurnDiff", "orchestration.getWorkflowScript", "orchestration.searchThreads",
  "orchestration.subscribeShell", "orchestration.subscribeThread",
  "preview.close", "preview.list", "preview.navigate", "preview.open", "preview.refresh", "preview.reportStatus",
  "preview.resize",
  "previewAutomation.connect", "previewAutomation.focusHost", "previewAutomation.respond",
  "projectClone.cancel", "projectClone.retry", "projectClone.start",
  "projects.add", "projects.createNew", "projects.ensureScratch", "projects.list", "projects.listEntries",
  "projects.readFile", "projects.remove", "projects.searchContents", "projects.searchEntries", "projects.writeFile",
  "provider.auth.subscribe", "provider.codex.auth-callback.subscribe", "provider.consumeResetCredit",
  "provider.install.cancel", "provider.install.remove", "provider.install.start", "provider.install.subscribe",
  "provider.uploadFeedback",
  "pullRequests.activity", "pullRequests.comment", "pullRequests.detail", "pullRequests.diffFileContents",
  "pullRequests.filesViewed", "pullRequests.invalidate", "pullRequests.labelCandidates",
  "pullRequests.linkedThreads", "pullRequests.list", "pullRequests.listStats", "pullRequests.preview",
  "pullRequests.replyToThread", "pullRequests.requestReviewers", "pullRequests.reviewerCandidates",
  "pullRequests.routing", "pullRequests.routingIdentity", "pullRequests.runAction", "pullRequests.setFilesViewed",
  "pullRequests.setLabels", "pullRequests.setReaction", "pullRequests.setThreadResolution", "pullRequests.stack",
  "pullRequests.submitReview", "pullRequests.subscribeRefreshes", "pullRequests.summary",
  "pullRequests.threadComments", "pullRequests.update", "pullRequests.updateComment",
  "review.getDiffFileContents", "review.getDiffPreview",
  "server.discoverSourceControl", "server.getBackgroundPolicy", "server.getConfig", "server.getHostResources",
  "server.getProcessDiagnostics", "server.getProcessResourceHistory", "server.getResourceTelemetryHistory",
  "server.getSettings", "server.getTraceDiagnostics", "server.getUsageSummary", "server.probe",
  "server.refreshProviders", "server.refreshUsageRates", "server.removeKeybinding", "server.reportClientActivity",
  "server.reportHostPowerState", "server.retryResourceTelemetry", "server.updateSettings", "server.upsertKeybinding",
  "shell.openInEditor",
  "sourceControl.cloneRepository", "sourceControl.lookupRepository", "sourceControl.publishRepository",
  "subscribeAuthAccess", "subscribeBackgroundPolicy", "subscribeDeviceState", "subscribeDiscoveredLocalServers",
  "subscribePreviewEvents", "subscribeProjectClones", "subscribeResourceTelemetry", "subscribeServerConfig",
  "subscribeServerLifecycle", "subscribeTerminalEvents", "subscribeTerminalMetadata", "subscribeVcsStatus",
  "subscribeWorktreeSetup",
  "terminal.attach", "terminal.clear", "terminal.close", "terminal.open", "terminal.resize", "terminal.restart",
  "terminal.write",
  "vcs.createRef", "vcs.createWorktree", "vcs.init", "vcs.listRefs", "vcs.pull", "vcs.refreshStatus",
  "vcs.removeWorktree", "vcs.switchRef",
  "worktreeSetup.cancel",
];
// T3 0.1.0 adds 46 methods. Only the ones its chat was shown to send on a local T3 0.1.0 server while opening a project
// and running a thread with a CLI provider are allowed (plan clipboard:Jtg8SRU6whYd, 2026-10-19). Refused in any case
// (operator decision 2026-10-18): ACP-registry installs and logins, scheduled tasks and webhook tokens, storage cleanup,
// the OTLP endpoint check, MCP apps, secret answers.
const T3_0_1_0_CHAT_METHODS = [
  "orchestration.launchThread",
];
const allowed: ReadonlySet<string> = new Set([...T3_0_0_45_METHODS, ...T3_0_1_0_CHAT_METHODS]);
type Message = Record<string, any>;
function messages(raw: string): { batch: boolean; messages: Message[] } {
  const value: unknown = JSON.parse(raw);
  const list = Array.isArray(value) ? value : [value];
  if (list.length > 128 || !list.every(item => item && typeof item === "object" && typeof item._tag === "string")) throw new T3GatewayError(400, "T3_RPC_INVALID");
  return { batch: Array.isArray(value), messages: list };
}

// Only the two pinned RPC schemas returning signed URLs are transformed.
// Arbitrary text, files, and stream chunks are never searched or rewritten.
export class T3RpcBoundary {
  private readonly pending = new Map<string, string>();
  constructor(private readonly handles: T3AssetHandles, private readonly scope: T3HandleScope) {}
  client(raw: string, reject: (response: string) => void = () => {}): string | null {
    const parsed = messages(raw);
    const forwarded: Message[] = [];
    for (const message of parsed.messages) {
      if (message._tag !== "Request") {
        if (!["Ack", "Interrupt", "Ping", "Eof"].includes(message._tag)) throw new T3GatewayError(400, "T3_RPC_INVALID");
        forwarded.push(message);
        continue;
      }
      const id = String(message.id);
      if (!["string", "number"].includes(typeof message.id) || !/^[A-Za-z0-9_-]{1,128}$/.test(id) || typeof message.tag !== "string" ||
          this.pending.has(id) || this.pending.size >= 1024 || message.isNotification) throw new T3GatewayError(403, "T3_RPC_REJECTED");
      if (!allowed.has(message.tag)) {
        reject(JSON.stringify({ _tag: "Exit", requestId: message.id, exit: { _tag: "Failure", cause: [{ _tag: "Fail", error: {
          _tag: "EnvironmentAuthorizationError", message: "This operation is managed by Space.", requiredScope: "access:write",
        } }] } }));
        continue;
      }
      this.pending.set(id, message.tag);
      // Request-level auth comes from the verified upgrade, never RPC headers.
      message.headers = [];
      forwarded.push(message);
    }
    return forwarded.length ? JSON.stringify(parsed.batch ? forwarded : forwarded[0]) : null;
  }
  server(raw: string): string {
    const parsed = messages(raw); let changed = false;
    for (const message of parsed.messages) {
      if (message._tag !== "Exit") continue;
      const id = String(message.requestId), method = this.pending.get(id);
      this.pending.delete(id);
      if (method !== "assets.createUrl" && method !== "attachments.createUploadUrl") continue;
      if (message.exit?._tag !== "Success") continue;
      const value = message.exit.value;
      if (!value || typeof value.relativeUrl !== "string" || typeof value.expiresAt !== "number") throw new T3GatewayError(502, "T3_ASSET_INVALID");
      value.relativeUrl = this.handles.issue(this.scope, value.relativeUrl, value.expiresAt,
        method === "assets.createUrl" ? "read" : "upload").slice(1);
      changed = true;
    }
    return changed ? JSON.stringify(parsed.batch ? parsed.messages : parsed.messages[0]) : raw;
  }
}
