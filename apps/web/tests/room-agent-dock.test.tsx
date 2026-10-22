import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Room, RoomAgentPaneStripItem, RoomAgentSession, RoomAgentTimelineMessage } from "@space/contracts";
import { RoomAgentDock } from "../src/features/room-agent/RoomAgentDock.js";
import { DockActiveContext } from "../src/features/docks/dock-active-context.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime, SpaceRuntimeProvider } from "../src/runtime/SpaceRuntime.js";

const voiceMock = vi.hoisted(() => ({ current: null as any }));
vi.mock("../src/features/voice-input/VoiceInputProvider.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/features/voice-input/VoiceInputProvider.js")>(),
  useOptionalVoiceInput: () => voiceMock.current
}));

const room: Room = {
  id: "room:agent-dock",
  name: "Agent Dock Room",
  description: null,
  kind: "WORKSPACE",
  order: 0,
  paneLayoutColumns: null,
  paneLayoutHeight: 1,
  paneCap: 16,
  traceId: "trace:agent-dock",
  archivedAt: null,
  createdAt: "2026-07-11T00:00:00.000Z",
  updatedAt: "2026-07-11T00:00:00.000Z"
};

// Today's local midnight, so the dock's "Today" separator holds on any run date.
const at = (second: number) => { const day = new Date(); day.setHours(0, 0, second, 0); return day.toISOString(); };
const chat = (id: string, role: "user" | "assistant", content: string, second: number, status: RoomAgentTimelineMessage["status"] = "COMPLETED"): RoomAgentTimelineMessage =>
  ({ id, role, kind: "CHAT", content, status, createdAt: at(second) });

function session(input: Partial<RoomAgentSession> = {}): RoomAgentSession {
  return {
    roomId: room.id,
    paneId: "pane:room-agent",
    sessionId: "agent_session:room-agent",
    threadId: null,
    status: "IDLE",
    statusReason: "Room Agent is ready to supervise this room.",
    modelId: "gpt-5.6-sol",
    reasoningEffort: "high",
    messages: [
      chat("agent_msg:user-1", "user", "What do you see in the room?", 0),
      chat("agent_msg:assistant-1", "assistant", "Two panes are open; **Bob** is working.", 1)
    ],
    activeTurn: null,
    activeMission: null,
    queuedMissionCount: 0,
    currentPaneId: null,
    activePaneIds: [],
    progress: { totalSteps: 0, completedSteps: 0, runningSteps: 0, queuedSteps: 0, blockedSteps: 0, peakConcurrency: 0, elapsedMs: 0 },
    capabilities: { canSend: true, canPause: false, canResume: false, canStop: false, canClear: true },
    ...input
  };
}

const answering = (input: Partial<RoomAgentSession> = {}) => session({
  status: "RUNNING",
  statusReason: "Answering…",
  messages: [chat("agent_msg:user-2", "user", "Write a long report.", 0), chat("agent_msg:answer-2", "assistant", "", 1, "RUNNING")],
  activeTurn: { messageId: "agent_msg:answer-2", requestId: "room-agent-web:turn", startedAt: at(1) },
  capabilities: { canSend: true, canPause: false, canResume: false, canStop: true, canClear: true },
  ...input
});

const strip: RoomAgentPaneStripItem[] = [
  { paneId: "pane:bob-agent", paneName: "Bob", title: "Claude", mode: "TERMINAL", runtimeId: "cli:claude", activity: "WAITING",
    reason: "Permission prompt", since: at(0), modelId: "claude-opus-5-5", taskTitle: "Fix login redirect", isMinimized: true },
  { paneId: "pane:dana-agent", paneName: "Dana", title: "Codex", mode: "TERMINAL", runtimeId: "cli:codex", activity: "WORKING",
    reason: null, since: null, modelId: null, taskTitle: null, isMinimized: false },
  { paneId: "pane:andy-browser", paneName: "Andy", title: "Docs", mode: "BROWSER", runtimeId: null, activity: "NONE",
    reason: null, since: null, modelId: null, taskTitle: null, isMinimized: false }
];

type Handler = (url: string, method: string, body: any) => Response | Promise<Response> | undefined;
function serve(handler: Handler = () => undefined, fallback: () => RoomAgentSession = () => session()) {
  const requests: Array<{ method: string; url: string; body: any }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (url === "/api/auth/csrf") return Response.json({ csrfToken: "csrf:room-agent", headerName: "x-space-csrf-token" });
    requests.push({ method, url, body });
    return (await handler(url, method, body)) ?? Response.json(fallback());
  });
  vi.stubGlobal("fetch", fetchMock);
  return { requests, fetchMock };
}

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  closed = false;
  constructor(readonly url: string, readonly init?: EventSourceInit) { FakeEventSource.instances.push(this); }
  close() { this.closed = true; }
  emit(frame: unknown) { this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(frame) })); }
}

beforeEach(() => {
  installSpaceRuntime(liveRuntime);
  FakeEventSource.instances = [];
});

afterEach(() => {
  voiceMock.current = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Room Agent conversation dock", () => {
  it("shows one conversation: bubbles, the turn's tools before its answer, and no mission controls", async () => {
    serve(() => undefined, () => session({ messages: [
      chat("agent_msg:user-1", "user", "What is Bob doing?", 0),
      { id: "agent_msg:tool-1", role: "tool", kind: "TOOL", content: "Read Bob's screen", status: "COMPLETED", createdAt: at(2), meta: { name: "read_pane", status: "DONE" } },
      { id: "agent_msg:tool-2", role: "tool", kind: "TOOL", content: "Closing Bob needs your yes", status: "COMPLETED", createdAt: at(3), meta: { name: "close_pane", status: "NEEDS_CONFIRMATION" } },
      chat("agent_msg:assistant-1", "assistant", "**Bob** is fixing the login.\n\n- tests pass", 1)
    ] }));
    render(<RoomAgentDock activeRoom={room} />);

    const log = await screen.findByRole("log", { name: "Room Agent conversation" });
    const tool = within(log).getByText("Read Bob's screen");
    const answer = within(log).getByText("tests pass");
    expect(answer.tagName).toBe("LI");
    expect(within(log).getByText("Bob").tagName).toBe("STRONG");
    expect(tool.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(log).queryByText("Closing Bob needs your yes")).toBeNull();
    expect(within(log).getByText("Today")).toBeTruthy();
    expect(screen.getByText("Ready").className).toContain("room-agent-status");
    expect(screen.getByRole("textbox", { name: "Message Room Agent" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send to Room Agent" })).toBeTruthy();
    for (const removed of ["Pause Room Agent", "Resume Room Agent", "Stop Room Agent"]) expect(screen.queryByRole("button", { name: removed })).toBeNull();
    expect(screen.queryByRole("region", { name: "Room Agent mission report" })).toBeNull();
    for (const forbidden of ["model", "reasoning", "permission", "upload", "attach file"]) {
      expect(screen.queryByRole("button", { name: new RegExp(forbidden, "i") })).toBeNull();
    }
  });

  it("puts the room in one line that opens the pane list, asks about a pane and opens it", async () => {
    serve(() => undefined, () => session({ messages: [], paneStrip: strip }));
    const onOpenPane = vi.fn();
    render(<RoomAgentDock activeRoom={room} onOpenPane={onOpenPane} />);

    const summary = await screen.findByRole("button", { name: "3 panes · 1 working · 1 waiting" });
    expect(screen.queryByRole("list", { name: "Room panes" })).toBeNull();
    fireEvent.click(summary);
    const list = screen.getByRole("list", { name: "Room panes" });
    expect(within(list).getByText("Fix login redirect")).toBeTruthy();
    expect(within(list).getByText("Permission prompt · minimized")).toBeTruthy();
    expect(within(list).getByText("Browser")).toBeTruthy();
    fireEvent.click(within(list).getByRole("button", { name: /^Bob/ }));
    expect((screen.getByRole("textbox", { name: "Message Room Agent" }) as HTMLTextAreaElement).value).toBe("@Bob ");
    fireEvent.click(within(list).getByRole("button", { name: "Open Bob" }));
    expect(onOpenPane).toHaveBeenCalledWith("pane:bob-agent");
    fireEvent.click(summary);
    expect(screen.queryByRole("list", { name: "Room panes" })).toBeNull();
  });

  it("streams the answer from the dock's stream and then shows the saved message", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    let saved = false;
    serve(() => undefined, () => saved
      ? session({ messages: [chat("agent_msg:user-2", "user", "Write a long report.", 0), chat("agent_msg:answer-2", "assistant", "Bob and Dana are done.", 1)] })
      : answering());
    const view = render(<DockActiveContext.Provider value={true}><RoomAgentDock activeRoom={room} /></DockActiveContext.Provider>);

    const log = await screen.findByRole("log", { name: "Room Agent conversation" });
    expect(await within(log).findByText("Thinking…")).toBeTruthy();
    const source = FakeEventSource.instances.at(-1)!;
    expect(source.url).toBe("/api/rooms/room%3Aagent-dock/room-agent/stream");
    expect(source.init).toEqual({ withCredentials: true });
    act(() => source.emit({ phase: "tool", messageId: "agent_msg:answer-2", requestId: "r", tool: { rowId: "agent_msg:tool-9", name: "read_pane", label: "Reading Bob's screen", status: "RUNNING" } }));
    expect(within(log).getByText("Reading Bob's screen")).toBeTruthy();
    act(() => source.emit({ phase: "text", messageId: "agent_msg:answer-2", requestId: "r", text: "Bob and" }));
    expect(within(log).getByText("Bob and")).toBeTruthy();
    expect(within(log).queryByText("Thinking…")).toBeNull();
    act(() => source.emit({ phase: "text", messageId: "agent_msg:answer-2", requestId: "r", text: "Bob and Dana are" }));
    expect(within(log).getByText("Bob and Dana are")).toBeTruthy();
    expect(log.querySelector(".room-agent-caret")).toBeTruthy();
    saved = true;
    act(() => source.emit({ phase: "done", messageId: "agent_msg:answer-2", requestId: "r", text: "Bob and Dana are done." }));
    expect(await within(log).findByText("Bob and Dana are done.")).toBeTruthy();
    await waitFor(() => expect(log.querySelector(".room-agent-caret")).toBeNull());

    view.rerender(<DockActiveContext.Provider value={false}><RoomAgentDock activeRoom={room} /></DockActiveContext.Provider>);
    expect(source.closed).toBe(true);
  });

  it("shows the message at once, and Stop replaces Send while the answer runs", async () => {
    let finishSend!: (response: Response) => void;
    const sent = new Promise<Response>((resolve) => { finishSend = resolve; });
    const { requests } = serve((url, method) => {
      if (method === "POST" && url.endsWith("/messages")) return sent;
      if (method === "POST" && url.endsWith("/stop")) {
        return Response.json(session({ messages: [chat("agent_msg:user-2", "user", "Write a long report.", 0), chat("agent_msg:answer-2", "assistant", "(stopped)", 1, "INTERRUPTED")] }));
      }
      return undefined;
    }, () => session({ messages: [] }));
    render(<RoomAgentDock activeRoom={room} />);
    const composer = await screen.findByRole("textbox", { name: "Message Room Agent" });
    fireEvent.change(composer, { target: { value: "Write a long report." } });
    fireEvent.click(screen.getByRole("button", { name: "Send to Room Agent" }));
    expect(screen.getByText("Write a long report.")).toBeTruthy();
    expect(composer).toHaveProperty("value", "");
    await act(async () => { finishSend(Response.json(answering(), { status: 202 })); await sent; });

    const stop = await screen.findByRole("button", { name: "Stop Room Agent" });
    expect(screen.queryByRole("button", { name: "Send to Room Agent" })).toBeNull();
    expect(screen.getByText("Answering")).toBeTruthy();
    expect(requests.find((request) => request.url.endsWith("/messages"))).toMatchObject({ method: "POST",
      url: "/api/rooms/room%3Aagent-dock/room-agent/messages", body: { content: "Write a long report.", clientRequestId: expect.stringMatching(/^room-agent-web:/) } });
    fireEvent.click(stop);
    await waitFor(() => expect(requests.find((request) => request.url.endsWith("/stop"))).toMatchObject({ method: "POST", body: { reason: "Stopped from the Room Agent." } }));
    expect(await screen.findByText("(stopped)")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send to Room Agent" })).toBeTruthy();
  });

  it("keeps the draft when the Room Agent is still answering and sends it later as a new request", async () => {
    const bodies: Array<{ clientRequestId: string }> = [];
    serve((url, method, body) => {
      if (method !== "POST" || !url.endsWith("/messages")) return undefined;
      bodies.push(body);
      return bodies.length === 1
        ? Response.json({ error: { code: "CONFLICT", message: "The Room Agent is still answering. Wait for the reply or press Stop." } }, { status: 409 })
        : Response.json(session(), { status: 202 });
    });
    render(<RoomAgentDock activeRoom={room} />);
    const composer = await screen.findByRole("textbox", { name: "Message Room Agent" });
    fireEvent.change(composer, { target: { value: "And check Dana." } });
    fireEvent.click(screen.getByRole("button", { name: "Send to Room Agent" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The Room Agent is still answering. Wait for the reply or press Stop.");
    expect(composer).toHaveProperty("value", "And check Dana.");
    fireEvent.click(within(alert).getByRole("button", { name: "Dismiss message" }));
    fireEvent.click(screen.getByRole("button", { name: "Send to Room Agent" }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]!.clientRequestId).not.toBe(bodies[0]!.clientRequestId);
  });

  it("shows what the monitor saw as rows that can be answered, declined, opened and dismissed", async () => {
    const waiting: RoomAgentTimelineMessage = { id: "room_agent_event:ask", role: "system", kind: "SYSTEM", content: "Dana is waiting: Permission prompt",
      status: "COMPLETED", createdAt: at(2), meta: { type: "MONITOR_EVENT", eventId: "room_agent_event:ask", eventKind: "WAITING", severity: "ATTENTION",
        status: "ESCALATED", decision: "Needs you: only the operator may approve git push.", detail: "Bash: git push github main\n❯ 1. Yes\n  2. No",
        paneId: "pane:dana-agent", paneName: "Dana" } };
    const finished: RoomAgentTimelineMessage = { id: "room_agent_event:done", role: "system", kind: "SYSTEM", content: "Bob finished", status: "COMPLETED",
      createdAt: at(3), meta: { type: "MONITOR_EVENT", eventId: "room_agent_event:done", eventKind: "FINISHED", severity: "INFO", status: "OPEN", decision: null,
        detail: "Fix login redirect", paneId: "pane:bob-agent", paneName: "Bob" } };
    const { requests } = serve((url) => {
      if (url.endsWith("/answer")) return Response.json(session({ messages: [{ ...waiting, meta: { ...waiting.meta, status: "HANDLED", decision: "You answered \"1\" in the Room Agent." } }, finished] }));
      if (url.endsWith("/ack")) return Response.json(session({ messages: [{ ...waiting, meta: { ...waiting.meta, status: "HANDLED", decision: "You answered \"1\" in the Room Agent." } }] }));
      return undefined;
    }, () => session({ messages: [waiting, finished] }));
    const onOpenPane = vi.fn();
    render(<RoomAgentDock activeRoom={room} onOpenPane={onOpenPane} />);

    const log = await screen.findByRole("log", { name: "Room Agent conversation" });
    expect(within(log).getByText(/git push github main/)).toBeTruthy();
    expect(within(log).getByText("Needs you")).toBeTruthy();
    fireEvent.click(within(log).getByRole("button", { name: "Open Dana" }));
    expect(onOpenPane).toHaveBeenCalledWith("pane:dana-agent");
    fireEvent.click(within(log).getByRole("button", { name: "Answer" }));
    fireEvent.change(within(log).getByRole("textbox", { name: "Answer for Dana" }), { target: { value: "1" } });
    fireEvent.click(within(log).getByRole("button", { name: "Send" }));
    expect(await within(log).findByText("You answered \"1\" in the Room Agent.")).toBeTruthy();
    expect(requests).toContainEqual({ method: "POST", url: "/api/rooms/room%3Aagent-dock/room-agent/events/room_agent_event%3Aask/answer", body: { answer: "1" } });
    expect(within(log).queryByRole("button", { name: "Answer" })).toBeNull();

    fireEvent.click(within(log).getAllByRole("button", { name: "Dismiss" }).at(-1)!);
    await waitFor(() => expect(within(log).queryByText("Bob finished")).toBeNull());
    expect(requests).toContainEqual(expect.objectContaining({ method: "POST", url: "/api/rooms/room%3Aagent-dock/room-agent/events/room_agent_event%3Adone/ack" }));
  });

  it("shows events Nous takes as sent to Nous: read, never new, nothing to answer", async () => {
    const waiting: RoomAgentTimelineMessage = { id: "room_agent_event:nous", role: "system", kind: "SYSTEM", content: "Dana is waiting: Permission prompt",
      status: "COMPLETED", createdAt: at(2), meta: { type: "MONITOR_EVENT", eventId: "room_agent_event:nous", eventKind: "WAITING", severity: "ATTENTION",
        status: "OPEN", decision: null, detail: null, paneId: "pane:dana-agent", paneName: "Dana", sentToNous: true } };
    serve(() => undefined, () => session({ messages: [waiting] }));
    render(<RoomAgentDock activeRoom={room} onOpenPane={vi.fn()} />);
    const log = await screen.findByRole("log", { name: "Room Agent conversation" });
    expect(within(log).getByText("Sent to Nous")).toBeTruthy();
    expect(within(log).queryByText("New")).toBeNull();
    expect(within(log).queryByRole("button", { name: "Answer" })).toBeNull();
    expect(log.querySelector('[data-attention="true"]')).toBeNull();
  });

  it("declines a pane question with Escape from its row", async () => {
    const row: RoomAgentTimelineMessage = { id: "room_agent_event:decline", role: "system", kind: "SYSTEM", content: "Dana is waiting: Permission prompt",
      status: "COMPLETED", createdAt: at(2), meta: { type: "MONITOR_EVENT", eventId: "room_agent_event:decline", eventKind: "WAITING", severity: "ATTENTION",
        status: "OPEN", decision: null, detail: null, paneId: "pane:dana-agent", paneName: "Dana" } };
    const { requests } = serve(() => undefined, () => session({ messages: [row] }));
    render(<RoomAgentDock activeRoom={room} />);
    fireEvent.click(await screen.findByRole("button", { name: "Decline" }));
    await waitFor(() => expect(requests).toContainEqual(expect.objectContaining({ url: expect.stringContaining("/answer"), body: { decline: true } })));
  });

  it("asks for a yes inline: Yes and No go through the conversation", async () => {
    const confirmation = (status: string, result: string | null = null): RoomAgentTimelineMessage => ({ id: "agent_msg:confirm", role: "system", kind: "CONFIRMATION",
      content: "Close Bob", status: "COMPLETED", createdAt: at(3), meta: { token: "tok123abc", status, result } });
    const { requests } = serve((url, method) => method === "POST" && url.endsWith("/messages")
      ? Response.json(session({ messages: [confirmation("CONFIRMED", "Closed Bob")] }), { status: 202 }) : undefined,
      () => session({ messages: [chat("agent_msg:user-1", "user", "close Bob", 0), chat("agent_msg:assistant-1", "assistant", "Shall I close Bob?", 1), confirmation("PENDING")] }));
    render(<RoomAgentDock activeRoom={room} />);

    const log = await screen.findByRole("log", { name: "Room Agent conversation" });
    expect(within(log).getByText("Close Bob?")).toBeTruthy();
    fireEvent.click(within(log).getByRole("button", { name: "Yes" }));
    await waitFor(() => expect(requests.find((request) => request.url.endsWith("/messages"))?.body).toMatchObject({ content: "Yes, go ahead (confirm tok123abc)" }));
    expect(await within(log).findByText("Done · Closed Bob")).toBeTruthy();
    expect(within(log).queryByRole("button", { name: "Yes" })).toBeNull();
  });

  it("sends No to a pending action", async () => {
    const pending: RoomAgentTimelineMessage = { id: "agent_msg:confirm", role: "system", kind: "CONFIRMATION", content: "Restart Andy", status: "COMPLETED",
      createdAt: at(3), meta: { token: "tok456def", status: "PENDING", result: null } };
    const { requests } = serve((url, method) => method === "POST" && url.endsWith("/messages") ? Response.json(session(), { status: 202 }) : undefined,
      () => session({ messages: [pending] }));
    render(<RoomAgentDock activeRoom={room} />);
    fireEvent.click(await screen.findByRole("button", { name: "No" }));
    await waitFor(() => expect(requests.find((request) => request.url.endsWith("/messages"))?.body).toMatchObject({ content: "No" }));
  });

  it("switches the room monitor and the autopilot from settings and clears the conversation after confirming", async () => {
    let monitor = { enabled: true, autopilot: true };
    let cleared = false;
    const { requests } = serve((url, method, body) => {
      if (url.endsWith("/monitor")) { monitor = { ...monitor, ...body }; return Response.json(session({ monitor })); }
      if (method === "DELETE") { cleared = true; return Response.json(session({ messages: [], monitor })); }
      return undefined;
    }, () => session({ monitor, ...(cleared ? { messages: [] } : {}) }));
    render(<RoomAgentDock activeRoom={room} />);

    fireEvent.click(await screen.findByRole("button", { name: "Room Agent settings" }));
    expect((screen.getByRole("switch", { name: "Let the Room Agent answer pane prompts" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("switch", { name: "Monitor this room" }));
    await waitFor(() => expect((screen.getByRole("switch", { name: "Monitor this room" }) as HTMLInputElement).checked).toBe(false));
    expect(requests).toContainEqual({ method: "PATCH", url: "/api/rooms/room%3Aagent-dock/room-agent/monitor", body: { enabled: false } });

    fireEvent.click(screen.getByRole("button", { name: "Clear Room Agent history" }));
    fireEvent.click(within(screen.getByRole("alertdialog", { name: "Clear Room Agent history?" })).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(requests.some((request) => request.method === "DELETE")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Clear Room Agent history" }));
    fireEvent.click(within(screen.getByRole("alertdialog", { name: "Clear Room Agent history?" })).getByRole("button", { name: "Clear history" }));
    expect(await screen.findByText("What needs doing?")).toBeTruthy();
    expect(requests).toContainEqual(expect.objectContaining({ method: "DELETE", url: "/api/rooms/room%3Aagent-dock/room-agent/transcript" }));
  });

  it("offers three suggestions on an empty conversation and completes @mentions", async () => {
    serve(() => undefined, () => session({ messages: [], paneStrip: strip }));
    render(<RoomAgentDock activeRoom={room} />);
    expect(await screen.findByText("What needs doing?")).toBeTruthy();
    const suggestions = screen.getByRole("group", { name: "Suggested requests" });
    expect(within(suggestions).getAllByRole("button").map((button) => button.textContent)).toEqual(["What do you see in the room?", "What needs me?", "Continue pending work"]);
    fireEvent.click(within(suggestions).getByRole("button", { name: "What needs me?" }));
    const composer = screen.getByRole("textbox", { name: "Message Room Agent" }) as HTMLTextAreaElement;
    expect(document.activeElement).toBe(composer);
    expect(composer.value).toBe("What needs me?");

    fireEvent.change(composer, { target: { value: "please @D" } });
    const options = screen.getByRole("listbox", { name: "Panes to mention" });
    expect(within(options).getAllByRole("option").map((option) => option.textContent)).toEqual(["DanaCodex"]);
    fireEvent.click(within(options).getByRole("option"));
    expect(composer.value).toBe("please @Dana ");
    fireEvent.change(composer, { target: { value: "@" } });
    fireEvent.keyDown(composer, { key: "Tab" });
    expect(composer.value).toBe("@Bob ");
  });

  it("sends Greek text with Latin words as typed and converts only text typed wholly in the wrong layout", async () => {
    const bodies: Array<{ content: string }> = [];
    serve((url, method, body) => {
      if (method !== "POST" || !url.endsWith("/messages")) return undefined;
      bodies.push(body);
      return Response.json(session(), { status: 202 });
    });
    render(<RoomAgentDock activeRoom={room} />);
    const composer = await screen.findByRole("textbox", { name: "Message Room Agent" });
    for (const text of ["ξεκίνησε μουσική στο youtube", "κλείσε τον Bob", "veltiose mou"]) {
      fireEvent.change(composer, { target: { value: text } });
      fireEvent.click(screen.getByRole("button", { name: "Send to Room Agent" }));
      await waitFor(() => expect(composer).toHaveProperty("value", ""));
    }
    await waitFor(() => expect(bodies).toHaveLength(3));
    expect(bodies.map((body) => body.content)).toEqual(["ξεκίνησε μουσική στο youtube", "κλείσε τον Bob", "βελτίωσε μου"]);
  });

  it("keeps a typed draft during room updates", async () => {
    const { fetchMock } = serve();
    const view = render(<RoomAgentDock activeRoom={room} refreshKey="event:1" />);
    const composer = await screen.findByRole("textbox", { name: "Message Room Agent" });
    fireEvent.change(composer, { target: { value: "My edited request" } });
    const reads = fetchMock.mock.calls.length;
    view.rerender(<RoomAgentDock activeRoom={room} refreshKey="event:2" />);
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(reads));
    expect(composer).toHaveProperty("value", "My edited request");
  });

  it("blocks keyboard submission when sending is unavailable", async () => {
    const { requests } = serve(() => undefined, () => session({ capabilities: { canSend: false, canPause: false, canResume: false, canStop: false, canClear: false } }));
    render(<RoomAgentDock activeRoom={room} />);
    const composer = await screen.findByRole("textbox", { name: "Message Room Agent" });
    await screen.findByText("Ready");
    fireEvent.change(composer, { target: { value: "Do not send" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    expect(screen.getByRole("button", { name: "Send to Room Agent" })).toHaveProperty("disabled", true);
    expect(requests.filter((request) => request.method !== "GET")).toEqual([]);
  });

  it("shows a room-selection empty state without requesting a session", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<RoomAgentDock activeRoom={null} />);
    expect(screen.getByText("Select a room to talk to its Room Agent.")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reuses the client request id when an ambiguous send is retried", async () => {
    const bodies: Array<{ content: string; clientRequestId: string }> = [];
    serve((url, method, body) => {
      if (method !== "POST" || !url.endsWith("/messages")) return undefined;
      bodies.push(body);
      if (bodies.length === 1) throw new TypeError("Network response was lost.");
      return Response.json(answering(), { status: 202 });
    });
    render(<RoomAgentDock activeRoom={room} selectedBrowserPaneId="pane:selected-browser" />);
    const composer = await screen.findByRole("textbox", { name: "Message Room Agent" });
    fireEvent.change(composer, { target: { value: "Finish this room safely." } });
    fireEvent.click(screen.getByRole("button", { name: "Send to Room Agent" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Space API request failed before a response.");
    fireEvent.click(screen.getByRole("button", { name: "Send to Room Agent" }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[0]).toMatchObject({ selectedBrowserPaneId: "pane:selected-browser" });
  });

  it("ignores a stale load response after switching rooms", async () => {
    const secondRoom = { ...room, id: "room:agent-dock-2", name: "Second Agent Room" };
    let resolveFirst!: (response: Response) => void;
    let resolveSecond!: (response: Response) => void;
    const firstResponse = new Promise<Response>((resolve) => { resolveFirst = resolve; });
    const secondResponse = new Promise<Response>((resolve) => { resolveSecond = resolve; });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => String(input).includes(encodeURIComponent(secondRoom.id)) ? secondResponse : firstResponse));

    const view = render(<RoomAgentDock activeRoom={room} />);
    view.rerender(<RoomAgentDock activeRoom={secondRoom} />);
    resolveSecond(Response.json(session({ roomId: secondRoom.id, messages: [chat("agent_msg:second", "assistant", "The second room.", 1)] })));
    expect(await screen.findByText("The second room.")).toBeTruthy();
    await act(async () => {
      resolveFirst(Response.json(session({ messages: [chat("agent_msg:stale", "assistant", "Stale first-room answer.", 1)] })));
      await firstResponse;
    });
    expect(screen.queryByText("Stale first-room answer.")).toBeNull();
    expect(screen.getByText("The second room.")).toBeTruthy();
  });

  it("unlocks the new room while a send from the previous room is still pending", async () => {
    const secondRoom = { ...room, id: "room:agent-dock-2", name: "Second Agent Room" };
    let resolveSend!: (response: Response) => void;
    const pendingSend = new Promise<Response>((resolve) => { resolveSend = resolve; });
    serve((url) => {
      if (url.endsWith("/messages")) return pendingSend;
      const roomId = url.includes(encodeURIComponent(secondRoom.id)) ? secondRoom.id : room.id;
      return Response.json(session({ roomId, messages: [chat(`agent_msg:${roomId}`, "assistant", `Answer in ${roomId}.`, 1)] }));
    });
    const view = render(<RoomAgentDock activeRoom={room} />);
    const firstComposer = await screen.findByRole("textbox", { name: "Message Room Agent" });
    fireEvent.change(firstComposer, { target: { value: "Long-running send." } });
    fireEvent.click(screen.getByRole("button", { name: "Send to Room Agent" }));
    expect(screen.getByText("Long-running send.")).toBeTruthy();
    expect(firstComposer).toHaveProperty("disabled", false);

    view.rerender(<RoomAgentDock activeRoom={secondRoom} />);
    expect(await screen.findByText(`Answer in ${secondRoom.id}.`)).toBeTruthy();
    expect(screen.queryByText("Long-running send.")).toBeNull();
    await act(async () => {
      resolveSend(Response.json(session({ messages: [chat("agent_msg:stale-send", "assistant", "Stale send response.", 2)] }), { status: 202 }));
      await pendingSend;
    });
    expect(screen.queryByText("Stale send response.")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Message Room Agent" })).toHaveProperty("disabled", false);
  });

  it("lets an independent request finish while an earlier send is pending and keeps a new draft", async () => {
    const bodies: Array<{ content: string; clientRequestId: string }> = [];
    let finishFirst!: (value: Response) => void;
    const first = new Promise<Response>((resolve) => { finishFirst = resolve; });
    serve((url, method, body) => {
      if (!url.endsWith("/messages")) return undefined;
      bodies.push(body);
      if (bodies.length === 1) return first;
      return Response.json(session({ directCommand: { requestId: body.clientRequestId, status: "COMPLETED", durationMs: 10 } }));
    });
    render(<RoomAgentDock activeRoom={room} />);
    const composer = await screen.findByRole("textbox", { name: "Message Room Agent" });
    fireEvent.change(composer, { target: { value: "search on browser: books" } });
    fireEvent.click(screen.getByRole("button", { name: "Send to Room Agent" }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    fireEvent.change(composer, { target: { value: "pause music" } });
    fireEvent.click(screen.getByRole("button", { name: "Send to Room Agent" }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[0]!.clientRequestId).not.toBe(bodies[1]!.clientRequestId);
    fireEvent.change(composer, { target: { value: "My next unsent request" } });
    await act(async () => { finishFirst(Response.json(session())); await first; });
    await waitFor(() => expect(screen.queryByText("search on browser: books")).toBeNull());
    expect(composer).toHaveProperty("value", "My next unsent request");
  });
});

describe("Room Agent voice input", () => {
  function prepareVoice() {
    const posts: Array<{ url: string; body: any }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") posts.push({ url, body: JSON.parse(String(init.body)) });
      return Response.json(session());
    }));
    let target: any;
    const cancel = vi.fn();
    voiceMock.current = { ownerId: null, status: "idle", settings: { enabled: true, insertMode: "append" },
      serverSettings: { enabled: true }, settingsLoading: false, cancel,
      start: vi.fn(async (next) => { target = next; }), stop: vi.fn(), prewarm: vi.fn() };
    return { posts, cancel, target: () => target };
  }
  it("uses the shared voice capture and submits the composed transcript to the current room", async () => {
    const voice = prepareVoice();
    render(<SpaceRuntimeProvider runtime={liveRuntime}><RoomAgentDock activeRoom={room} /></SpaceRuntimeProvider>);
    await screen.findByRole("textbox", { name: "Message Room Agent" });
    fireEvent.change(screen.getByRole("textbox", { name: "Message Room Agent" }), { target: { value: "Existing instruction" } });
    fireEvent.click(screen.getByRole("button", { name: /Start voice input/ }));
    await act(async () => { await voice.target().onTranscriptComplete("Open one of every CLI"); });
    expect(voice.posts).toHaveLength(1);
    expect(voice.posts[0]!.body.content).toBe("Existing instruction\nOpen one of every CLI");
    expect(voice.posts[0]!.url).toContain(encodeURIComponent(room.id));
  });
  it("cancels voice ownership and discards late transcripts after switching rooms", async () => {
    const voice = prepareVoice();
    const view = render(<SpaceRuntimeProvider runtime={liveRuntime}><RoomAgentDock activeRoom={room} /></SpaceRuntimeProvider>);
    fireEvent.click(await screen.findByRole("button", { name: /Start voice input/ }));
    const oldTarget = voice.target();
    view.rerender(<SpaceRuntimeProvider runtime={liveRuntime}><RoomAgentDock activeRoom={{ ...room, id: "room:other" }} /></SpaceRuntimeProvider>);
    await act(async () => { await oldTarget.onTranscriptComplete("Stop this task"); });
    expect(voice.cancel).toHaveBeenCalledWith(`room-agent:${room.id}`);
    expect(voice.posts).toHaveLength(0);
  });
});

describe("Room Agent dock states", () => {
  it("shows loading before the first load and a retryable error when it fails", async () => {
    const freshRoom = { ...room, id: "room:agent-dock-first-load", name: "First Load Room" };
    let attempt = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    vi.stubGlobal("fetch", vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) {
        await firstGate;
        return Response.json({ error: { code: "ROOM_AGENT_UNAVAILABLE", message: "Room Agent is offline." } }, { status: 503 });
      }
      return Response.json(session({ roomId: freshRoom.id, messages: [] }));
    }));
    render(<RoomAgentDock activeRoom={freshRoom} />);

    expect(screen.getByText("Connecting to the Room Agent…")).toBeTruthy();
    expect(screen.queryByText("What needs doing?")).toBeNull();
    await act(async () => { releaseFirst(); await firstGate; });
    const failure = await screen.findByRole("alert");
    expect(failure.textContent).toContain("The Room Agent could not be reached");
    fireEvent.click(within(failure).getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("What needs doing?")).toBeTruthy();
    expect(screen.getByText("Ready")).toBeTruthy();
  });

  it("shows send errors in a dismissible notice and keeps the draft", async () => {
    serve((url, method) => url.endsWith("/messages") && method === "POST"
      ? Response.json({ error: { code: "ROOM_AGENT_UNAVAILABLE", message: "The Room Agent conversation is unavailable." } }, { status: 503 }) : undefined);
    render(<RoomAgentDock activeRoom={room} />);
    const composer = await screen.findByRole("textbox", { name: "Message Room Agent" });
    await screen.findByText("Ready");
    fireEvent.change(composer, { target: { value: "Run the checks." } });
    fireEvent.click(screen.getByRole("button", { name: "Send to Room Agent" }));
    const alert = await screen.findByRole("alert");
    expect(alert.classList.contains("room-agent-error")).toBe(true);
    fireEvent.click(within(alert).getByRole("button", { name: "Dismiss message" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(composer).toHaveProperty("value", "Run the checks.");
  });

  it("polls only while the dock is visible: every 3 s while answering, every 20 s otherwise", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      let current = session();
      const { fetchMock } = serve(() => undefined, () => current);
      const view = render(<DockActiveContext.Provider value={false}><RoomAgentDock activeRoom={room} /></DockActiveContext.Provider>);
      await screen.findByText("Ready");
      const initialReads = fetchMock.mock.calls.length;
      await act(async () => { vi.advanceTimersByTime(60_000); });
      expect(fetchMock.mock.calls.length).toBe(initialReads);

      view.rerender(<DockActiveContext.Provider value={true}><RoomAgentDock activeRoom={room} /></DockActiveContext.Provider>);
      await act(async () => { vi.advanceTimersByTime(3_100); });
      expect(fetchMock.mock.calls.length).toBe(initialReads);
      await act(async () => { vi.advanceTimersByTime(17_000); });
      await waitFor(() => expect(fetchMock.mock.calls.length).toBe(initialReads + 1));

      current = answering();
      view.rerender(<DockActiveContext.Provider value={true}><RoomAgentDock activeRoom={room} refreshKey="event:turn" /></DockActiveContext.Provider>);
      await screen.findByText("Answering");
      const answeringReads = fetchMock.mock.calls.length;
      await act(async () => { vi.advanceTimersByTime(3_100); });
      await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(answeringReads));
    } finally {
      vi.useRealTimers();
    }
  });
});
