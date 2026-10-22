import { linesAboveClaudeAgentPanel } from './claude-agent-panel.js';

export type ClaudeFooterModeLabel = 'accept edits' | 'plan mode' | 'bypass permissions' | 'auto mode' | 'manual mode';

// Claude Code opens its footer with the permission mode: "⏵⏵ bypass permissions on", "⏸ plan mode on".
// The "(shift+tab to cycle)" hint after it is dropped while background shells run ("· 3 shells").
export function claudeFooterModeLabel(line: string): ClaudeFooterModeLabel | null {
  const label = /^\s*(?:⏵⏵|⏸)\s*(accept edits|plan mode|bypass permissions|auto mode|manual mode) on\b/i.exec(line)?.[1];
  return label ? label.toLowerCase() as ClaudeFooterModeLabel : null;
}

// Claude's footer and prompt lines: its background agent panel is drawn below them.
export function claudeFooterLines(screen: string): string[] {
  return linesAboveClaudeAgentPanel(screen.split(/\r?\n/)).map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

// Read the current native control rail, never a historical assistant response.
export function cliBuildModeState(runtimeId: string, screen: string): 'plan' | 'build' | 'other' | null {
  const lines = screen.split(/\r?\n/).map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const footer = lines.slice(-6).join('\n');
  if (runtimeId === 'cli:opencode') {
    if (!/tab agents|ctrl\+p commands/i.test(footer)) return null;
    if (/^[┃│]\s+Plan\s/im.test(footer)) return 'plan';
    if (/^[┃│]\s+Build\s/im.test(footer)) return 'build';
  }
  if (runtimeId === 'cli:codex') {
    if (/Plan mode \(shift\+tab to (?:cycle|switch)\)/i.test(footer)) return 'plan';
    if (/^›\s*Ask Codex to do anything/im.test(footer) && /gpt-.*[·•]/i.test(footer)) return 'build';
  }
  if (runtimeId === 'cli:cursor') {
    if (/Plan \(shift\+tab to cycle\)/i.test(footer)) return 'plan';
    if (/Agent \(shift\+tab to cycle\)/i.test(footer)) return 'build';
    if (/(?:Ask|Debug) \(shift\+tab to cycle\)/i.test(footer)) return 'other';
    // Agent mode omits the cycle badge. Require its empty native composer and cwd.
    if (/^[→›>]\s*Plan, search, build anything\s*$/im.test(footer) && /^(?:\/|~\/|[a-z]:\\)\S*/im.test(footer)) return 'build';
  }
  if (runtimeId === 'cli:gemini') {
    const rail = lines.findLast(line => /\? for shortcuts/.test(line) && /Gemini|Claude|GPT/i.test(line));
    if (rail) return /\bplan\s*·/i.test(rail) ? 'plan' : 'build';
    if (/Plan mode: research & plan only.*shift\+tab to cycle/i.test(footer)) return 'plan';
    if (/Accept.edits mode:.*shift\+tab to cycle|(?:Normal|Default|Ask) mode:.*shift\+tab to cycle|Bypass.*mode:.*shift\+tab to cycle/i.test(footer)) return 'build';
  }
  if (runtimeId === 'cli:deepseek') {
    if (/Plan\s*·.*Shift\+Tab/i.test(footer)) return 'plan';
    if (/(?:Ask|Auto(?:\+Approve)?|YOLO|read-only|workspace)\s*·.*Shift\+Tab/i.test(footer)) return 'build';
  }
  if (runtimeId === 'cli:copilot') {
    if (/open sidebar\s*·\s*plan\s*·/i.test(footer)) return 'plan';
    if (/open sidebar\s*·\s*(?:interactive\s*·\s*)?\/ commands/i.test(footer)) return 'build';
    if (/open sidebar\s*·\s*autopilot\s*·/i.test(footer)) return 'other';
  }
  if (runtimeId === 'cli:claude') {
    // Every permission mode outside Plan is Build. Space launches Claude in bypass permissions, so
    // cycling on to default mode would make it ask before every tool.
    const rail = claudeFooterLines(screen).slice(-6);
    const label = rail.map(claudeFooterModeLabel).findLast(Boolean);
    if (label) return label === 'plan mode' ? 'plan' : 'build';
    if (/plan mode on.*shift\+tab to cycle/i.test(rail.join('\n'))) return 'plan';
    if (/\? for shortcuts|shift\+tab to cycle/i.test(rail.join('\n'))) return 'build';
  }
  if (runtimeId === 'cli:kimi') {
    const rail = lines.findLast(line => /(?:Ask When Needed|Never Ask|Auto).*thinking:/i.test(line));
    if (rail) return /\bplan\b/i.test(rail) ? 'plan' : 'build';
  }
  if (runtimeId === 'cli:omp') {
    // Status rail: "π > ⟳ <model> > 🗺 Plan ⏸ > 📁 /etc ▶─…"; the Plan segment is absent in Build.
    const rail = lines.findLast(line => /^π\s*>/.test(line));
    if (rail) return /🗺\s*Plan\b/.test(rail) ? 'plan' : 'build';
  }
  if (runtimeId === 'cli:qoder') {
    // Mode rail: "YOLO Shift+Tab to Auto Mode | plan on".
    const rail = lines.findLast(line => /Shift\+Tab to /i.test(line));
    if (rail) return /\|\s*plan on\b/i.test(rail) ? 'plan' : 'build';
  }
  if (runtimeId === 'cli:droid') {
    // Spec mode titles the composer box "╭── Spec ──"; the autonomy rail is always visible (narrow panes clip it to "Auto…").
    const recent = lines.slice(-8);
    if (recent.some(line => /^╭─+\s*Spec\s*─/.test(line))) return 'plan';
    if (recent.some(line => /^Auto(?: \((?:Off|Low|Medium|High)\)\s*·|…)/.test(line))) return 'build';
  }
  if (runtimeId === 'cli:grok') {
    // These TUIs emit mode changes immediately above the empty composer.
    const mode = [...lines].reverse().find(line => /plan mode.*(?:on|off|enabled|disabled)/i.test(line));
    if (mode) return /\b(?:off|disabled)\b/i.test(mode) ? 'build' : 'plan';
  }
  return null;
}

export async function returnCliToBuildMode(runtimeId: string, target: {
  screen: () => string;
  isCurrent: () => boolean;
  write: (text: string) => boolean;
  submit: (text: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
}) {
  const current = () => { if (!target.isCurrent()) throw Error('CLI connection or room changed. Build mode cancelled.'); };
  current();
  if (runtimeId === 'cli:hermes') return; // /plan prepares a single task, not a persistent mode.
  if (runtimeId === 'cli:autohand' || runtimeId === 'cli:qwen') {
    await target.submit(runtimeId === 'cli:autohand' ? '/plan off' : '/approval-mode default');
    return;
  }
  let state = cliBuildModeState(runtimeId, target.screen());
  for (let poll = 0; !state && poll < 30; poll++) {
    await target.sleep(100);
    current();
    state = cliBuildModeState(runtimeId, target.screen());
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    current();
    if (state === 'build') return;
    if (!state) throw Error('The current CLI mode is not visible. Close native dialogs and try Build mode again.');
    const previousRail = target.screen().split(/\r?\n/).filter(line => /shift\+tab|open sidebar/i.test(line)).join('\n');
    if (runtimeId === 'cli:kimi' || runtimeId === 'cli:grok' || runtimeId === 'cli:omp' || runtimeId === 'cli:qoder') {
      await target.submit(runtimeId === 'cli:kimi' ? '/plan off' : '/plan');
    }
    else if (!target.write(runtimeId === 'cli:opencode' ? '\t' : '\x1b[Z')) throw Error('Build mode key could not be sent.');
    let changed = false;
    for (let poll = 0; poll < 30; poll++) {
      await target.sleep(100);
      current();
      const next = cliBuildModeState(runtimeId, target.screen());
      const nextRail = target.screen().split(/\r?\n/).filter(line => /shift\+tab|open sidebar/i.test(line)).join('\n');
      if (next && (next !== state || (next === 'other' && nextRail !== previousRail))) { state = next; changed = true; break; }
    }
    if (!changed) throw Error('The CLI did not confirm leaving Plan mode.');
  }
  throw Error('The CLI did not confirm Build mode.');
}
