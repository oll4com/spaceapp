import { describe, expect, it } from "vitest";
import type { NousDecision } from "@space/contracts";
import { nousScoreErrors } from "../src/nous/score.js";
import { historicalToolHold } from "../src/nous/tool-holds.js";

/** Daily Nous errors 22/11: causes fixed on 21/11 (their last sample predates the fix) stop counting, so no pane is sent to fix them again. */
describe("Daily Nous errors 22/11", () => {
  it("holds the recorded wordings today's code no longer produces", () => {
    expect(historicalToolHold("space_send_to_pane", "Not sent: Bob: CLI session cli_session:C7nsgmSa9hbP is not active. (read the pane (space_read_pane) before sending again")).toBe(true);
    expect(historicalToolHold("space_web_search", "The search took longer than 40 s; try fewer words.")).toBe(true);
    expect(historicalToolHold("space_site_signin_get", '[ { "code": "custom", "message": "Use a public site domain or http(s) URL without credentials", "path": [ "site" ] } ]')).toBe(true);
    // 21/11 16:26Z: Dino/Finn moved to Cleo mid-call; since 9a092ee81d it follows the pane, else a refusal names the state.
    expect(historicalToolHold("space_send_to_pane", 'No pane named "pane:x4YGukXHCN5Z" in this room. Open panes: Andy, Bob.')).toBe(true);
    expect(historicalToolHold("space_send_to_pane", 'No pane named "Finn" in this room. Open panes: Andy.')).toBe(false);
    // 22/11 06:06Z: cli:gemini asked for claude-opus-5-5 now refuses before opening /model.
    expect(historicalToolHold("space_set_pane_model", 'FAILED pane:sh994CSitcEw: The requested menu selection could not be verified (no row names "claude-opus-5-5"); inspect the pane\'s current menu.')).toBe(true);
    expect(historicalToolHold("space_set_pane_model", "FAILED pane:sh994CSitcEw: The CLI did not acknowledge the menu selection.")).toBe(false);
    // 22/11 09:31Z: a missing checked is held by the schema since 52eb9985b4.
    expect(historicalToolHold("space_ask_operator", "checked is required: Ask last (operator goal ee5a573e, 2026-10-27): find it yourself first (Space Memory and operator facts, …")).toBe(true);
    expect(historicalToolHold("space_ask_operator", "Mail Copilot is not available.")).toBe(false);
    // 23/11 REVIEW: panes.move's three 22/11 15:20Z causes no longer fail; a batch with another failure still does.
    for (const error of ["FAILED panes.move: panes.move needs id: the pane id.", "FAILED panes.move: This CLI adapter is not supported.",
      "FAILED panes.move: Pane CLI Browser is already closed and cannot be moved.\n{\"ok\":false}",
      "FAILED panes.move: Pane CLI Browser is already closed and cannot be moved. Reopen it first (space_execute {kind:\"pane\",operation:\"reopen\"}), then move it."]) expect(historicalToolHold("space_execute", error)).toBe(true);
    expect(historicalToolHold("space_execute", "FAILED panes.move: Pane CLI Browser is already closed and cannot be moved.\nFAILED panes.move pane:x: Pane is outside this room.")).toBe(false);
    expect(historicalToolHold("space_execute", "FAILED panes.move pane:x: Pane is outside this room.")).toBe(false);
    // Other failures of the same tools still count.
    expect(historicalToolHold("space_send_to_pane", "Not sent: Bob: the pane answered 500")).toBe(false);
    expect(historicalToolHold("space_web_search", "fetch failed")).toBe(false);
    expect(historicalToolHold("space_site_signin_get", "Site sign-in memory is unavailable")).toBe(false);
  });

  it("charges no failed decision for a stale Marketing post, and still charges other failed actions", () => {
    const at = "2026-11-21T11:05:16.817Z";
    const decision = (id: string, outcome: string) => ({ id, status: "APPROVED", answeredAt: at, createdAt: at, title: "LinkedIn note", refs: {}, outcome }) as unknown as NousDecision;
    const [day] = nousScoreErrors({ now: Date.parse("2026-11-22T03:00:00Z"), timeZone: "UTC", facts: [], lessons: [], decisions: [
      decision("nous_decision:a", "Failed: MARKETING_STALE: this post's time 2026-11-18T10:55:00.000Z is more than 24 hours past; approve it with a new future scheduledAt (or null to publish now)."),
      decision("nous_decision:b", "Failed: Mail Copilot is not available.")] });
    expect(day?.decisionsFailed).toBe(1);
  });
});
