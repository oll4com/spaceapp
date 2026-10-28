// Nous and the Monitoring Copilot (plan clipboard:xkCJ9CeYZq4D): Nous briefs the pane, reads its state (firing alerts, whether the
// collector answers), sees and answers its questions, lists its held self-healing changes for the operator (never "Always approve"),
// and controls its run through the same routes the pane uses.
import { describe, expect, it } from "vitest";
import { nousDecisionKind, type NousDecision } from "@space/contracts";
import { InMemoryMonitoringCopilotRepository } from "@space/db";
import { InMemorySpaceStore } from "@space/runtime";
import { copilotDeps } from "../src/nous/wiring.js";
import { createCopilotControl } from "../src/nous/copilot-control.js";
import { createMonitoringCopilotService } from "../src/monitoring-copilot/service.js";
import type { MonitoringCollector } from "../src/monitoring-copilot/collector.js";

const collector: MonitoringCollector = {
  alerts: async () => [{ fingerprint: "0f6830bc2f489a7d", labels: { alertname: "OpenwrtHttpsProbeDown", severity: "critical", instance: "192.168.10.1:443" }, annotations: {}, startsAt: "2026-10-25T10:00:00Z" }],
  guardian: async () => [], promQuery: async () => ({ resultType: "vector", series: [], truncated: false }), lokiQuery: async () => ({ resultType: "vector", series: [], truncated: false }), targets: async () => []
};

function fixture() {
  const store = new InMemorySpaceStore();
  const room = store.createRoom({ name: "Monitoring", initialPaneCount: 0 }, "trace:room", "user:operator");
  const pane = store.createPane({ roomId: room.id, title: "Monitoring Copilot", mode: "MONITORING_COPILOT", terminalRuntimeId: "cli:claude" });
  const monitoring = createMonitoringCopilotService({ repository: new InMemoryMonitoringCopilotRepository(), collector,
    store: { updateMonitoringCopilotMetadata: (id, metadata) => store.updateMonitoringCopilotMetadata(id, metadata), listRooms: () => [{ id: room.id, ownerUserId: "user:operator" }], listPanes: (roomId, includeClosed) => store.listPanes(roomId, includeClosed) } });
  const deps = copilotDeps({ copilots: { monitoring }, store } as never, async (_owner, mode) => mode === "MONITORING_COPILOT" ? [pane] : [])!;
  return { store, pane, monitoring, deps };
}

describe("Nous and the Monitoring Copilot", () => {
  it("briefs the pane, reads its alerts and the collector's state, and answers its questions", async () => {
    const { pane, monitoring, deps } = fixture();
    await monitoring.watch();
    expect(await deps.brief("user:operator", pane, "Why does OpenWrt TH fail its HTTPS probe since 10:00?")).toContain("The Monitoring Copilot has the brief");
    const question = await monitoring.ask("user:operator", pane, { question: "Is the Thailand office closed today?", options: ["Closed", "Open"] });
    const items = await deps.items("user:operator");
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({ copilot: "MONITORING", kind: "QUESTION", id: question.id, detail: "Closed / Open" }),
      expect.objectContaining({ copilot: "MONITORING", kind: "BRIEF_PENDING", title: "Why does OpenWrt TH fail its HTTPS probe since 10:00?" })]));
    const state = JSON.parse(await deps.state("user:operator", pane));
    expect(state).toMatchObject({ run: { openQuestions: 1, pendingBriefs: 1 }, summary: { firing: { CRITICAL: 1 }, collector: { reachable: true } } });
    expect(state.summary.top[0]).toMatchObject({ alertname: "OpenwrtHttpsProbeDown", instance: "192.168.10.1:443" });
    await deps.answerQuestion("user:operator", { copilot: "MONITORING", questionId: question.id, paneId: null, answer: "Closed until Monday" });
    expect((await monitoring.items("user:operator", pane)).questions).toEqual([]);
    await expect(deps.answerQuestion("user:operator", { copilot: "MONITORING", questionId: question.id, paneId: null, answer: "again" })).rejects.toThrow(/not waiting/);
  });

  it("lists a held change as the operator's to decide, never as an answer of its own or an Always approve kind", async () => {
    const { pane, monitoring, deps } = fixture();
    await monitoring.watch();
    const alertId = (await monitoring.alerts("user:operator", {}))[0]!.id;
    const held = await monitoring.beginAction("user:operator", pane, { target: "pve", alertIds: [alertId], kind: "HOST_REBOOT", summary: "Reboot pve", commands: "ssh pve reboot", backup: "", rollback: "none: a reboot" });
    if (held.gate !== "ASK") throw new Error("expected ASK");
    const items = await deps.items("user:operator");
    const review = items.find((item) => item.kind === "REVIEW")!;
    expect(review).toMatchObject({ copilot: "MONITORING", id: held.reviewId, paneId: pane.id, title: "HOST_REBOOT on pve: Reboot pve" });
    expect(review.detail).toContain("Only a person decides");
    expect(review.detail).toContain("copilot: MONITORING, item: REVIEW");
    expect(JSON.parse(await deps.state("user:operator", pane))).toMatchObject({ run: { openReviews: 1 }, reviews: [expect.objectContaining({ id: held.reviewId })] });
    await expect(deps.answerQuestion("user:operator", { copilot: "MONITORING", questionId: held.reviewId, paneId: null, answer: "yes" })).rejects.toThrow(/space_ask_operator/);
    const decision = { category: "DIRECTION", action: { type: "COPILOT", copilot: "MONITORING", item: "REVIEW", itemId: held.reviewId, paneId: pane.id, decision: "approve" } } as unknown as NousDecision;
    expect(nousDecisionKind(decision)).toBeNull();
  });

  it("controls the run and pauses the copilot through the pane's own routes", async () => {
    const { pane } = fixture();
    const calls: string[] = [];
    const control = createCopilotControl({ store: { getActivePaneCliSession: async () => null, listPaneCliSessions: async () => [] } as never,
      invoke: async (_owner, method, url, payload) => {
        calls.push(`${method} ${url}`);
        if (method === "GET") return { metadata: { version: 1, settings: { paused: false } } };
        return url.includes("/run/") ? { status: "RUNNING", kickoffSent: true } : { ok: Boolean(payload) };
      } });
    expect(await control("user:operator", pane, "run_start")).toContain("RUNNING");
    expect(await control("user:operator", pane, "pause")).toContain("Paused");
    const at = `/api/panes/${encodeURIComponent(pane.id)}/monitoring-copilot`;
    expect(calls).toEqual([`POST ${at}/run/start`, `GET ${at}/settings`, `PUT ${at}/settings`]);
  });
});
