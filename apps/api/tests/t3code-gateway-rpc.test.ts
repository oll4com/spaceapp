import { expect, it } from "vitest";
import { T3RpcBoundary } from "../src/t3code/gateway-rpc.js";
import { T3AssetHandles } from "../src/t3code/gateway-policy.js";
it("rejects managed administration with a typed failure while keeping ordinary RPC usable", () => {
  const rpc = new T3RpcBoundary(new T3AssetHandles(), { sessionId: "synthetic", paneId: "pane:owned123" });
  const message = { _tag: "Request", id: "1", tag: "server.updateServer", payload: {}, headers: [] };
  // Space manages the runtime and the CLIs it provides; sandboxed package
  // manager updates of a provider CLI are refused too.
  // Provider sign-in belongs to Space too: the providers use the accounts
  // signed in once in Space, and a T3 sign-out must not remove them.
  ["server.updateServer", "server.updateProvider", "server.signalProcess", "auth.pairingToken", "cloud.link", "devices.list",
    "provider.auth.start", "provider.auth.complete", "provider.auth.logout", "provider.chatgpt.handoff.subscribe"].forEach((tag, index) => {
    const denied: string[] = [];
    expect(rpc.client(JSON.stringify({ ...message, id: `d${index}`, tag }), value => denied.push(value)), tag).toBeNull();
    expect(JSON.parse(denied[0]!).exit.cause[0].error._tag, tag).toBe("EnvironmentAuthorizationError");
  });
  expect(JSON.parse(rpc.client(JSON.stringify({ ...message, tag: "server.getConfig" }), () => {})!)).toEqual({ ...message, tag: "server.getConfig" });
});
it("keeps T3's verified provider installs, provider status and settings usable", () => {
  const rpc = new T3RpcBoundary(new T3AssetHandles(), { sessionId: "synthetic", paneId: "pane:owned123" });
  ["provider.install.subscribe", "provider.install.start", "provider.install.cancel", "provider.install.remove", "provider.auth.subscribe",
    "server.updateSettings", "server.refreshProviders"].forEach((tag, index) => {
    const message = { _tag: "Request", id: `p${index}`, tag, payload: {}, headers: [{ name: "authorization", value: "never" }] };
    expect(JSON.parse(rpc.client(JSON.stringify(message), () => { throw Error(`${tag} was refused`); })!), tag).toEqual({ ...message, headers: [] });
  });
});
it("does not allow a second request id to replace a pending signed URL transformation", () => {
  const rpc = new T3RpcBoundary(new T3AssetHandles(), { sessionId: "synthetic", paneId: "pane:owned123" });
  const message = { _tag: "Request", id: "1", tag: "assets.createUrl", payload: {}, headers: [] };
  rpc.client(JSON.stringify(message));
  expect(() => rpc.client(JSON.stringify({ ...message, tag: "server.getConfig" }))).toThrow();
});
it("is fail-closed: refuses T3 0.1.0's ACP-registry, scheduled-task, cleanup, OTLP, MCP-app and secret methods and any unknown method", () => {
  const rpc = new T3RpcBoundary(new T3AssetHandles(), { sessionId: "synthetic", paneId: "pane:owned123" });
  const refused = ["server.acceptAcpRegistryUrlAuth", "server.deleteAcpRegistrySession", "server.disableAcpRegistryProvider", "server.importAcpRegistrySession",
    "server.listAcpRegistryProviders", "server.listAcpRegistrySessions", "server.logoutAcpRegistry", "server.prepareAcpRegistryAgent", "server.searchAcpRegistry",
    "server.setAcpRegistryProvider", "server.uninstallAcpRegistryManagedBinary", "scheduledTasks.delete", "scheduledTasks.getWebhookDelivery", "scheduledTasks.list",
    "scheduledTasks.listWebhookDeliveries", "scheduledTasks.rotateWebhookToken", "scheduledTasks.runNow", "scheduledTasks.setEnabled", "scheduledTasks.subscribe",
    "scheduledTasks.upsert", "server.runStorageCleanup", "server.getStorageCleanupReport", "server.checkOtlpEndpoint", "mcpApps.callTool", "mcpApps.readResource",
    "mcpApps.toolInfo", "mcpApps.updateModelContext", "secrets.answerRequest", "preview.adjust", "preview.clearProfile", "preview.reportProfiles",
    "pullRequests.generateReviewGuide", "no.such.method", "server.getConfig.extra"];
  refused.forEach((tag, index) => {
    const answers: string[] = [];
    expect(rpc.client(JSON.stringify({ _tag: "Request", id: `n${index}`, tag, payload: {}, headers: [] }), value => answers.push(value)), tag).toBeNull();
    expect(JSON.parse(answers[0]!).exit.cause[0].error._tag, tag).toBe("EnvironmentAuthorizationError");
  });
  // T3 0.1.0's chat starts a thread with orchestration.launchThread.
  for (const tag of ["orchestration.dispatchCommand", "orchestration.subscribeShell", "orchestration.subscribeThread", "projects.list", "terminal.open", "git.runStackedAction",
    "orchestration.launchThread"]) {
    const message = { _tag: "Request", id: `a-${tag.replace(/\./g, "_")}`, tag, payload: {}, headers: [] };
    expect(JSON.parse(rpc.client(JSON.stringify(message), () => { throw Error(`${tag} was refused`); })!), tag).toEqual(message);
  }
});
