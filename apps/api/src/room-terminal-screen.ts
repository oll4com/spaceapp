import { createHash } from "node:crypto";
import headless from "@xterm/headless";
import { cliTurnInterruptKey, type PaneCliSession } from "@space/contracts";

/** Only confirmed dimensions of this host generation describe its replay. */
export function restoreRoomTerminalGeometry(generationId: string, restored: boolean,
  persisted: PaneCliSession["terminalGeometry"], initial?: { cols: number; rows: number }) {
  if (!restored) return initial ?? { cols: 100, rows: 30 };
  return persisted?.generationId === generationId ? { cols: persisted.cols, rows: persisted.rows } : null;
}

type ProjectedLine = NonNullable<ReturnType<headless.Terminal["buffer"]["active"]["getLine"]>>;

/** Faint cells become spaces: a TUI draws placeholders and suggestions faint, never typed text. */
function undimmedLineText(line: ProjectedLine, trimRight: boolean): string {
  let text = "";
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x);
    if (!cell || cell.getWidth() === 0) continue;
    text += cell.isDim() ? " ".repeat(cell.getWidth()) : cell.getChars() || " ";
  }
  return trimRight ? text.replace(/\s+$/u, "") : text;
}

/** Bounded, on-demand terminal projection; does not mount or resize the live pane. */
export async function projectRoomTerminalScreen(chunks: string[], cols = 100, rows = 30, unwrap = false, omitFaint = false): Promise<string> {
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
      const trimRight = !(unwrap && buffer.getLine(index + 1)?.isWrapped);
      const text = !line ? '' : omitFaint ? undimmedLineText(line, trimRight) : line.translateToString(trimRight);
      if (unwrap && line?.isWrapped && lines.length) lines[lines.length - 1] += text;
      else lines.push(text);
    }
    return lines.join('\n');
  } finally { terminal.dispose(); }
}

export function roomTerminalState(screen: string): "RUNNING" | "IDLE" | "WAITING_FOR_INPUT" | "UNKNOWN" {
  // Claude Code's "Switch model? … 1. Yes, switch to … 2. No, go back" is a question with options, not an idle composer (27/10).
  if (/select (?:a |an )?(?:session|model|option)|enter to (?:confirm|select)|allow (?:once|always)|approve this|do you want to proceed|switch model\?[\s\S]{0,800}?\b1\.\s+yes,?\s+switch\b/i.test(screen)) return "WAITING_FOR_INPUT";
  if (/(?:ask (?:codex|opencode|gemini|claude)?(?:\s+to do)?\s+anything|ask anything|send a message)/i.test(screen)) return "IDLE";
  const cleanScreen = screen.replace(/waiting for background terminal[^\n]*(?:esc(?:ape)? to interrupt|\/ps to view|\/stop to close)[^\n]*/gi, "");
  // Qwen and Qoder keep their "Type your message" placeholder visible while a turn runs.
  if (/type (?:your )?message/i.test(screen) && !/esc(?:ape)?\s+to\s+(?:interrupt|cancel)/i.test(cleanScreen)) return "IDLE";
  if (
    // Oh My Pi's status line starts with a spinner and the elapsed time while it works (" ⠹ 7s > GPT-6 Sol >"), π when idle.
    /^\s*[\u2800-\u28ff]\s+(?:\d+[hms]\s*)+>/m.test(cleanScreen) ||
    // Claude Code's spinner ("✢ Nesting…", "· Simmering… 5s · thinking"), whose "esc to interrupt" a narrow pane cuts (stable
    // 2026-10-17: Nous's prompts were refused as not ready instead of waiting for the turn); a finished turn reads "✻ Cooked for 13s".
    /^\s*[\u273b\u273d\u2736\u2733\u2722\u00b7*\u25cf]\s*[A-Z][a-z]+ing\u2026/m.test(cleanScreen) ||
    /esc(?:ape)?\s+(?:to\s+)?(?:interrupt|cancel|stop)|thinking[.…]|(?:[\u2800-\u28ff•●*o-]\s*working\b|\bworking\s*(?:[(·•]\s*\d+[a-z]*|[.…]))|ctrl\+c to (?:interrupt|stop)|running\s+(?:background\s+)?(?:command|task|subagent|process)[.…]?/i.test(cleanScreen) ||
    /(?:^|\n)\s*[•●*o-]?\s*\[(?:\d{1,2}:\d{2}:\d{2}(?:\s*[ap]m)?|task-[a-z0-9_-]+|\d+)\]\s+[^\n]+?\brunning(?:\s*\([^)]*\))?\s*$/im.test(cleanScreen)
  ) return "RUNNING";
  // Idle composers seen in tmux on 2026-10-14: a prompt inside a frame (Droid "│ > Try", Grok "│ ❯"),
  // Cursor's "→ Plan, search, build anything" and Oh My Pi's "π >" input line.
  if (/(?:^|\n)\s*(?:[│┃]\s*)?[❯›>]\s*[^\n]*$/m.test(screen) || /plan, search, build anything|(?:^|\n)\s*π >/i.test(screen)) return "IDLE";
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

// Claude Code lists background agents below its footer ("● main", then "◯ Plan  Inspecting…  7m 13s"),
// as the web pane reads it in apps/web/src/features/terminal-pane/claude-agent-panel.ts.
const CLAUDE_PANEL_MAIN_ROW = /^\s*(?:❯\s*)?[●◯◉○]\s*main(?:\s{2,}\S.*)?$/;
const CLAUDE_PANEL_FOOTER = /shift\+tab to cycle|\? for shortcuts|← (?:for|\d+) agents?|esc to (?:interrupt|…)|(?:bypass permissions|plan mode|accept edits|auto mode) on/i;
const CLAUDE_MODE_LABEL = /^(?:⏵⏵|⏸)\s*(accept edits|plan mode|bypass permissions|auto mode|manual mode) on\b/;
const CLAUDE_MODES: Record<string, string> = {
  "plan mode": "plan", "accept edits": "accept edits", "bypass permissions": "bypass permissions", "auto mode": "auto", "manual mode": "default"
};

/** Claude's normalized footer and prompt lines, without the background agent panel below them. */
function claudeFooterLines(screen: string): string[] {
  const lines = screen.split(/\r?\n/);
  for (let index = lines.length - 1; index >= Math.max(0, lines.length - 20); index--) {
    if (!CLAUDE_PANEL_MAIN_ROW.test(lines[index]!)) continue;
    const above = lines.slice(0, index).filter((line) => line.trim()).slice(-2);
    if (above.some((line) => CLAUDE_PANEL_FOOTER.test(line))) lines.length = index;
    break;
  }
  return lines.map((line) => line.toLowerCase().replace(/\s+/g, " ").trim()).filter(Boolean);
}

export function roomTerminalMode(runtimeId: string, screen: string, advertisedModes: string[] = []): string | null {
  if (runtimeId === "cli:opencode") {
    // Narrow panes wrap the mode independently from the model/provider
    // columns (e.g. "Buil" then "d"). Require the complete empty composer
    // frame and shortcut footer; server idle alone never proves readiness.
    const lines = screen.toLowerCase().split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(-9);
    const border = lines.findLastIndex(line => /^╹[▀━─]{3,}$/.test(line));
    if (border === lines.length - 2 && /^(?:\/|~\/|[a-z]:\\).*(?:\btab agents\b|\d+(?:\.\d+)?[kmb]? \((?:100|\d{1,2})(?:\.\d+)?%\)).*\bctrl\+p commands$/.test(lines[border + 1] ?? "") && /^[┃│║]$/.test(lines[border - 1] ?? "")) {
      let start = border - 2;
      while (start >= 0 && /^[┃│║]\s+\S/.test(lines[start]!)) start--;
      const rows = lines.slice(start + 1, border - 1);
      if (/^[┃│║]$/.test(lines[start] ?? "") && rows.length >= 1 && rows.length <= 3) {
        const label = rows.map(line => line.match(/^[┃│║]\s+(\S+)/)?.[1] ?? "").join("");
        const mode = advertisedModes.find(mode => mode.toLowerCase() === label);
        if (mode) return mode;
      }
    }
  }
  const footer = screen.split(/\r?\n/).map((line) => line.toLowerCase().replace(/\s+/g, " ").trim()).filter(Boolean).slice(-4);
  if (runtimeId === "cli:claude") {
    const rail = claudeFooterLines(screen).slice(-4);
    // The mode label opens the footer even when background shells drop its hints ("⏵⏵ bypass permissions on · 3 shells").
    const label = rail.map((line) => CLAUDE_MODE_LABEL.exec(line)?.[1]).findLast(Boolean);
    if (label) return CLAUDE_MODES[label] ?? null;
    for (const line of [...rail].reverse()) {
      const context = rail.join(" ");
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
  // Rails captured from the installed TUIs (omp 18.6, qodercli 1.1.58, droid 0.234); prose never matches.
  const recent = screen.split(/\r?\n/).map((line) => line.toLowerCase().replace(/\s+/g, " ").trim()).filter(Boolean).slice(-10);
  if (runtimeId === "cli:omp") {
    // Status rail "π > ⟳ <model> > 🗺 Plan ⏸ > 📁 /etc ▶─…": the Plan segment is absent in Build.
    const rail = recent.findLast((line) => /^π\s*>/.test(line));
    return rail ? (/🗺\s*plan\b/.test(rail) ? "plan" : "build") : null;
  }
  if (runtimeId === "cli:qoder") {
    // Mode rail "YOLO Shift+Tab to Auto Mode | plan on"; the default mode shows only its hint.
    const rail = recent.findLast((line) => /shift\+tab to /.test(line));
    if (!rail) return null;
    if (/\|\s*plan on\b/.test(rail)) return "plan";
    return rail.match(/^(yolo|auto mode|don't ask|accept edits)\s+shift\+tab to /)?.[1] ?? (rail.startsWith("shift+tab to ") ? "default" : null);
  }
  if (runtimeId === "cli:droid") {
    // Spec mode titles the composer box; the autonomy rail is always present (narrow panes clip it to "Auto…").
    if (recent.some((line) => /^╭─+\s*spec\s*─/.test(line))) return "plan";
    return recent.some((line) => /^auto(?: \((?:off|low|medium|high)\)\s*·|…)/.test(line)) ? "build" : null;
  }
  if (runtimeId === "cli:deepseek") {
    const match = text.match(/\[\s*(workspace|read-only|yolo|plan)\s*[·•]\s*ready/i);
    if (match?.[1]) return match[1].toLowerCase();
    return text.match(/\b(workspace|read-only|yolo|plan)\b/i)?.[1]?.toLowerCase() ?? null;
  }
  return text.match(/\b(plan|build|default|auto|yolo|ask|auto edit)\s*(?:mode|on)\b/i)?.[1]?.toLowerCase() ?? null;
}

/** Mirrors the native floating Stop control: the TUI's own interrupt key (see cliTurnInterruptKey). */
export function roomTerminalInterruptKey(runtimeId: string): string {
  return cliTurnInterruptKey(runtimeId) === "escape" ? "\u001b" : "\u0003";
}

/**
 * Text followed by Enter goes as a bracketed paste, like the local composer: Claude Code reads unbracketed text of
 * about 60+ characters that arrives in one read with its Enter as a paste and drops the Enter, leaving a draft
 * (scheduled tasks 2026-10-20). Single-key menu answers and answers without Enter stay keys.
 */
export function roomAnswerInput(answer: string, submit: boolean): string {
  return submit && answer.length > 1 ? `\u001b[200~${answer}\u001b[201~` : answer;
}

/**
 * A bare prompt marker among the last lines: the CLI's composer is empty. The marker's row may also carry only Claude Code's status of
 * the finished turn ("❯ Cogitated for 18s · done 5:49 PM", "❯ Churned for 45s · done 6:46 PM · 1 sh↓ …"): 28/10 a scheduled task and
 * held texts waited on such idle panes as if they held a draft.
 */
export function roomComposerEmpty(screen: string): boolean {
  const tail = screen.split("\n").filter((line) => line.trim()).slice(-6).join("\n");
  return /^[ \t\u00a0]*[❯›>][ \t\u00a0]*(?:[A-Z][a-z]+ed for (?:\d+h ?)?(?:\d+m ?)?\d+s(?: · [^\n]*)?)?[ \t\u00a0]*$/m.test(tail);
}

/**
 * Whether the composer (the last prompt line and the lines wrapped under it) still holds the typed text: its end, or
 * Claude's "[Pasted text #N]" placeholder. Spaces are ignored, so wrapping does not matter; the last marker is the
 * composer because earlier prompts echo above it.
 */
export function roomComposerHolds(screen: string, typed: string): boolean {
  const lines = screen.split("\n");
  const at = lines.findLastIndex((line) => /^[ \t\u00a0]*[❯›>]/.test(line));
  if (at < 0) return false;
  const composer = [lines[at]!];
  for (const line of lines.slice(at + 1)) {
    if (!line.trim() || /^[\s─━]+$/.test(line)) break;
    composer.push(line);
  }
  const compact = (value: string) => value.replace(/\s+/g, "");
  const held = compact(composer.join("")).slice(1);
  return held !== "" && (held.endsWith(compact(typed).slice(-32)) || /^\[Pastedtext#\d+(?:\+\d+lines)?\]$/.test(held));
}

/**
 * Identifies the question a CLI is showing: the last non-blank lines of the redacted screen.
 * An answer decided on one inspection is refused when the screen now shows another question.
 */
export function roomPromptFingerprint(redactedScreen: string): string {
  const lines = redactedScreen.split("\n").map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean).slice(-20);
  return createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 16);
}

/** A permission or confirmation prompt (as opposed to a session or model picker). */
export function roomApprovalPromptCue(screen: string): boolean {
  const recent = screen.split("\n").slice(-30).join("\n");
  return /allow (?:once|always)|approve|do you want to (?:proceed|make this edit|run|create|allow|apply|delete|overwrite)|would you like to (?:run|proceed|apply|make)|permission|yes, and (?:don't|do not) ask again|\((?:y\/n|yes\/no)\)|\[(?:y\/n|yes\/no)\]|press enter to confirm|confirm (?:this|the) (?:action|command|change)/i.test(recent);
}
