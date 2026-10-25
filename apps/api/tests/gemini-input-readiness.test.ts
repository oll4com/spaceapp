import { expect, it, vi } from "vitest";
import { CliTerminalManager, geminiInputReady } from "../src/cli-terminal.js";

  it("waits for the Gemini composer instead of sending into startup or sign-in", () => {
    expect(geminiInputReady("")).toBe(false);
    expect(geminiInputReady("Antigravity CLI 1.2.11\nSigning in...\nEchoed prompt\n>")).toBe(false);
    expect(geminiInputReady("Antigravity CLI\nYou are currently not signed in.")).toBe(false);
    const composer = "\u001b[94m>\u001b[m Accept-edits mode\r\n\u001b[90m? for shortcuts\u001b[m";
    expect(geminiInputReady("Signing in...\n" + composer)).toBe(true);
    expect(geminiInputReady(composer + "\nSigning in...")).toBe(false);
  });


it("holds control input until the native composer opens", async () => {
  const session = { sessionId: "cli_session:gemini-ready" };
  const managed = { runtimeId: "cli:gemini", inputReady: false, closed: false,
    startupOutput: "Signing in...", controlOutput: "" };
  const manager = new CliTerminalManager({ config: {}, hostClient: {}, store: { getPaneCliSession: async () => session },
    startupReadyTimeoutMs: 500 } as never);
  vi.spyOn(manager, "ensurePaneTransportReady").mockResolvedValue(session as never);
  (manager as unknown as { sessions: Map<string, unknown> }).sessions.set(session.sessionId, managed);
  let ready = false;
  const pending = manager.ensurePaneControlReady({} as never, "proof").then(() => { ready = true; });
  await new Promise(resolve => setTimeout(resolve, 40));
  expect(ready).toBe(false);
  managed.controlOutput = "\r\n>\r\n? for shortcuts";
  await pending;
  expect(ready).toBe(true);
});

it("rejects control input when Gemini never opens its composer", async () => {
  const session = { sessionId: "cli_session:gemini-not-ready" };
  const manager = new CliTerminalManager({ config: {}, hostClient: {}, store: { getPaneCliSession: async () => session },
    startupReadyTimeoutMs: 30 } as never);
  vi.spyOn(manager, "ensurePaneTransportReady").mockResolvedValue(session as never);
  (manager as unknown as { sessions: Map<string, unknown> }).sessions.set(session.sessionId,
    { runtimeId: "cli:gemini", inputReady: false, closed: false, startupOutput: "Signing in...", controlOutput: "" });
  await expect(manager.ensurePaneControlReady({} as never, "proof")).rejects.toThrow("no input was sent");
});
