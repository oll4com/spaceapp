import { describe, expect, it } from "vitest";
import { nextTerminalPromptDraft, resolveTerminalPasteMode } from "../src/features/terminal-pane/TerminalPane.js";

const BRACKETED_PASTE_START = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";

describe("nextTerminalPromptDraft bracketed paste handling", () => {
  it("appends regular characters to prompt draft", () => {
    const initial = { text: "hello", cursor: 5 };
    const result = nextTerminalPromptDraft(initial, " world");
    expect(result).toEqual({ text: "hello world", cursor: 11 });
  });

  it("clears prompt draft on unbracketed Return (\\r)", () => {
    const initial = { text: "command to run", cursor: 14 };
    const result = nextTerminalPromptDraft(initial, "\r");
    expect(result).toEqual({ text: "", cursor: 0 });
  });

  it("preserves newlines in prompt draft when enclosed in bracketed paste", () => {
    const initial = { text: "", cursor: 0 };
    const multilinePaste = `${BRACKETED_PASTE_START}first line\rsecond line\rthird line${BRACKETED_PASTE_END}`;
    const result = nextTerminalPromptDraft(initial, multilinePaste);
    expect(result).not.toBeNull();
    expect(result?.text).toBe("first line\nsecond line\nthird line");
    expect(result?.cursor).toBe("first line\nsecond line\nthird line".length);
  });

  it("handles \\n newlines within bracketed paste as well", () => {
    const initial = { text: "prefix: ", cursor: 8 };
    const multilinePaste = `${BRACKETED_PASTE_START}line A\nline B${BRACKETED_PASTE_END}`;
    const result = nextTerminalPromptDraft(initial, multilinePaste);
    expect(result).not.toBeNull();
    expect(result?.text).toBe("prefix: line A\nline B");
    expect(result?.cursor).toBe("prefix: line A\nline B".length);
  });

  it("clears prompt draft on Return (\\r) after bracketed paste ends", () => {
    const initial = { text: "", cursor: 0 };
    const multilinePaste = `${BRACKETED_PASTE_START}line 1\rline 2${BRACKETED_PASTE_END}`;
    const afterPaste = nextTerminalPromptDraft(initial, multilinePaste);
    expect(afterPaste?.text).toBe("line 1\nline 2");

    // After paste ends, user presses Enter to submit the multiline prompt
    const afterSubmit = nextTerminalPromptDraft(afterPaste!, "\r");
    expect(afterSubmit).toEqual({ text: "", cursor: 0 });
  });

  it("preserves text typed before and after bracketed paste", () => {
    let state = { text: "", cursor: 0 };
    state = nextTerminalPromptDraft(state, "prompt: ")!;
    state = nextTerminalPromptDraft(state, `${BRACKETED_PASTE_START}multiline\rblock${BRACKETED_PASTE_END}`)!;
    state = nextTerminalPromptDraft(state, " (done)")!;

    expect(state.text).toBe("prompt: multiline\nblock (done)");
    expect(state.cursor).toBe("prompt: multiline\nblock (done)".length);
  });
});

describe("resolveTerminalPasteMode routing decisions", () => {
  it("routes single line text directly as raw input", () => {
    const decision = resolveTerminalPasteMode({
      isLoginPurpose: false,
      hasNewlines: false,
      lineCount: 1,
      charCount: 25,
      bracketedPasteSupported: true
    });
    expect(decision).toBe("raw");
  });

  it("routes input directly as raw when login purpose is active even if multiline", () => {
    const decision = resolveTerminalPasteMode({
      isLoginPurpose: true,
      hasNewlines: true,
      lineCount: 2,
      charCount: 30,
      bracketedPasteSupported: true
    });
    expect(decision).toBe("raw");
  });

  it("routes moderate multiline text as bracketed paste when supported", () => {
    const decision = resolveTerminalPasteMode({
      isLoginPurpose: false,
      hasNewlines: true,
      lineCount: 5,
      charCount: 150,
      bracketedPasteSupported: true
    });
    expect(decision).toBe("bracketed");
  });

  it("falls back to file upload when bracketed paste is not supported", () => {
    const decision = resolveTerminalPasteMode({
      isLoginPurpose: false,
      hasNewlines: true,
      lineCount: 3,
      charCount: 50,
      bracketedPasteSupported: false
    });
    expect(decision).toBe("file");
  });

  it("attaches as file when line count exceeds threshold (>30 lines)", () => {
    const decision = resolveTerminalPasteMode({
      isLoginPurpose: false,
      hasNewlines: true,
      lineCount: 31,
      charCount: 500,
      bracketedPasteSupported: true
    });
    expect(decision).toBe("file");
  });

  it("attaches as file when character count exceeds threshold (>4000 characters)", () => {
    const decision = resolveTerminalPasteMode({
      isLoginPurpose: false,
      hasNewlines: true,
      lineCount: 10,
      charCount: 4001,
      bracketedPasteSupported: true
    });
    expect(decision).toBe("file");
  });
});
