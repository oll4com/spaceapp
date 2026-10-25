import type { CliRuntimeSettingsResponse, Pane, Room } from "@space/contracts";
import { describe, expect, it } from "vitest";
import {
  agentActionAvailabilityEqual,
  agentActionDisabledReason,
  type AgentPaneActionAvailability
} from "../src/features/agent-pane/agent-action-availability.js";
import { paneRuntimeBlockedReason, roomPaneLimit } from "../src/pane-runtime-availability.js";

const idleChat: AgentPaneActionAvailability = {
  chatEnabled: true,
  hasSession: true,
  locked: false,
  running: false,
  blocked: false,
  canSend: true,
  hasContent: true,
  collaborationMode: "default",
  pending: false,
  dotId: null
};
const CHAT_ITEMS = ["import", "generate-title", "plan", "resume", "stop", "memory", "copy", "reconnect", "new_task", "task_history", "attach_folder", "manage_goal"];
const disabledChatItems = (availability: AgentPaneActionAvailability | null) =>
  Object.fromEntries(CHAT_ITEMS.map((id) => [id, agentActionDisabledReason(id, availability)]).filter(([, reason]) => reason));

describe("Chat pane action availability", () => {
  it("enables every idle Chat action except Stop", () => {
    expect(disabledChatItems(idleChat)).toEqual({ stop: "No running Chat task to stop." });
  });

  it("keeps only Stop and Copy usable while a turn runs", () => {
    const running = { ...idleChat, running: true, blocked: true };
    const disabled = disabledChatItems(running);
    expect(Object.keys(disabled).sort()).toEqual(["new_task", "plan", "resume", "memory", "task_history"].sort());
    expect(disabled.plan).toBe("Wait for the current Chat turn to finish.");
  });

  it("leaves only Copy (and Stop during a turn) without a Chat provider", () => {
    const disabled = disabledChatItems({ ...idleChat, chatEnabled: false });
    expect(Object.keys(disabled).sort()).toEqual(CHAT_ITEMS.filter((id) => id !== "copy").sort());
    expect(disabled.import).toBe("Enable a Chat provider in Settings");
    expect(disabled.reconnect).toBe("Enable a Chat provider in Settings");
    expect(agentActionDisabledReason("stop", { ...idleChat, chatEnabled: false, running: true })).toBeNull();
  });

  it("explains an empty Chat, an active Plan mode, a Dot switch and a loading pane", () => {
    const empty = disabledChatItems({ ...idleChat, hasContent: false });
    expect(empty).toMatchObject({
      copy: "There are no visible Chat contents to copy.",
      resume: "There is no Chat task to resume yet.",
      memory: "There is no Chat task to save yet.",
      "generate-title": "Send a first message before generating a title."
    });
    expect(agentActionDisabledReason("plan", { ...idleChat, collaborationMode: "plan" })).toBe("Plan mode is already on.");
    expect(agentActionDisabledReason("new_task", { ...idleChat, locked: true, blocked: true })).toBe("The Chat is switching Dots.");
    expect(agentActionDisabledReason("reconnect", { ...idleChat, locked: true })).toBeNull();
    expect(agentActionDisabledReason("resume", { ...idleChat, canSend: false })).toBe("This Chat cannot send messages right now.");
    expect(agentActionDisabledReason("plan", null)).toBe("The Chat is still loading.");
    expect(agentActionDisabledReason("reconnect", null)).toBeNull();
    expect(agentActionDisabledReason("move", null)).toBeNull();
  });

  it("compares availability snapshots by value", () => {
    expect(agentActionAvailabilityEqual(idleChat, { ...idleChat })).toBe(true);
    expect(agentActionAvailabilityEqual(idleChat, { ...idleChat, running: true })).toBe(false);
  });
});

describe("pane runtime and room limits", () => {
  const settings = {
    settings: [
      { runtimeId: "cli:codex", enabled: true },
      { runtimeId: "cli:gemini", enabled: false }
    ],
    runtimes: [{ id: "cli:gemini", displayName: "Gemini CLI" }],
    harness: { runtimeId: "cli:harness", enabled: false, vpnEnabled: false, effectiveMode: "BLOCKED", isolated: true, pid: null }
  } as unknown as CliRuntimeSettingsResponse;
  const pane = (overrides: Partial<Pane>) => ({ mode: "TERMINAL", terminalRuntimeId: "cli:codex", ...overrides }) as Pane;

  it("blocks pane updates only while the pane's own runtime is disabled", () => {
    expect(paneRuntimeBlockedReason(pane({ terminalRuntimeId: "cli:gemini" }), settings)).toBe("Enable Gemini CLI in Settings");
    expect(paneRuntimeBlockedReason(pane({ terminalRuntimeId: "cli:codex" }), settings)).toBeNull();
    expect(paneRuntimeBlockedReason(pane({ terminalRuntimeId: "cli:root" }), settings)).toBeNull();
    expect(paneRuntimeBlockedReason(pane({ mode: "HARNESS" }), settings)).toBe("Enable DeepSeek Harness in Settings");
    expect(paneRuntimeBlockedReason(pane({ mode: "BROWSER" }), settings)).toBeNull();
    expect(paneRuntimeBlockedReason(pane({ terminalRuntimeId: "cli:gemini" }), null)).toBeNull();
  });

  it("caps rooms at their paneCap and never above 16", () => {
    expect(roomPaneLimit({ paneCap: 4 } as Room)).toBe(4);
    expect(roomPaneLimit(null)).toBe(16);
  });
});
