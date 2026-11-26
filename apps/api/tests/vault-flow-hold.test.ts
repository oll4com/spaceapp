import { afterEach, describe, expect, it, vi } from "vitest";
import type { Pane } from "@space/contracts";
import { SpaceConflictError } from "@space/runtime";
import { createVaultProtection, vaultFlowStep, VAULT_FLOW_HELD, VAULT_FLOW_IDLE_MS } from "../src/vault/protection.js";

// Braintrust authenticator swap (20/11, nous_msg:722364f3): Emma's confirm step lost the browser to Hugo's new tab mid-flow, and
// fills and clicks went to whichever tab was active. A Vault/MFA flow now holds its browser: other agents wait, the holder's steps
// land in the flow's own tab.
const pane = { id: "pane:browser01", roomId: "room:flow01", mode: "BROWSER", isClosed: false } as Pane;
const EMMA = "cli:cli_session:emma01";
const HUGO = "cli:cli_session:hugo01";

function browser(activePageId: string, pages: Array<{ pageId: string; openerPageId?: string | null }>) {
  const state = { activePageId, pages };
  return {
    state,
    listPages: vi.fn(async () => ({ activePageId: state.activePageId, pages: state.pages })),
    activatePage: vi.fn(async (_pane: Pane, pageId: string) => { state.activePageId = pageId; })
  };
}

describe("Vault/MFA flow hold", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("refuses another agent's step while the flow holds the browser, and brings the holder's flow tab back to front", async () => {
    const protection = createVaultProtection(null);
    expect(protection.holdFlow(pane.id, EMMA, "tab-braintrust")).toBe(true);
    expect(protection.holdFlow(pane.id, HUGO, "tab-yc")).toBe(false);
    const host = browser("tab-braintrust", [{ pageId: "tab-braintrust" }]);
    // Hugo's new tab or navigation waits.
    await expect(vaultFlowStep(protection, host, pane, HUGO, "trace")).rejects.toThrow(new SpaceConflictError(VAULT_FLOW_HELD));
    expect(host.activatePage).not.toHaveBeenCalled();
    // Nous (no CLI viewer) waits too.
    await expect(vaultFlowStep(protection, host, pane, undefined, "trace")).rejects.toBeInstanceOf(SpaceConflictError);
    // Another tab came to front anyway (a tab Emma opened herself): her confirm fill goes back to the flow's tab first.
    host.state.pages.push({ pageId: "tab-other" });
    host.state.activePageId = "tab-other";
    await vaultFlowStep(protection, host, pane, EMMA, "trace");
    expect(host.activatePage).toHaveBeenCalledWith(pane, "tab-braintrust", "trace", { holderType: "AGENT", holderId: EMMA });
    expect(host.state.activePageId).toBe("tab-braintrust");
    expect(protection.flowHold(pane.id)).toMatchObject({ holder: EMMA, tab: "tab-braintrust" });
  });

  it("follows the flow into a popup its tab opened, and ends when the flow's tab is closed", async () => {
    const protection = createVaultProtection(null);
    protection.holdFlow(pane.id, EMMA, "tab-braintrust");
    const host = browser("tab-popup", [{ pageId: "tab-braintrust" }, { pageId: "tab-popup", openerPageId: "tab-braintrust" }]);
    await vaultFlowStep(protection, host, pane, EMMA, "trace");
    expect(host.activatePage).not.toHaveBeenCalled();
    expect(protection.flowHold(pane.id)?.tab).toBe("tab-popup");
    // The popup closed: its tab is gone, the hold ends and anyone may use the browser.
    host.state.pages = [{ pageId: "tab-braintrust" }];
    host.state.activePageId = "tab-braintrust";
    await vaultFlowStep(protection, host, pane, HUGO, "trace");
    expect(protection.flowHold(pane.id)).toBeNull();
  });

  it("frees the browser when the holder has been idle past the named bound", async () => {
    vi.useFakeTimers();
    const protection = createVaultProtection(null);
    protection.holdFlow(pane.id, EMMA, "tab-braintrust");
    const host = browser("tab-braintrust", [{ pageId: "tab-braintrust" }]);
    vi.advanceTimersByTime(VAULT_FLOW_IDLE_MS - 1_000);
    await expect(vaultFlowStep(protection, host, pane, HUGO, "trace")).rejects.toBeInstanceOf(SpaceConflictError);
    // Emma's own step renews the hold.
    await vaultFlowStep(protection, host, pane, EMMA, "trace");
    vi.advanceTimersByTime(VAULT_FLOW_IDLE_MS - 1_000);
    expect(protection.flowHold(pane.id)?.holder).toBe(EMMA);
    vi.advanceTimersByTime(2_000);
    await vaultFlowStep(protection, host, pane, HUGO, "trace");
    expect(protection.flowHold(pane.id)).toBeNull();
    expect(protection.holdFlow(pane.id, HUGO, "tab-yc")).toBe(true);
  });
});
