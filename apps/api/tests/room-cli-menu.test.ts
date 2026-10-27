import { describe, expect, it, vi } from "vitest";
import { resumeRoomCliFromMenu, selectRoomCliMenuRow, type RoomCliScreen } from "../src/room-cli-menu.js";

function fakeMenu(rows: string[], start = 0) {
  let cursor = start;
  let revision = 1;
  let picked: string | null = null;
  const sent: string[] = [];
  const render = (): RoomCliScreen => ({
    text: picked ? `Set model to ${picked}` : rows.map((row, index) => `${index === cursor ? "❯" : " "} ${row}`).join("\n"),
    revision
  });
  return {
    sent,
    screen: render(),
    send: async (data: string) => {
      sent.push(data);
      if (data === "\u001b[B") cursor = Math.min(cursor + 1, rows.length - 1);
      if (data === "\r") picked = rows[cursor]!;
      revision++;
    },
    observe: async () => render(),
    wait: async () => {}
  };
}

describe("selectRoomCliMenuRow", () => {
  it("moves down to the named row and picks it", async () => {
    const menu = fakeMenu(["Default", "Opus", "Haiku"]);
    const screen = await selectRoomCliMenuRow({ ...menu, selection: "Haiku", command: "/model" });
    expect(menu.sent).toEqual(["\u001b[B", "\u001b[B", "\r"]);
    expect(screen.text).toBe("Set model to Haiku");
  });

  it("closes the menu its command opened when the row is missing", async () => {
    const menu = fakeMenu(["Default", "Opus"]);
    await expect(selectRoomCliMenuRow({ ...menu, selection: "Sonnet", command: "/model" }))
      .rejects.toThrow("could not be verified");
    expect(menu.sent).toEqual(["\u001b"]);
  });

  it("refuses a selection the CLI never acknowledges", async () => {
    const menu = fakeMenu(["Default"]);
    await expect(selectRoomCliMenuRow({ ...menu, send: async () => {}, selection: "Default" }))
      .rejects.toThrow("did not acknowledge");
  });
});

describe("native /resume menu fallback", () => {
  const ready = { sessionId: "cli_session:live", status: "RUNNING" };
  it("types nothing when the task already runs in the live session (Hermes omits it from /resume)", async () => {
    const command = vi.fn(async () => ({}));
    await expect(resumeRoomCliFromMenu({ paneId: "pane:leo", ready, source: { title: "Leo task", session: { sessionId: "cli_session:live" } }, command }))
      .resolves.toEqual({ paneId: "pane:leo", sessionId: "cli_session:live", state: "RUNNING" });
    expect(command).not.toHaveBeenCalled();
  });
  it("opens the menu on the task's title for an older session, and without one when no task is named", async () => {
    const command = vi.fn(async () => ({ sessionId: "cli_session:live" }));
    await expect(resumeRoomCliFromMenu({ paneId: "pane:leo", ready, source: { title: "Older task", session: { sessionId: "cli_session:old" } }, command }))
      .resolves.toMatchObject({ phase: "NATIVE_RESUME_MENU", sessionId: "cli_session:live" });
    await resumeRoomCliFromMenu({ paneId: "pane:leo", ready, source: null, command });
    expect(command.mock.calls).toEqual([["Older task"], [undefined]]);
  });
});
