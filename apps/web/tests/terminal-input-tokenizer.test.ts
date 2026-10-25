import { describe, expect, it } from "vitest";
import { createTerminalInputTokenizer } from "../src/features/terminal-pane/terminal-input-tokenizer.js";

describe("terminal input tokenizer", () => {
  it("separates adjacent protocol replies from user bytes without changing byte order", () => {
    const tokenizer = createTerminalInputTokenizer();
    const deviceReply = "\u001b[?1;2c";
    const foregroundColorReply = "\u001b]10;rgb:e8e8/e3e3/d8d8\u0007";
    const backgroundColorReply = "\u001b]11;rgb:0909/0b0b/0c0c\u001b\\";

    expect(tokenizer.push(`${deviceReply}${foregroundColorReply}te${backgroundColorReply}st`)).toEqual([
      { data: `${deviceReply}${foregroundColorReply}`, display: "hidden" },
      { data: "te", display: "visible" },
      { data: backgroundColorReply, display: "hidden" },
      { data: "st", display: "visible" }
    ]);
    expect(tokenizer.flush()).toEqual([]);
  });

  it("recognizes fragmented cursor, Kitty, device, and OSC color replies", () => {
    const tokenizer = createTerminalInputTokenizer();

    expect(tokenizer.push("\u001b[2;")).toEqual([]);
    expect(tokenizer.push("15Rdraft\u001b[?")).toEqual([
      { data: "\u001b[2;15R", display: "hidden" },
      { data: "draft", display: "visible" }
    ]);
    expect(tokenizer.push("0u\u001b[>1;")).toEqual([
      { data: "\u001b[?0u", display: "hidden" }
    ]);
    expect(tokenizer.push("4000;31c\u001b]10;rgb:e8e8/")).toEqual([
      { data: "\u001b[>1;4000;31c", display: "hidden" }
    ]);
    expect(tokenizer.push("e3e3/d8d8\u0007")).toEqual([
      { data: "\u001b]10;rgb:e8e8/e3e3/d8d8\u0007", display: "hidden" }
    ]);
    expect(tokenizer.push("\u001b]4;0;rgb:2e2e/")).toEqual([]);
    expect(tokenizer.push("3434/3636\u001b\\R")).toEqual([
      { data: "\u001b]4;0;rgb:2e2e/3434/3636\u001b\\", display: "hidden" },
      { data: "R", display: "visible" }
    ]);
    expect(tokenizer.flush()).toEqual([]);
  });

  it("classifies terminal focus-in and focus-out events as hidden protocol", () => {
    const tokenizer = createTerminalInputTokenizer();

    expect(tokenizer.push("\u001b[IR")).toEqual([
      { data: "\u001b[I", display: "hidden" },
      { data: "R", display: "visible" }
    ]);
    expect(tokenizer.push("\u001b[O")).toEqual([
      { data: "\u001b[O", display: "hidden" }
    ]);
    expect(tokenizer.flush()).toEqual([]);
  });

  it("classifies private-mode status and palette color reports as hidden protocol", () => {
    const tokenizer = createTerminalInputTokenizer();
    const synchronizedOutput = "\u001b[?2026;2$y";
    const graphemeClustering = "\u001b[?2027;0$y";
    const paletteColor = "\u001b]4;0;rgb:2e2e/3434/3636\u001b\\";

    expect(tokenizer.push(`${synchronizedOutput}${graphemeClustering}${paletteColor}R`)).toEqual([
      {
        data: `${synchronizedOutput}${graphemeClustering}${paletteColor}`,
        display: "hidden"
      },
      { data: "R", display: "visible" }
    ]);
    expect(tokenizer.flush()).toEqual([]);
  });

  it("preserves arrow keys, bracketed paste, text, and a standalone Escape exactly", () => {
    const tokenizer = createTerminalInputTokenizer();
    const userInput = "\u001b[A\u001b[D\u001b[200~paste\u001b[201~";

    expect(tokenizer.push(userInput)).toEqual([
      { data: userInput, display: "visible" }
    ]);
    expect(tokenizer.push("\u001b")).toEqual([]);
    expect(tokenizer.flush()).toEqual([
      { data: "\u001b", display: "visible" }
    ]);
  });

  it("fails open for oversized or invalid protocol-looking input", () => {
    const tokenizer = createTerminalInputTokenizer({ maxPendingBytes: 32 });
    const invalid = `\u001b]11;${"x".repeat(40)}`;

    expect(tokenizer.push(invalid)).toEqual([
      { data: invalid, display: "visible" }
    ]);
    expect(tokenizer.flush()).toEqual([]);
  });
});
