import { afterEach, describe, expect, it } from "vitest";
import { installMockStorage } from "../src/demo/mock-storage.js";
import { createDemoRuntime } from "../src/demo/demo-runtime.js";
import { createCurrentMockFixture } from "../src/demo/mock-fixture.js";

const names = ["localStorage", "sessionStorage", "fetch", "WebSocket", "EventSource", "XMLHttpRequest", "open"] as const;
const original = Object.fromEntries(names.map(name => [name, Object.getOwnPropertyDescriptor(window, name)]));
const beacon = Object.getOwnPropertyDescriptor(navigator, "sendBeacon");
afterEach(() => {
  for (const name of names) {
    const descriptor = original[name];
    if (descriptor) Object.defineProperty(window, name, descriptor);
    else Reflect.deleteProperty(window, name);
  }
  if (beacon) Object.defineProperty(navigator, "sendBeacon", beacon);
  else Reflect.deleteProperty(navigator, "sendBeacon");
});
describe("isolated public demo terminal transport", () => {
  it("starts each document from the preset without reading or clearing another workspace", async () => {
    const physicalLocal = window.localStorage;
    const physicalSession = window.sessionStorage;
    const oldKeys = {
      "spaceapp.demoappnew.current.v2.workspace.snapshot": "old saved workspace",
      "spaceapp.demoappnew.current.v2.space.uiTheme.v1": "classic",
      "spaceapp.demoappnew.current.v1.workspace.snapshot": "older workspace",
      "unrelated-application": "keep"
    };
    for (const [key, value] of Object.entries(oldKeys)) physicalLocal.setItem(key, value);
    physicalSession.setItem("unrelated-session", "keep");
    installMockStorage();
    expect(window.localStorage.getItem("workspace.snapshot")).toBeNull();
    expect(window.localStorage.getItem("space.uiTheme.v1")).toBe("modern");
    window.localStorage.setItem("workspace.snapshot", "changed demo");
    window.localStorage.setItem("space.uiTheme.v1", "classic");
    window.sessionStorage.setItem("space.selectedRoomId.user:demo-user", "room:demo-ops");
    // A new document gets new transient storage, just as a page refresh does.
    installMockStorage();
    expect(window.localStorage.getItem("workspace.snapshot")).toBeNull();
    expect(window.localStorage.getItem("space.uiTheme.v1")).toBe("modern");
    // The demo opens on Research Lab on every load, whatever room the last visit chose.
    expect(window.sessionStorage.getItem("space.selectedRoomId.user:demo-user")).toBe("room:demo-research");
    const { runtime } = createDemoRuntime({ fixture: createCurrentMockFixture(), localStorage: window.localStorage, sessionStorage: window.sessionStorage });
    expect((await runtime.api.rooms()).data.map(room => room.name)).toEqual(["Room 1", "Research Lab", "Operations", "Copilots"]);
    for (const [key, value] of Object.entries(oldKeys)) {
      expect(physicalLocal.getItem(key)).toBe(value);
      physicalLocal.removeItem(key);
    }
    expect(physicalSession.getItem("unrelated-session")).toBe("keep");
    physicalSession.removeItem("unrelated-session");
  });
  it("blocks real sockets while preserving the state constants needed by the canonical terminal", async () => {
    installMockStorage();
    expect(() => new WebSocket("wss://private.test/")).toThrow("local simulated services");
    expect([WebSocket.CONNECTING, WebSocket.OPEN, WebSocket.CLOSING, WebSocket.CLOSED]).toEqual([0, 1, 2, 3]);
    const { runtime } = createDemoRuntime({ fixture: createCurrentMockFixture() });
    const pane = (await runtime.api.panes((await runtime.api.rooms()).data[0]!.id)).data[0]!;
    const session = await runtime.api.activeCliSession(pane.id);
    const socket = runtime.terminal.connect(runtime.api.cliTerminalWebSocketUrl(session!.websocket!));
    await new Promise(resolve => socket.addEventListener("open", resolve, { once: true }));
    expect(socket.readyState).toBe(WebSocket.OPEN);
    const output = new Promise<string>(resolve => socket.addEventListener("message", event => {
      const data = JSON.parse((event as MessageEvent).data);
      if (data.type === "output") resolve(data.data);
    }));
    socket.send(JSON.stringify({ type: "input", data: "transport proof\r" }));
    expect(await output).toContain("Received: transport proof");
    socket.close();
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });
});
