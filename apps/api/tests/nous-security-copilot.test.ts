// Nous and the Security Copilot (plan clipboard:8ce8_URHW9Dk step 7): Nous briefs the pane, reads its state, sees its questions and
// held changes, answers questions itself but never a held change (no "Always approve" for it either), and the security hotfix grant
// needs the operator's allowance and a running fix of a P0/P1 finding.
import { describe, expect, it, vi } from "vitest";
import { nousDecisionKind, type NousDecision } from "@space/contracts";
import { InMemoryNousRepository, InMemorySecurityCopilotRepository } from "@space/db";
import { InMemorySpaceStore } from "@space/runtime";
import { copilotDeps } from "../src/nous/wiring.js";
import { createSecurityCopilotService } from "../src/security-copilot/service.js";
import { createNousService, type NousServiceDeps } from "../src/nous/service.js";

function fixture(allowed = false) {
  const store = new InMemorySpaceStore();
  const room = store.createRoom({ name: "Security", initialPaneCount: 0 }, "trace:room", "user:operator");
  const pane = store.createPane({ roomId: room.id, title: "Security Copilot", mode: "SECURITY_COPILOT", terminalRuntimeId: "cli:claude" });
  const repository = new InMemorySecurityCopilotRepository();
  const grants: string[] = [];
  const security = createSecurityCopilotService({ repository, store: { updateSecurityCopilotMetadata: (id, metadata) => store.updateSecurityCopilotMetadata(id, metadata) },
    hotfix: { allowed: async () => allowed, grant: (_paneId, command) => { grants.push(command); return "approve"; } } });
  const deps = copilotDeps({ copilots: { security }, store } as never, async (_owner, mode) => mode === "SECURITY_COPILOT" ? [pane] : [])!;
  return { store, pane, repository, security, deps, grants };
}

describe("Nous and the Security Copilot", () => {
  it("shows a held change's age, and withdraws Nous's decision for it when the copilot supersedes it (R13-14)", async () => {
    // 29/10 13:17 BKK: a held restart whose target had been met stayed on the operator's card, and the operator pressed Approve.
    const { pane, security, deps, repository } = fixture();
    const host = await repository.upsertHost({ ownerUserId: "user:operator", alias: "local", label: "public-host", reach: "LOCAL", osFamily: "DEBIAN", osVersion: "13", kernel: "6.12", status: "ACTIVE", note: null });
    const asked = await security.beginAction("user:operator", pane, { hostId: host.id, findingIds: [], kind: "HOST_REBOOT", summary: "reboot", commands: "reboot", backup: "", rollback: "boot the previous kernel" }) as { actionId: string; reviewId: string };
    expect((await deps.items("user:operator")).find((item) => item.id === asked.reviewId)!.detail).toMatch(/^Held 0 min\. Only a person decides/);
    const nous = new InMemoryNousRepository();
    const service = createNousService({ repository: nous, runner: async () => ({ text: "ok", isError: false }), world: async () => ({ text: "world", overview: {} }),
      settings: async () => ({ enabled: false, maxTurnsPerHour: 20 }), notifications: { raise: vi.fn(async () => null), resolve: vi.fn(async () => 0) }, executeAction: vi.fn() } as unknown as NousServiceDeps);
    const decision = await nous.createDecision({ ownerUserId: "user:operator", category: "DIRECTION", title: "Approve the reboot?", body: "", options: [], recommendation: null, refs: {},
      action: { type: "COPILOT", copilot: "SECURITY", item: "REVIEW", itemId: asked.reviewId, paneId: pane.id, decision: "approve" } });
    security.onSuperseded((owner, reviewId, evidence) => { void service.withdrawSuperseded(owner, reviewId, evidence); });
    await security.finishAction("user:operator", pane, asked.actionId, { status: "SUPERSEDED", evidence: "booted 12:18 into the patched kernel" });
    await vi.waitFor(async () => expect(await nous.getDecision("user:operator", decision.id)).toMatchObject({ status: "CANCELLED", answer: "Withdrawn by Space: superseded" }));
    expect((await deps.items("user:operator")).some((item) => item.id === asked.reviewId)).toBe(false);
    await service.idle("user:operator");
  });

  it("briefs the pane, reads its state and lists its questions and held changes", async () => {
    const { pane, security, deps, repository } = fixture();
    expect(await deps.brief("user:operator", pane, "Check every PHP build for PHP2Shell")).toContain("The Security Copilot has the brief");
    const host = await repository.upsertHost({ ownerUserId: "user:operator", alias: "vm100", label: "public-host", reach: "SSH", osFamily: "ALMALINUX", osVersion: "8.10", kernel: "4.18", status: "ACTIVE", note: null });
    const asked = await security.beginAction("user:operator", pane, { hostId: host.id, findingIds: [], kind: "HOST_REBOOT", summary: "reboot into the patched kernel", commands: "reboot", backup: "", rollback: "boot the previous kernel" });
    const question = await security.ask("user:operator", pane, { question: "Which maintenance window for public-host?", options: ["Tonight", "Sunday"] });
    const items = await deps.items("user:operator");
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({ copilot: "SECURITY", kind: "REVIEW", id: (asked as { reviewId: string }).reviewId, paneId: pane.id }),
      expect.objectContaining({ copilot: "SECURITY", kind: "QUESTION", id: question.id, detail: "Tonight / Sunday" }),
      expect.objectContaining({ copilot: "SECURITY", kind: "BRIEF_PENDING", title: "Check every PHP build for PHP2Shell" })]));
    expect(items.find((item) => item.kind === "REVIEW")!.detail).toContain("Only a person decides");
    const state = JSON.parse(await deps.state("user:operator", pane));
    expect(state).toMatchObject({ settings: { autonomy: "FULL" }, run: { openReviews: 1, openQuestions: 1, pendingBriefs: 1 }, reviews: [expect.objectContaining({ type: "REVIEW" })] });

    await deps.answerQuestion("user:operator", { copilot: "SECURITY", questionId: question.id, paneId: null, answer: "Sunday" });
    expect((await security.items("user:operator", pane)).questions).toEqual([]);
    // A held change is never a question Nous may answer.
    await expect(deps.answerQuestion("user:operator", { copilot: "SECURITY", questionId: (asked as { reviewId: string }).reviewId, paneId: null, answer: "approve" })).rejects.toThrow(/operator/);
    expect((await security.items("user:operator", pane)).reviews).toHaveLength(1);
  });

  it("offers no Always approve for a Security Copilot decision", () => {
    const decision = (copilot: "SECURITY" | "MAIL") => ({ category: "DIRECTION", action: { type: "COPILOT", copilot, item: "REVIEW", itemId: "secevt:abcdef12", paneId: null, decision: "approve" } }) as unknown as NousDecision;
    expect(nousDecisionKind(decision("SECURITY"))).toBeNull();
    expect(nousDecisionKind(decision("MAIL"))).not.toBeNull();
  });

  it("grants a stable hotfix approve only on the allowance, for a running fix of any finding (operator 31/10 16:07 BKK: no P0/P1 rule)", async () => {
    for (const allowed of [false, true]) {
      const { pane, security, repository, grants } = fixture(allowed);
      const host = await repository.upsertHost({ ownerUserId: "user:operator", alias: "local", label: "public-host", reach: "LOCAL", osFamily: "DEBIAN", osVersion: "13", kernel: "6.12", status: "ACTIVE", note: null });
      const finding = (await repository.upsertFinding({ ownerUserId: "user:operator", hostId: host.id, advisoryId: "GHSA-x6jw-m9v5-85vh", package: "npm:simple-git", installedVersion: "3.36.0",
        fixedVersion: "4.0.1", priority: "P2", advisory: { id: "GHSA-x6jw-m9v5-85vh", aliases: [], sources: ["OSV"], title: "npm simple-git", severity: "CRITICAL", cvss: null, epss: null, kev: false, kevAddedAt: null, publishedAt: null, references: [] } })).finding;
      const fix = await security.beginAction("user:operator", pane, { hostId: null, findingIds: [finding.id], kind: "CODE_FIX", summary: "simple-git 4.0.1", commands: "npm install simple-git@4.0.1 in a worktree", backup: "", rollback: "revert the commit" });
      expect(fix.gate).toBe("GO");
      await expect(security.hotfixGrant("user:operator", pane, fix.actionId, "not-a-ticket")).rejects.toThrow(/ticket/);
      if (!allowed) {
        await expect(security.hotfixGrant("user:operator", pane, fix.actionId, "q-20261024-101500-ab12")).rejects.toThrow(/May approve security hotfixes/);
        expect(grants).toEqual([]);
      } else {
        expect(await security.hotfixGrant("user:operator", pane, fix.actionId, "q-20261024-101500-ab12")).toMatchObject({ granted: true });
        expect(grants).toEqual(["space-queue approve q-20261024-101500-ab12"]);
        await security.finishAction("user:operator", pane, fix.actionId, { status: "VERIFIED", verification: "deployed" });
        await expect(security.hotfixGrant("user:operator", pane, fix.actionId, "q-20261024-101500-ab12")).rejects.toThrow(/running CODE_FIX/);
      }
    }
  });
});
