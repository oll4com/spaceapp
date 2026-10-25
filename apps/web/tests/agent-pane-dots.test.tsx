import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentPaneSessionSchema, type AgentPaneSession, type DotProfile, type Pane } from "@space/contracts";
import { AgentPane, AGENT_PANE_ACTION_EVENT } from "../src/features/agent-pane/AgentPane.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";
import { readDotDraft } from "../src/features/agent-pane/dot-drafts.js";
import { readFileSync } from "node:fs";
const mock = vi.hoisted(() => ({ dots: vi.fn(), dotCollection: vi.fn(), agentSession: vi.fn(), createAgentSession: vi.fn(),
  codexThread: vi.fn(), sendAgentMessage: vi.fn(), uploadPaneFiles: vi.fn(), updateAgentSettings: vi.fn(), dotFeed: vi.fn(), markDotFeedRead: vi.fn(),
  artifactFileUrl: (id: string) => `/api/artifacts/${id}/file` }));
const voice = vi.hoisted(() => ({ ownerId: null as string | null, status: "idle", settings: { enabled: true },
  serverSettings: { enabled: true }, settingsLoading: false, cancel: vi.fn(), prewarm: vi.fn(), start: vi.fn(), stop: vi.fn() }));
vi.mock("../src/api.js", () => ({ api: mock }));
vi.mock("../src/features/voice-input/VoiceInputProvider.js", () => ({ useOptionalVoiceInput: () => null, useVoiceInput: () => voice }));
const pane = { id: "pane:dots-test", roomId: "room:dots-test", title: "Dots test", mode: "CHAT", isMinimized: false } as Pane;
const dots = ["Orbit", "Nova", "Byte", "Comet", "Luna", "Cosmo"].map((name, i) => ({ dotId: `dot:${String(i+1).repeat(32)}`,
  ownerUserId: "user:one", slot: i+1, name, appearance: { character: ["astronaut", "star", "robot", "comet", "moon", "planet"][i], accent: "slate" } } as DotProfile));
function session(dotId = dots[0]!.dotId, id = "agent_session:orbit"): AgentPaneSession {
  return agentPaneSessionSchema.parse({ dotId, runtimeState: "AVAILABLE", binding: { paneId: pane.id, source: "SPACE", sessionId: id,
    coderChatId: null, status: "READY", title: pane.title, selectedModelConfigId: "gpt:high", selectedProviderName: "Codex", selectedModelName: "gpt",
    selectedReasoningKey: "high", selectedToolIds: [], lastSyncedAt: "2026-10-09T00:00:00.000Z" },
    threadId: null, messages: [], runStatus: "IDLE", statusReason: "Ready", modelOptions: [{ id: "gpt:high", displayName: "gpt", providerId: null,
      providerName: "Codex", model: "gpt", reasoningKey: "high", reasoningLabel: "High", isDefault: true }], selectedModelConfigId: "gpt:high",
    capabilities: { canSend: true, canInterrupt: false, canSelectModel: true, canSelectTools: false, supportsTools: true } });
}
let active: AgentPaneSession;
beforeEach(() => {
  installSpaceRuntime(liveRuntime); sessionStorage.clear(); vi.resetAllMocks();
  voice.ownerId = null; voice.status = "idle"; active = session();
  mock.dots.mockResolvedValue({ dots }); mock.agentSession.mockImplementation(async () => active);
  mock.dotCollection.mockImplementation(async (dotId: string) => ({ dotId, items: [], limit: 50, offset: 0 }));
  mock.dotFeed.mockImplementation(async (dotId: string) => ({ dotId, items: [], nextBefore: null, latestCursor: null, lastActiveAt: null, unread: 0 }));
  mock.markDotFeedRead.mockResolvedValue({ unread: 0 });
  mock.createAgentSession.mockImplementation(async (_: string, input: { dotId?: string }) => { active = session(input.dotId, `agent_session:${input.dotId}`); return active; });
});
afterEach(cleanup);
const threadLoading = () => document.querySelector(".dots-feed-scroll")?.getAttribute("data-thread-loading");
const dotTrigger = () => screen.getByRole("button", { name: /^Choose Dot/ }) as HTMLButtonElement;
async function setup() {
  const rendered = render(<AgentPane pane={pane} codexEnvironment={null} workspaceTextSize={14} />);
  await waitFor(() => expect(dotTrigger().disabled).toBe(false));
  return rendered;
}
/** Stage 8: Dots are chosen from the menu on the Dot's name. */
function selectDot(name: string) {
  fireEvent.click(dotTrigger());
  fireEvent.click(screen.getByRole("menuitemradio", { name: `Select ${name}` }));
}
describe("Stage2 actual AgentPane integration", () => {
  it("snapshots the final character before the composer debounce and restores separate Dot drafts", async () => {
    await setup(); const text = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(text, { target: { value: "Orbit final!" } });
    selectDot("Nova");
    await waitFor(() => expect(active.dotId).toBe(dots[1]!.dotId));
    await waitFor(() => expect(text.value).toBe(""));
    expect(readDotDraft(pane.id, dots[0]!).prompt).toBe("Orbit final!");
    fireEvent.change(text, { target: { value: "Nova draft" } });
    selectDot("Orbit");
    await waitFor(() => expect(text.value).toBe("Orbit final!"));
    expect(readDotDraft(pane.id, dots[1]!).prompt).toBe("Nova draft");
  });
  it("New task retains the selected Dot and only resets its draft after success", async () => {
    await setup(); selectDot("Nova");
    await waitFor(() => expect(active.dotId).toBe(dots[1]!.dotId));
    const text = screen.getByRole("textbox") as HTMLTextAreaElement;
    await waitFor(() => expect((screen.getByRole("button", { name: "New conversation" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(text, { target: { value: "Keep on failure" } });
    mock.createAgentSession.mockRejectedValueOnce(Error("Rejected"));
    fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "New conversation" }) as HTMLButtonElement).disabled).toBe(false));
    expect(text.value).toBe("Keep on failure");
    mock.createAgentSession.mockImplementationOnce(async (_: string, input: { dotId: string }) => { active = session(input.dotId, "agent_session:nova-new"); return active; });
    fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
    await waitFor(() => expect(text.value).toBe(""));
    expect(mock.createAgentSession).toHaveBeenLastCalledWith(pane.id, expect.objectContaining({ dotId: dots[1]!.dotId, sessionId: null, threadId: null }));
  });
  it("locks sending after a lost switch response until authoritative reconciliation succeeds", async () => {
    await setup(); const text = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(text, { target: { value: "Orbit survives" } });
    mock.createAgentSession.mockImplementationOnce(async () => { active = session(dots[1]!.dotId, "agent_session:nova"); throw Error("Lost response"); });
    mock.agentSession.mockRejectedValueOnce(Error("Read unavailable"));
    selectDot("Nova");
    await screen.findByText("Session selection is unconfirmed. Reconnect before sending.");
    expect((screen.getByRole("button", { name: "Send Dots test" }) as HTMLButtonElement).disabled).toBe(true);
    expect(readDotDraft(pane.id, dots[0]!).prompt).toBe("Orbit survives");
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    await waitFor(() => expect(dotTrigger().disabled).toBe(false));
    expect(text.value).toBe(""); expect(active.dotId).toBe(dots[1]!.dotId);
  });
  it("blocks switches during upload and ignores a late upload after pane teardown", async () => {
    const mounted = await setup(); let resolve!: (value: unknown) => void;
    mock.uploadPaneFiles.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    fireEvent.change(document.querySelector('input[name="agent-files-pane:dots-test"]')!, { target: { files: [new File(["x"], "file.txt")] } });
    await waitFor(() => expect(dotTrigger().disabled).toBe(true));
    mounted.unmount();
    await act(async () => { resolve({ artifacts: [{ id: "artifact:late" }] }); });
    expect(readDotDraft(pane.id, dots[0]!).attachments).toEqual([]);
  });
  it("guards late voice callbacks after cancellation and a Dot switch", async () => {
    let target!: { onTranscriptDelta: (s: string) => void; onTranscriptComplete: (s: string) => Promise<void> };
    voice.start.mockImplementation(async (input: typeof target) => { target = input; voice.ownerId = `chat:${pane.id}`; voice.status = "recording"; });
    const mounted = await setup(); fireEvent.click(screen.getByRole("button", { name: /Voice.*Dots test|Dictate.*Dots test|Start voice input Dots test/ }));
    await waitFor(() => expect(voice.start).toHaveBeenCalledOnce());
    await waitFor(() => expect(dotTrigger().disabled).toBe(true));
    voice.ownerId = null; voice.status = "idle";
    mounted.rerender(<AgentPane pane={pane} codexEnvironment={null} workspaceTextSize={14} />);
    selectDot("Nova");
    await waitFor(() => expect(active.dotId).toBe(dots[1]!.dotId));
    await act(async () => { target.onTranscriptDelta("old voice"); await target.onTranscriptComplete("old voice"); });
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(""); expect(mock.sendAgentMessage).not.toHaveBeenCalled();
  });
});

it("keeps the draft while the Dot's details open and close, and ignores a delayed session read after selecting another Dot", async () => {
  await setup(); const text = screen.getByRole("textbox") as HTMLTextAreaElement;
  fireEvent.change(text, { target: { value: "Retained draft" } });
  expect(screen.queryByRole("tab")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Orbit details" }));
  expect(screen.getByRole("complementary", { name: "Orbit details" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Close details" }));
  expect(screen.queryByRole("complementary", { name: "Orbit details" })).toBeNull();
  expect(screen.getByRole("textbox")).toBe(text); expect(text.value).toBe("Retained draft");
  let resolve!: (s: AgentPaneSession) => void; const old = active;
  mock.agentSession.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  act(() => { window.dispatchEvent(new CustomEvent(AGENT_PANE_ACTION_EVENT, { detail: { paneId: pane.id, action: "reconnect" } })); });
  // Invoke the same current session refresh through the existing pane action.
  await waitFor(() => expect(mock.agentSession).toHaveBeenCalledTimes(2));
  selectDot("Nova");
  await waitFor(() => expect(active.dotId).toBe(dots[1]!.dotId));
  await act(async () => { resolve(old); });
  expect(dotTrigger().getAttribute("aria-label")).toBe("Choose Dot (Nova)");
  expect(text.value).toBe("");
});

it("allocates the contained transcript inside the local flex shell and prevents composer shrink", async () => {
  await setup();
  const shared = readFileSync("src/styles.css", "utf8");
  const local = readFileSync("src/features/agent-pane/dots-chat.css", "utf8");
  const style = document.createElement("style");
  style.textContent = `${shared.match(/\.codex-chat-shell \{[^}]+\}/)![0]}\n${shared.match(/\.chat-transcript-region \{[^}]+\}/)![0]}\n${local.split("@container")[0]}`;
  document.head.append(style);
  try {
    const shell = getComputedStyle(document.querySelector(".dots-chat-shell")!);
    const main = getComputedStyle(document.querySelector(".dots-home-main")!);
    const transcript = getComputedStyle(document.querySelector(".chat-transcript-region")!);
    // Stage 8: the conversation column sits beside the Dot's details card.
    expect(shell.display).toBe("flex"); expect(shell.flexDirection).toBe("row");
    expect(main.display).toBe("flex"); expect(main.flexDirection).toBe("column");
    expect(shell.overflow).toBe("hidden");
    expect(transcript.flexGrow).toBe("1"); expect(transcript.minHeight).toBe("0");
    expect(getComputedStyle(document.querySelector(".codex-composer")!).flexShrink).toBe("0");
  } finally { style.remove(); }
});

it("clears obsolete transcript loading when switching to a threadless Dot", async () => {
  active = { ...session(), threadId: "thread:old" };
  let reject!: (error: Error) => void;
  mock.codexThread.mockImplementationOnce(() => new Promise((_, r) => { reject = r; }));
  await setup(); await waitFor(() => expect(threadLoading()).toBe("true"));
  selectDot("Nova");
  await waitFor(() => expect(threadLoading()).toBe("false"));
  await act(async () => { reject(Error("Obsolete thread failure")); });
  expect(screen.queryByText("Obsolete thread failure")).toBeNull();
  expect(threadLoading()).toBe("false");
});

it("clears a previous transcript error when publishing a different session", async () => {
  active = { ...session(), threadId: "thread:old" };
  mock.codexThread.mockRejectedValueOnce(Error("Old transcript unavailable"));
  await setup(); fireEvent.click(await screen.findByRole("button", { name: "Details" }));
  await screen.findByText("Old transcript unavailable");
  selectDot("Nova");
  await waitFor(() => expect(screen.queryByText("Old transcript unavailable")).toBeNull());
});

it("does not let an obsolete fetch finally clear the replacement transcript loading state", async () => {
  active = { ...session(), threadId: "thread:old" };
  let rejectOld!: (error: Error) => void; let rejectNew!: (error: Error) => void;
  mock.codexThread.mockImplementationOnce(() => new Promise((_, reject) => { rejectOld = reject; }))
    .mockImplementationOnce(() => new Promise((_, reject) => { rejectNew = reject; }));
  await setup(); await waitFor(() => expect(threadLoading()).toBe("true"));
  mock.createAgentSession.mockImplementationOnce(async () => {
    active = { ...session(dots[1]!.dotId, "agent_session:nova"), threadId: "thread:new" }; return active;
  });
  selectDot("Nova");
  await waitFor(() => expect(mock.codexThread).toHaveBeenCalledWith("thread:new", "chat"));
  await act(async () => { rejectOld(Error("Obsolete failure")); });
  expect(threadLoading()).toBe("true");
  expect(screen.queryByRole("alert")).toBeNull();
  await act(async () => { rejectNew(Error("Current failure")); });
  expect(threadLoading()).toBe("false");
  fireEvent.click(screen.getByRole("button", { name: "Details" }));
  expect(screen.getByText("Current failure")).toBeTruthy();
});

it("offers only +, message, mic and send: the Dot's model and permissions come from Settings", async () => {
  await setup();
  const composer = document.querySelector(".codex-composer")!;
  expect(composer.getAttribute("data-variant")).toBe("dot");
  expect(screen.queryByRole("button", { name: /Change model and reasoning/ })).toBeNull();
  expect(screen.queryByRole("button", { name: "CLI shortcuts" })).toBeNull();
  expect(screen.queryByRole("button", { name: /Prompt variables/ })).toBeNull();
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).placeholder).toBe("Send a message");
  expect(screen.getByRole("button", { name: "Add files or set a goal" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Start voice input Dots test" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Send Dots test" })).toBeTruthy();
});

describe("Dot Chat lost acknowledgement recovery", () => {
  it("clears the composer after a reload confirms the submission whose response was lost", async () => {
    const first = await setup();
    const text = screen.getByRole("textbox") as HTMLTextAreaElement;
    // As the browser proof does: set the value natively and send before the composer's debounce fires.
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    act(() => { setter.call(text, "Proof prompt"); text.dispatchEvent(new Event("input", { bubbles: true })); });
    const accepted = { ...session(), runStatus: "RUNNING" as const };
    mock.sendAgentMessage.mockImplementationOnce(async () => { active = accepted; throw new TypeError("response lost after server acceptance"); });
    fireEvent.click(screen.getByRole("button", { name: "Send Dots test" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Check submission" }) as HTMLButtonElement).disabled).toBe(false));
    first.unmount();
    mock.sendAgentMessage.mockImplementation(async () => { active = { ...session(), runStatus: "IDLE" }; return active; });
    render(<AgentPane pane={pane} codexEnvironment={null} workspaceTextSize={14} />);
    fireEvent.click(await screen.findByRole("button", { name: "Check submission" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Check submission" })).toBeNull());
    await waitFor(() => expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(""));
    expect(readDotDraft(pane.id, dots[0]!).prompt).toBe("");
  });

  it("clears the confirmed prompt even when another conversation became active before the recovery", async () => {
    const first = await setup();
    const text = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(text, { target: { value: "Proof prompt" } });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    mock.sendAgentMessage.mockImplementationOnce(async () => { throw new TypeError("response lost after server acceptance"); });
    fireEvent.click(screen.getByRole("button", { name: "Send Dots test" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Check submission" }) as HTMLButtonElement).disabled).toBe(false));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Proof prompt");
    first.unmount();
    // Another client started a new conversation with the same Dot meanwhile.
    active = session(dots[0]!.dotId, "agent_session:orbit-newer");
    mock.sendAgentMessage.mockImplementation(async () => ({ ...session(), runStatus: "IDLE" as const }));
    render(<AgentPane pane={pane} codexEnvironment={null} workspaceTextSize={14} />);
    fireEvent.click(await screen.findByRole("button", { name: "Check submission" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Check submission" })).toBeNull());
    await waitFor(() => expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(""));
  });
});
