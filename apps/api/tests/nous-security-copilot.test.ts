// Nous and the Security Copilot (plan clipboard:8ce8_URHW9Dk step 7): Nous briefs the pane, reads its state, sees its questions and
// held changes, answers questions itself but never a held change (no "Always approve" for it either), and the security hotfix grant
// needs the operator's allowance and a running fix of a P0/P1 finding.
import { describe, expect, it } from "vitest";
import { nousDecisionKind, type NousDecision } from "@space/contracts";
import { InMemorySecurityCopilotRepository } from "@space/db";
import { InMemorySpaceStore } from "@space/runtime";
import { copilotDeps } from "../src/nous/wiring.js";
import { createSecurityCopilotService } from "../src/security-copilot/service.js";

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

  it("grants a stable hotfix approve only on the allowance, for a running fix of a P0/P1 finding", async () => {
    for (const allowed of [false, true]) {
      const { pane, security, repository, grants } = fixture(allowed);
      const host = await repository.upsertHost({ ownerUserId: "user:operator", alias: "local", label: "public-host", reach: "LOCAL", osFamily: "DEBIAN", osVersion: "13", kernel: "6.12", status: "ACTIVE", note: null });
      const finding = (await repository.upsertFinding({ ownerUserId: "user:operator", hostId: host.id, advisoryId: "GHSA-x6jw-m9v5-85vh", package: "npm:simple-git", installedVersion: "3.36.0",
        fixedVersion: "4.0.1", priority: "P1", advisory: { id: "GHSA-x6jw-m9v5-85vh", aliases: [], sources: ["OSV"], title: "npm simple-git", severity: "CRITICAL", cvss: null, epss: null, kev: false, kevAddedAt: null, publishedAt: null, references: [] } })).finding;
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
