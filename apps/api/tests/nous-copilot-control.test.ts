import { describe, expect, it, vi } from "vitest";
import type { Pane, PaneCliSession } from "@space/contracts";
import { createCopilotControl, type CopilotInvoke } from "../src/nous/copilot-control.js";

const pane = (mode: string, extra: Partial<Pane> = {}): Pane =>
  ({ id: "pane:bob00001", roomId: "room:bruno001", paneName: "Bob", title: "Bob", mode, terminalRuntimeId: "cli:claude", isClosed: false, ...extra } as unknown as Pane);
const session = (extra: Partial<PaneCliSession> = {}): PaneCliSession =>
  ({ sessionId: "cli_session:s1", paneId: "pane:bob00001", runtimeId: "cli:claude", accountProfileId: "work", purpose: "NORMAL", isActive: true, status: "RUNNING", ...extra } as unknown as PaneCliSession);

function fixture(active: PaneCliSession | null, last: PaneCliSession | null = active, settings: Record<string, unknown> = { paused: false, autonomy: "ASSIST" }) {
  const invoke = vi.fn<CopilotInvoke>(async (_owner, method, url) =>
    method === "GET" && url.endsWith("/settings") ? { metadata: { view: { tab: "inbox" }, settings } }
      : url.includes("/run/") ? { status: url.endsWith("/start") ? "RUNNING" : url.endsWith("/pause") ? "PAUSED" : "STOPPED", kickoffSent: url.endsWith("/start") } : {});
  const control = createCopilotControl({ invoke, store: { getActivePaneCliSession: async () => active, listPaneCliSessions: async () => last ? [last] : [] } as never });
  return { invoke, control };
}

describe("space_copilot_control", () => {
  it("starts a copilot's stopped agent on the account its last session used, through the pane's own CLI route", async () => {
    const f = fixture(null, session({ isActive: false, status: "EXITED" }));
    expect(await f.control("user:operator", pane("MAIL_COPILOT"), "start_agent")).toBe("Started Bob's agent (cli:claude, account work).");
    expect(f.invoke).toHaveBeenCalledWith("user:operator", "POST", "/api/panes/pane%3Abob00001/cli/session",
      { runtimeId: "cli:claude", includeTranscript: false, accountProfileId: "work" });
  });

  it("leaves a running agent alone and starts a pane whose last session ran another CLI on the default account", async () => {
    const running = fixture(session());
    expect(await running.control("user:operator", pane("MAIL_COPILOT"), "start_agent")).toBe("Bob's agent is already running.");
    expect(running.invoke).not.toHaveBeenCalled();
    const switched = fixture(null, session({ runtimeId: "cli:codex", isActive: false, status: "EXITED" }));
    await switched.control("user:operator", pane("FREELANCE_COPILOT"), "start_agent");
    expect(switched.invoke).toHaveBeenCalledWith("user:operator", "POST", "/api/panes/pane%3Abob00001/cli/session", { runtimeId: "cli:claude", includeTranscript: false });
  });

  it("stops only a running agent", async () => {
    const running = fixture(session());
    expect(await running.control("user:operator", pane("JOB_APPLY"), "stop_agent")).toBe("Stopped Bob's agent.");
    expect(running.invoke).toHaveBeenCalledWith("user:operator", "POST", "/api/panes/pane%3Abob00001/cli/interrupt", { reason: "Stopped by Nous." });
    const login = fixture(session({ purpose: "LOGIN" } as Partial<PaneCliSession>));
    expect(await login.control("user:operator", pane("JOB_APPLY"), "stop_agent")).toBe("Bob's agent is not running.");
    expect(login.invoke).not.toHaveBeenCalled();
  });

  it("pauses and resumes through the copilot's settings, keeping the rest of them", async () => {
    const f = fixture(null);
    expect(await f.control("user:operator", pane("MARKETING_COPILOT"), "pause")).toBe("Paused Bob.");
    expect(f.invoke).toHaveBeenLastCalledWith("user:operator", "PUT", "/api/panes/pane%3Abob00001/marketing-copilot/settings",
      { view: { tab: "inbox" }, settings: { paused: true, autonomy: "ASSIST" } });
    expect(await f.control("user:operator", pane("MARKETING_COPILOT"), "resume")).toBe("Bob is already on.");
    const paused = fixture(null, null, { paused: true });
    expect(await paused.control("user:operator", pane("JOB_APPLY"), "resume")).toBe("Resumed Bob.");
    expect(paused.invoke).toHaveBeenLastCalledWith("user:operator", "PUT", "/api/panes/pane%3Abob00001/job-apply/settings", { view: { tab: "inbox" }, settings: { paused: false } });
  });

  it("starts, pauses and stops the run on each copilot's run route", async () => {
    const f = fixture(session());
    expect(await f.control("user:operator", pane("MAIL_COPILOT"), "run_start")).toBe("Bob's run is RUNNING; its agent got the kickoff.");
    expect(f.invoke).toHaveBeenLastCalledWith("user:operator", "POST", "/api/panes/pane%3Abob00001/mail-copilot/run/start", {});
    expect(await f.control("user:operator", pane("FREELANCE_COPILOT"), "run_pause")).toBe("Bob's run is PAUSED.");
    expect(f.invoke).toHaveBeenLastCalledWith("user:operator", "POST", "/api/panes/pane%3Abob00001/freelance-copilot/run/pause", {});
    expect(await f.control("user:operator", pane("JOB_APPLY"), "run_stop")).toBe("Stopped Bob's run.");
    expect(f.invoke).toHaveBeenLastCalledWith("user:operator", "POST", "/api/panes/pane%3Abob00001/job-apply/run/stop", {});
  });

  it("controls an App Studio pane through its own settings and run routes", async () => {
    const f = fixture(session(), session(), { paused: false, devices: ["iphone-402x874"] });
    expect(await f.control("user:operator", pane("APP_STUDIO"), "pause")).toBe("Paused Bob.");
    expect(f.invoke).toHaveBeenLastCalledWith("user:operator", "PUT", "/api/panes/pane%3Abob00001/app-studio/settings",
      { view: { tab: "inbox" }, settings: { paused: true, devices: ["iphone-402x874"] } });
    expect(await f.control("user:operator", pane("APP_STUDIO"), "run_start")).toBe("Bob's run is RUNNING; its agent got the kickoff.");
    expect(f.invoke).toHaveBeenLastCalledWith("user:operator", "POST", "/api/panes/pane%3Abob00001/app-studio/run/start", {});
  });

  it("refuses panes that are not copilots", async () => {
    const f = fixture(session());
    await expect(f.control("user:operator", pane("TERMINAL"), "start_agent")).rejects.toThrow("not a copilot pane");
    expect(f.invoke).not.toHaveBeenCalled();
  });
});
