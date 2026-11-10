import { describe, expect, it } from "vitest";
import { projectRoomTerminalRuns, projectRoomTerminalScreen, styledRunsFor } from "../src/room-terminal-screen.js";

describe("projectRoomTerminalRuns (SpaceApp Android R9)", () => {
  it("projects SGR and truecolor cells to merged runs beside the unchanged text", async () => {
    const chunks = ["\x1b[1;31mred\x1b[0m plain \x1b[38;2;1;2;3mrgb"];
    const { text, runs } = await projectRoomTerminalRuns(chunks, 40, 1);
    expect(runs).toEqual([[{ text: "red", fg: 1, bold: true }, { text: " plain " }, { text: "rgb", fg: "#010203" }]]);
    expect(text).toBe(await projectRoomTerminalScreen(chunks, 40, 1));
  });

  it("gives one plain run per line of an unstyled screen", async () => {
    const { text, runs } = await projectRoomTerminalRuns(["one\r\ntwo"], 20, 2);
    expect(text).toBe("one\ntwo");
    expect(runs).toEqual([[{ text: "one" }], [{ text: "two" }]]);
  });

  it("joins wrapped lines and blanks faint cells as unstyled spaces", async () => {
    const wrapped = await projectRoomTerminalRuns(["\x1b[32mabcdef\x1b[0m"], 4, 2, true);
    expect(wrapped).toEqual({ text: "abcdef", runs: [[{ text: "abcdef", fg: 2 }]] });
    const faint = await projectRoomTerminalRuns(["> \x1b[2mhint\x1b[0m"], 20, 1, false, true);
    expect(faint).toEqual({ text: ">", runs: [[{ text: ">" }]] });
  });

  it("sends a line whose text redaction changed as plain text, and leaves out runs past the bound", async () => {
    const { runs } = await projectRoomTerminalRuns(["\x1b[31mtoken sk-secret\x1b[0m\r\n\x1b[34mok\x1b[0m"], 30, 2);
    expect(styledRunsFor("token [redacted]\nok", runs)).toEqual({ runs: [[{ text: "token [redacted]" }], [{ text: "ok", fg: 4 }]] });
    expect(styledRunsFor("a transcript, not the screen", runs)).toEqual({});
    const cells = Array.from({ length: 200 }, () => Array.from({ length: 300 }, (_, x) => `\x1b[38;5;${x % 256}mx`).join("")).join("\r\n");
    const big = await projectRoomTerminalRuns([cells], 300, 200);
    expect(styledRunsFor(big.text, big.runs)).toEqual({ runsOmitted: "TOO_LARGE" });
  });
});

describe("a cancellable projection (model-settings/status, 4/11)", () => {
  it("reads the same screen in slices and stops once its signal aborts", async () => {
    // An SGR sequence split by the first 512 KiB slice still colours the same cells.
    const chunks = ["a".repeat(512 * 1024 - 3) + "\x1b[1;31mred\x1b[0m\r\n> ", "b".repeat(700 * 1024)];
    const whole = await projectRoomTerminalRuns(chunks, 100, 30);
    expect(await projectRoomTerminalRuns(chunks, 100, 30, false, false, new AbortController().signal)).toEqual(whole);

    const reading = new AbortController();
    const read = projectRoomTerminalScreen(["c".repeat(4 * 1024 * 1024)], 100, 30, false, false, reading.signal);
    setTimeout(() => reading.abort(new Error("The client left.")), 0);
    await expect(read).rejects.toThrow("The client left.");
  });

  it("feeds a large replay in 64 KiB writes, and a sequence or a character cut between two writes stays whole", async () => {
    // Window-title sequences pad the replay without printing (4/11: one 8 MiB write held the API's main thread 1.5 s).
    const title = (length: number) => `\x1b]0;${"t".repeat(length - 5)}\x07`;
    let content = `${title(64 * 1024 - 3)}\x1b[1;31mred\x1b[0m `;
    content += `${title(128 * 1024 - 1 - content.length)}😀\r\n> `;
    expect(content.indexOf("😀")).toBe(128 * 1024 - 1);
    const { text, runs } = await projectRoomTerminalRuns([content], 100, 30);
    expect(text.split("\n").slice(0, 2)).toEqual(["red 😀", "> "]);
    expect(runs[0]![0]).toMatchObject({ text: "red", bold: true });
    expect(runs[0]![0]!.fg).toBeDefined();
  });
});
