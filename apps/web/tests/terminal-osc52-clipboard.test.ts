import { describe, expect, it } from "vitest";
import {
  OSC52_MAX_DECODED_BYTES,
  createOsc52ClipboardScanner,
  decodeOsc52ClipboardWrite
} from "../src/features/terminal-pane/terminal-osc52-clipboard.js";

function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function osc52(text: string, terminator = "\u0007", targets = "c"): string {
  return `\u001b]52;${targets};${base64(text)}${terminator}`;
}

describe("decodeOsc52ClipboardWrite", () => {
  it("decodes UTF-8 clipboard writes for every selection target", () => {
    expect(decodeOsc52ClipboardWrite(`c;${base64("Γεια σου, κόσμε ✓")}`)).toBe("Γεια σου, κόσμε ✓");
    expect(decodeOsc52ClipboardWrite(`;${base64("default target")}`)).toBe("default target");
    expect(decodeOsc52ClipboardWrite(`ps0;${base64("primary")}`)).toBe("primary");
  });

  it("never answers clipboard read queries and rejects malformed payloads", () => {
    expect(decodeOsc52ClipboardWrite("c;?")).toBeNull();
    expect(decodeOsc52ClipboardWrite("c;")).toBeNull();
    expect(decodeOsc52ClipboardWrite("c")).toBeNull();
    expect(decodeOsc52ClipboardWrite(`x;${base64("bad target")}`)).toBeNull();
    expect(decodeOsc52ClipboardWrite("c;not base64!")).toBeNull();
    expect(decodeOsc52ClipboardWrite("c;QQ=Q")).toBeNull();
    expect(decodeOsc52ClipboardWrite(`c;${btoa("\xff\xfe")}`)).toBeNull();
  });

  it("rejects payloads beyond the decoded size cap", () => {
    const payload = "A".repeat(Math.ceil(OSC52_MAX_DECODED_BYTES / 3) * 4 + 4);
    expect(decodeOsc52ClipboardWrite(`c;${payload}`)).toBeNull();
  });
});

describe("createOsc52ClipboardScanner", () => {
  it("extracts BEL and ST terminated writes surrounded by normal output", () => {
    const scanner = createOsc52ClipboardScanner();
    const writes = scanner.push(
      `\u001b[2J\u001b[Hframe${osc52("first selection")}more${osc52("second", "\u001b\\")}\u001b[?25h`
    );
    expect(writes).toEqual(["first selection", "second"]);
  });

  it("joins a write that is split across output chunks, including inside the prefix", () => {
    const sequence = `before${osc52("split selection ✓", "\u001b\\")}after`;
    for (let split = 1; split < sequence.length; split += 1) {
      const scanner = createOsc52ClipboardScanner();
      const writes = [...scanner.push(sequence.slice(0, split)), ...scanner.push(sequence.slice(split))];
      expect(writes, `split at ${split}`).toEqual(["split selection ✓"]);
    }
  });

  it("ignores read queries, other OSC sequences and aborted writes", () => {
    const scanner = createOsc52ClipboardScanner();
    expect(scanner.push("\u001b]52;c;?\u0007\u001b]0;title\u0007\u001b]66;w=2;x\u001b\\")).toEqual([]);
    expect(scanner.push(`\u001b]52;c;QUJD\u001b[31mred${osc52("after abort")}`)).toEqual(["after abort"]);
  });

  it("drops an unterminated write once it exceeds the sequence cap", () => {
    const scanner = createOsc52ClipboardScanner(64);
    expect(scanner.push(`\u001b]52;c;${"A".repeat(80)}`)).toEqual([]);
    expect(scanner.push("QQ==\u0007")).toEqual([]);
    expect(scanner.push(osc52("next"))).toEqual(["next"]);
  });

  it("forgets a pending partial write on reset", () => {
    const scanner = createOsc52ClipboardScanner();
    expect(scanner.push("\u001b]52;c;QU")).toEqual([]);
    scanner.reset();
    expect(scanner.push("JD\u0007")).toEqual([]);
  });
});
