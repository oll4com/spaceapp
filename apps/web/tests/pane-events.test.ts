import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_PANE_ACTION_EVENT,
  AGENT_PANE_ATTACHMENTS_EVENT,
  dispatchAgentPaneActionEvent,
  dispatchAgentPaneAttachmentsEvent,
  registerAgentPaneEventTarget
} from "../src/features/agent-pane/events.js";
import {
  BROWSER_PANE_ACTION_EVENT,
  dispatchBrowserPaneActionEvent,
  registerBrowserPaneEventTarget
} from "../src/features/browser-pane/events.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

describe("lazy pane event delivery", () => {
  it("replays Agent actions and attachments queued before the pane listener mounts", () => {
    const actions = vi.fn();
    const attachments = vi.fn();
    window.addEventListener(AGENT_PANE_ACTION_EVENT, actions);
    window.addEventListener(AGENT_PANE_ATTACHMENTS_EVENT, attachments);
    cleanups.push(() => window.removeEventListener(AGENT_PANE_ACTION_EVENT, actions));
    cleanups.push(() => window.removeEventListener(AGENT_PANE_ATTACHMENTS_EVENT, attachments));

    dispatchAgentPaneActionEvent({ paneId: "pane:agent", action: "manage_goal" });
    dispatchAgentPaneAttachmentsEvent({ paneId: "pane:agent", artifacts: [] });

    expect(actions).not.toHaveBeenCalled();
    expect(attachments).not.toHaveBeenCalled();

    cleanups.push(registerAgentPaneEventTarget("pane:agent"));

    expect(actions).toHaveBeenCalledTimes(1);
    expect(attachments).toHaveBeenCalledTimes(1);
  });

  it("replays a Browser action queued before the pane listener mounts", () => {
    const actions = vi.fn();
    window.addEventListener(BROWSER_PANE_ACTION_EVENT, actions);
    cleanups.push(() => window.removeEventListener(BROWSER_PANE_ACTION_EVENT, actions));

    dispatchBrowserPaneActionEvent({ paneId: "pane:browser", action: "bookmarks" });

    expect(actions).not.toHaveBeenCalled();

    cleanups.push(registerBrowserPaneEventTarget("pane:browser"));

    expect(actions).toHaveBeenCalledTimes(1);
  });

  it("preserves Agent action and attachment order while the lazy target loads", () => {
    const replayOrder: string[] = [];
    const actionListener = () => replayOrder.push("action");
    const attachmentListener = () => replayOrder.push("attachments");
    window.addEventListener(AGENT_PANE_ACTION_EVENT, actionListener);
    window.addEventListener(AGENT_PANE_ATTACHMENTS_EVENT, attachmentListener);
    cleanups.push(() => window.removeEventListener(AGENT_PANE_ACTION_EVENT, actionListener));
    cleanups.push(() => window.removeEventListener(AGENT_PANE_ATTACHMENTS_EVENT, attachmentListener));

    dispatchAgentPaneAttachmentsEvent({ paneId: "pane:ordered", artifacts: [] });
    dispatchAgentPaneActionEvent({ paneId: "pane:ordered", action: "manage_goal" });
    cleanups.push(registerAgentPaneEventTarget("pane:ordered"));

    expect(replayOrder).toEqual(["attachments", "action"]);
  });
});
