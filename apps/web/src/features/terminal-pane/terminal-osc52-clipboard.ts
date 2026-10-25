/**
 * TUIs that capture the mouse (Claude Code's fullscreen renderer, the opencode
 * TUI) draw their own text selection, so xterm.js never holds it. They hand
 * the selected text to the terminal with an OSC 52 clipboard write instead,
 * which xterm.js consumes without acting on. This scanner extracts those
 * writes from live PTY output so the pane can copy the CLI's own selection.
 */

const OSC52_PREFIX = "\u001b]52;";
const ESCAPE = "\u001b";
const BELL = "\u0007";
const OSC52_SELECTION_TARGETS = /^[cpqs0-7]*$/;
const OSC52_BASE64_PAYLOAD = /^[A-Za-z0-9+/]+={0,2}$/;
const OSC52_BODY_CHARACTER = /[A-Za-z0-9+/=;]/;

export const OSC52_MAX_DECODED_BYTES = 1024 * 1024;
const OSC52_MAX_SEQUENCE_CHARS = OSC52_PREFIX.length + 16 + Math.ceil(OSC52_MAX_DECODED_BYTES / 3) * 4;

/** Decodes an OSC 52 body (`<targets>;<base64>`). Read queries (`?`) and malformed or oversized payloads return null. */
export function decodeOsc52ClipboardWrite(body: string): string | null {
  const separator = body.indexOf(";");
  if (separator < 0) return null;
  const targets = body.slice(0, separator);
  const payload = body.slice(separator + 1);
  if (!OSC52_SELECTION_TARGETS.test(targets)) return null;
  // "?" asks the terminal to report the clipboard back to the app; never answer it.
  if (!OSC52_BASE64_PAYLOAD.test(payload) || payload.length % 4 === 1) return null;
  if (Math.floor((payload.length * 3) / 4) > OSC52_MAX_DECODED_BYTES) return null;
  try {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

function partialPrefixLength(data: string): number {
  const maximum = Math.min(data.length, OSC52_PREFIX.length - 1);
  for (let length = maximum; length > 0; length -= 1) {
    if (OSC52_PREFIX.startsWith(data.slice(-length))) return length;
  }
  return 0;
}

/** Streams PTY output and returns the text of every complete OSC 52 clipboard write, across chunk boundaries. */
export function createOsc52ClipboardScanner(maxSequenceChars = OSC52_MAX_SEQUENCE_CHARS) {
  let carry = "";

  return {
    push(data: string): string[] {
      if (!data) return [];
      const text = carry ? carry + data : data;
      carry = "";
      const writes: string[] = [];
      let cursor = 0;
      while (cursor < text.length) {
        const start = text.indexOf(OSC52_PREFIX, cursor);
        if (start < 0) {
          const partial = partialPrefixLength(text);
          if (partial > 0 && text.length - partial >= cursor) carry = text.slice(-partial);
          break;
        }
        const bodyStart = start + OSC52_PREFIX.length;
        let index = bodyStart;
        while (index < text.length && OSC52_BODY_CHARACTER.test(text[index]!)) index += 1;
        if (index >= text.length || (text[index] === ESCAPE && index + 1 >= text.length)) {
          if (text.length - start <= maxSequenceChars) carry = text.slice(start);
          break;
        }
        let terminatorLength = 0;
        if (text[index] === BELL) terminatorLength = 1;
        else if (text[index] === ESCAPE && text[index + 1] === "\\") terminatorLength = 2;
        if (terminatorLength > 0 && index - start <= maxSequenceChars) {
          const decoded = decodeOsc52ClipboardWrite(text.slice(bodyStart, index));
          if (decoded) writes.push(decoded);
        }
        // Any other byte aborts the sequence, as it does in the terminal parser.
        cursor = index + terminatorLength;
      }
      return writes;
    },
    reset(): void {
      carry = "";
    }
  };
}
