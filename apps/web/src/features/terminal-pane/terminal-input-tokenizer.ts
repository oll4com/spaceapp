export interface TerminalInputSegment {
  data: string;
  display: "visible" | "hidden";
}

export interface TerminalInputTokenizerOptions {
  maxPendingBytes?: number;
}

const DEFAULT_MAX_PENDING_BYTES = 256;
const ESCAPE = "\u001b";
const CSI = `${ESCAPE}[`;
const OSC = `${ESCAPE}]`;
const OSC_COLOR_PREFIXES = [
  `${OSC}4;`,
  `${OSC}10;rgb:`,
  `${OSC}11;rgb:`,
  `${OSC}12;rgb:`
] as const;
const OSC_COLOR_REPLY_PATTERN =
  /^\u001b\](?:4;[0-9]{1,3}|10|11|12);rgb:[0-9a-f]{1,4}(?:\/[0-9a-f]{1,4}){2}(?:\u0007|\u001b\\)/i;
const CSI_CURSOR_REPLY_PATTERN = /^\u001b\[\??\d{1,4};\d{1,4}R/;
const CSI_DEVICE_REPLY_PATTERN = /^\u001b\[[?>][0-9;]{0,32}c/;
const CSI_KITTY_REPLY_PATTERN = /^\u001b\[\?[0-9;]{0,32}u/;
const CSI_FOCUS_EVENT_PATTERN = /^\u001b\[[IO]/;
const CSI_PRIVATE_MODE_STATUS_PATTERN = /^\u001b\[\?[0-9;]{1,32}\$y/;

function appendSegment(
  segments: TerminalInputSegment[],
  display: TerminalInputSegment["display"],
  data: string
) {
  if (!data) return;
  const previous = segments.at(-1);
  if (previous?.display === display) {
    previous.data += data;
    return;
  }
  segments.push({ data, display });
}

function oscTerminatorEnd(data: string): number | null {
  const bell = data.indexOf("\u0007", OSC.length);
  const stringTerminator = data.indexOf(`${ESCAPE}\\`, OSC.length);
  if (bell < 0 && stringTerminator < 0) return null;
  if (bell >= 0 && (stringTerminator < 0 || bell < stringTerminator)) return bell + 1;
  return stringTerminator + 2;
}

function csiTokenEnd(data: string): number | null {
  for (let index = CSI.length; index < data.length; index += 1) {
    const code = data.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) return index + 1;
  }
  return null;
}

function completeProtocolToken(data: string): string | null {
  return (
    OSC_COLOR_REPLY_PATTERN.exec(data)?.[0] ??
    CSI_CURSOR_REPLY_PATTERN.exec(data)?.[0] ??
    CSI_DEVICE_REPLY_PATTERN.exec(data)?.[0] ??
    CSI_KITTY_REPLY_PATTERN.exec(data)?.[0] ??
    CSI_FOCUS_EVENT_PATTERN.exec(data)?.[0] ??
    CSI_PRIVATE_MODE_STATUS_PATTERN.exec(data)?.[0] ??
    null
  );
}

function couldBeOscColorReply(data: string): boolean {
  return OSC_COLOR_PREFIXES.some((prefix) => prefix.startsWith(data) || data.startsWith(prefix));
}

export function createTerminalInputTokenizer(
  options: TerminalInputTokenizerOptions = {}
) {
  const maxPendingBytes = Number.isInteger(options.maxPendingBytes) && (options.maxPendingBytes ?? 0) > 0
    ? options.maxPendingBytes!
    : DEFAULT_MAX_PENDING_BYTES;
  let pending = "";

  const tokenize = (): TerminalInputSegment[] => {
    const segments: TerminalInputSegment[] = [];
    while (pending) {
      const escapeIndex = pending.indexOf(ESCAPE);
      if (escapeIndex < 0) {
        appendSegment(segments, "visible", pending);
        pending = "";
        break;
      }
      if (escapeIndex > 0) {
        appendSegment(segments, "visible", pending.slice(0, escapeIndex));
        pending = pending.slice(escapeIndex);
        continue;
      }

      const protocolToken = completeProtocolToken(pending);
      if (protocolToken) {
        appendSegment(segments, "hidden", protocolToken);
        pending = pending.slice(protocolToken.length);
        continue;
      }

      if (pending === ESCAPE) break;
      if (pending.startsWith(OSC)) {
        if (couldBeOscColorReply(pending)) {
          const terminatorEnd = oscTerminatorEnd(pending);
          if (terminatorEnd === null && pending.length <= maxPendingBytes) break;
          const visibleLength = terminatorEnd ?? pending.length;
          appendSegment(segments, "visible", pending.slice(0, visibleLength));
          pending = pending.slice(visibleLength);
          continue;
        }
        const terminatorEnd = oscTerminatorEnd(pending);
        const visibleLength = terminatorEnd ?? pending.length;
        appendSegment(segments, "visible", pending.slice(0, visibleLength));
        pending = pending.slice(visibleLength);
        continue;
      }
      if (pending.startsWith(CSI)) {
        const tokenEnd = csiTokenEnd(pending);
        if (tokenEnd === null && pending.length <= maxPendingBytes) break;
        const visibleLength = tokenEnd ?? pending.length;
        appendSegment(segments, "visible", pending.slice(0, visibleLength));
        pending = pending.slice(visibleLength);
        continue;
      }

      appendSegment(segments, "visible", pending.slice(0, 2));
      pending = pending.slice(2);
    }
    return segments;
  };

  return {
    push(data: string): TerminalInputSegment[] {
      pending += data;
      if (pending.length > maxPendingBytes && pending.startsWith(ESCAPE)) {
        const dataToFlush = pending;
        pending = "";
        return [{ data: dataToFlush, display: "visible" }];
      }
      return tokenize();
    },
    flush(): TerminalInputSegment[] {
      if (!pending) return [];
      const data = pending;
      pending = "";
      return [{ data, display: "visible" }];
    },
    hasPending(): boolean {
      return Boolean(pending);
    }
  };
}

export function isNonMutatingTerminalProtocolResponse(data: string): boolean {
  if (!data) return false;
  const tokenizer = createTerminalInputTokenizer({ maxPendingBytes: Math.max(DEFAULT_MAX_PENDING_BYTES, data.length) });
  const segments = tokenizer.push(data);
  return (
    !tokenizer.hasPending() &&
    segments.length > 0 &&
    segments.every((segment) => segment.display === "hidden") &&
    segments.map((segment) => segment.data).join("") === data
  );
}
