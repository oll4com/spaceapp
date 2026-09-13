import headless from "@xterm/headless";
import type { PaneCliSession } from "@space/contracts";

/** Only confirmed dimensions of this host generation describe its replay. */
export function restoreRoomTerminalGeometry(generationId: string, restored: boolean,
  persisted: PaneCliSession["terminalGeometry"], initial?: { cols: number; rows: number }) {
  if (!restored) return initial ?? { cols: 100, rows: 30 };
  return persisted?.generationId === generationId ? { cols: persisted.cols, rows: persisted.rows } : null;
}

/** Bounded, on-demand terminal projection; does not mount or resize the live pane. */
export async function projectRoomTerminalScreen(chunks: string[], cols = 100, rows = 30, unwrap = false): Promise<string> {
  const terminal = new headless.Terminal({ cols, rows, scrollback: 0, allowProposedApi: true });
  try {
    // The host already retains at most 8 MiB. Cutting that replay again can
    // discard an unchanged composer or split an ANSI command, leaving only
    // animation deltas on an otherwise blank screen. Reject oversized input
    // instead of silently treating a partial reconstruction as current state.
    const content = chunks.join("");
    if (Buffer.byteLength(content, "utf8") > 8 * 1024 * 1024) throw new Error("Room terminal replay exceeds the projection limit.");
    await new Promise<void>((resolve) => terminal.write(content, resolve));
    const buffer = terminal.buffer.active;
    const lines: string[] = [];
    for (let index = 0; index < buffer.length; index++) {
      const line = buffer.getLine(index);
      const text = line?.translateToString(!(unwrap && buffer.getLine(index + 1)?.isWrapped)) ?? '';
      if (unwrap && line?.isWrapped && lines.length) lines[lines.length - 1] += text;
      else lines.push(text);
    }
    return lines.join('\n');
  } finally { terminal.dispose(); }
}

export function roomTerminalState(screen: string): "RUNNING" | "IDLE" | "WAITING_FOR_INPUT" | "UNKNOWN" {
  if (/esc(?:ape)?\s+to\s+(?:interrupt|cancel)|thinking[.…]|working[.…]|ctrl\+c to interrupt/i.test(screen)) return "RUNNING";
  if (/select (?:a |an )?(?:session|model|option)|enter to (?:confirm|select)|allow (?:once|always)|approve this|do you want to proceed/i.test(screen)) return "WAITING_FOR_INPUT";
  if (/(?:^|\n)\s*[❯›>]\s*[^\n]*$/m.test(screen) || /(?:ask anything|type your message|send a message)/i.test(screen)) return "IDLE";
  return "UNKNOWN";
}

export function roomTerminalCommands(screen: string): string[] {
  return [...new Set(screen.match(/\/[a-z][a-z0-9_-]*(?=\s|$)/gi) ?? [])].slice(0, 100);
}

/** The server becomes idle before a fresh OpenCode attach renders its input. */
export function roomOpenCodeTerminalState(screen: string, isTurnActive: boolean, advertisedModes: string[]) {
  if (isTurnActive) return "RUNNING" as const;
  if (roomTerminalState(screen) === "WAITING_FOR_INPUT") return "WAITING_FOR_INPUT" as const;
  return roomTerminalMode("cli:opencode", screen, advertisedModes) ? "IDLE" as const : "UNKNOWN" as const;
}

export function roomTerminalMode(runtimeId: string, screen: string, advertisedModes: string[] = []): string | null {
  const footer = screen.split(/\r?\n/).map((line) => line.toLowerCase().replace(/\s+/g, " ").trim()).filter(Boolean).slice(-4);
  if (runtimeId === "cli:claude") {
    for (const line of [...footer].reverse()) {
      const context = footer.join(" ");
      if (!context.includes("for agents")) continue;
      if (context.includes("shift+tab to cycle")) {
        for (const [label, mode] of [["plan mode on", "plan"], ["accept edits on", "accept edits"], ["bypass permissions on", "bypass permissions"], ["auto mode on", "auto"]]) {
          if (line.includes(label!)) return mode!;
        }
      }
      if (line.includes("? for shortcuts")) return "default";
    }
    return null;
  }
  const text = footer.join("\n");
  if (runtimeId === "cli:opencode") {
    const hasAgentHint = /\btab agents\b/.test(text);
    return advertisedModes.find((mode) => footer.some((line, index) => {
      const label = line.replace(/^[┃│║]\s*/, "");
      const hasSeparator = label.startsWith(`${mode.toLowerCase()} · `);
      if (!hasSeparator && !label.startsWith(`${mode.toLowerCase()} `)) return false;
      // Compact OpenCode panes can omit the shortcut row. Require the empty
      // input rail and its closing border together, optionally followed by
      // the native cwd/context status row, never a historical
      // "▣ Build · model · 1.9s" result or prose mentioning a mode.
      return (hasAgentHint && hasSeparator) || (/^[┃│║]\s/.test(line) &&
        /^[┃│║]$/.test(footer[index - 1] ?? "") &&
        /^╹[▀━─]{3,}$/.test(footer[index + 1] ?? "") &&
        (index + 2 === footer.length || (index + 3 === footer.length &&
          /^(?:\/|~\/|[a-z]:\\)\S*(?: [^\r\n]*)? \d+(?:\.\d+)?[kmb]? \((?:100|\d{1,2})(?:\.\d+)?%\)(?: ctrl\+p commands)?$/.test(footer[index + 2] ?? ""))));
    })) ?? null;
  }
  // Codex's normal composer has no "Default mode" badge. Require its empty
  // prompt and model/cwd footer together; a menu or unsubmitted slash command
  // does not prove the default collaboration mode.
  if (runtimeId === "cli:codex") {
    const promptAt = footer.findLastIndex(line => /^›/.test(line));
    const controls = promptAt >= 0 ? footer.slice(promptAt + 1) : footer;
    // The native badge can share the model/cwd status line on wide panes.
    // Require the cycle hint so prose or slash-command suggestions cannot
    // masquerade as the active mode.
    if (controls.some(line => /\bplan mode \(shift\+tab to (?:cycle|switch)\)/.test(line))) return "plan";
    if (promptAt >= 0 && /^›\s*ask codex to do anything$/.test(footer[promptAt]!) &&
      controls.some(line => /^gpt-[\w.-]+\s+\w+\s*[·•]\s*\//.test(line))) return "default";
    return null;
  }
  return text.match(/\b(plan|build|default|auto|yolo|ask|auto edit)\s*(?:mode|on)\b/i)?.[1]?.toLowerCase() ?? null;
}

/** Mirrors the native floating Stop control: Codex uses Escape, other CLIs Ctrl-C. */
export function roomTerminalInterruptKey(runtimeId: string): string {
  return runtimeId === "cli:codex" ? "\u001b" : "\u0003";
}
