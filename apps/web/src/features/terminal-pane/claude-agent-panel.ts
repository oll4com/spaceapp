// Claude Code lists its background agents in a panel below the permission footer:
//
//     ⏵⏵ bypass permissions on · ← for agents
//
//     ● main
//     ◯ Plan  Inspecting space-queue…  7m 13s · ↓ 231.2k tokens
//
// A running row and a finished row read the same; only the bullet's colour tells them apart. A
// running agent's bullet is uncoloured (dim gray, or the default colour while it is selected or
// viewed), a finished one green and a failed or stopped one red.

const PANEL_MAIN_ROW = /^\s*(?:❯\s*)?[●◯◉○]\s*main(?:\s{2,}\S.*)?$/;
// Narrow panes truncate the footer, so any of its parts identifies it.
const PANEL_FOOTER = /shift\+tab to cycle|\? for shortcuts|← (?:for|\d+) agents?|esc to (?:interrupt|…)|(?:bypass permissions|plan mode|accept edits|auto mode) on/i;
const PANEL_ROW_BULLET = /^\s*(?:❯\s*)?[\s│├└─]*([●◯◉○])/;
// Idle teammates and agents waiting for a message show a word where running agents show their elapsed time.
const PANEL_ROW_IDLE = /\s(?:idle|waiting|awaiting approval)(?:\s+·\s+\d+\s+queued)?\s*$/;
const PANEL_SCAN_LINES = 20;
// A turn that ends while agents still work replaces "✻ Baked for 35s · done 10:01 AM" above the prompt
// with "✻ Waiting for 1 background agent to finish" (or "… agents and 2 dynamic workflows …"), also
// when Claude shows no agent panel.
const WAITING_FOR_BACKGROUND_WORK = /^\s*[✢✳✶✻✽*·]\s*Waiting for \d+ (?:background agents?|dynamic workflows?)\b.* to finish\s*$/;
// The prompt box's top border can carry a label: "──────── room-agent-monitoring-context ─".
const PROMPT_TOP_BORDER = /^\s*─{3,}/;

type PanelCell = {
  getChars(): string;
  getWidth(): number;
  getFgColor(): number;
  isFgDefault(): boolean;
  isFgPalette(): boolean;
};
type PanelLine = {
  length: number;
  translateToString(trimRight?: boolean): string;
  getCell(x: number): PanelCell | undefined;
};
type PanelTerminal = {
  rows: number;
  buffer: { active: { baseY: number; length: number; getLine(y: number): PanelLine | undefined } };
};

/** Index of the agent panel's "main" row among the screen lines, or -1 when Claude shows no agent panel. */
export function claudeAgentPanelStart(lines: readonly string[]): number {
  for (let index = lines.length - 1; index >= Math.max(0, lines.length - PANEL_SCAN_LINES); index -= 1) {
    if (!PANEL_MAIN_ROW.test(lines[index] ?? "")) continue;
    const above = lines.slice(0, index).filter((line) => line.trim()).slice(-2);
    return above.some((line) => PANEL_FOOTER.test(line)) ? index : -1;
  }
  return -1;
}

/** The screen lines above Claude's agent panel; its footer is the last of them. */
export function linesAboveClaudeAgentPanel(lines: readonly string[]): readonly string[] {
  const start = claudeAgentPanelStart(lines);
  return start < 0 ? lines : lines.slice(0, start);
}

/** Whether the turn status right above Claude's prompt box says it waits for background agents. */
export function claudeWaitingForBackgroundWork(lines: readonly string[]): boolean {
  const above = linesAboveClaudeAgentPanel(lines);
  const prompt = above.findLastIndex((line) => /^\s*❯/.test(line));
  if (prompt < 1 || !PROMPT_TOP_BORDER.test(above[prompt - 1]!)) return false;
  // A status line further up the conversation is history, not the current turn.
  const status = above.slice(0, prompt - 1).findLast((line) => line.trim());
  return status !== undefined && WAITING_FOR_BACKGROUND_WORK.test(status);
}

function isUncolouredCell(cell: PanelCell): boolean {
  if (cell.isFgDefault()) return true;
  const color = cell.getFgColor();
  if (cell.isFgPalette()) return color === 0 || color === 7 || color === 8 || color === 15 || color >= 232;
  const channels = [(color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff];
  return Math.max(...channels) - Math.min(...channels) < 48;
}

function bulletCell(line: PanelLine, bullet: string): PanelCell | undefined {
  for (let x = 0; x < line.length; x += 1) {
    const cell = line.getCell(x);
    if (cell && cell.getWidth() > 0 && cell.getChars() === bullet) return cell;
  }
  return undefined;
}

/** Whether Claude's current screen shows a background agent that is still working. */
export function claudeBackgroundAgentRunning(terminal: PanelTerminal): boolean {
  const buffer = terminal.buffer.active;
  const firstLine = Math.max(0, buffer.baseY);
  const lastLine = Math.min(buffer.length, firstLine + Math.max(1, terminal.rows));
  const rows: Array<{ text: string; line: PanelLine | undefined }> = [];
  for (let y = firstLine; y < lastLine; y += 1) {
    const line = buffer.getLine(y);
    rows.push({ text: line?.translateToString(true) ?? "", line });
  }
  const texts = rows.map((row) => row.text);
  if (claudeWaitingForBackgroundWork(texts)) return true;
  const start = claudeAgentPanelStart(texts);
  if (start < 0) return false;
  return rows.slice(start + 1).some(({ text, line }) => {
    const bullet = PANEL_ROW_BULLET.exec(text)?.[1];
    if (!bullet || !line || PANEL_ROW_IDLE.test(text)) return false;
    const cell = bulletCell(line, bullet);
    return cell !== undefined && isUncolouredCell(cell);
  });
}
