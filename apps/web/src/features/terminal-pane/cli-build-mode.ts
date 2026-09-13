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
    if (/Plan\s*·.*Shift\+Tab ask\/auto\/plan/i.test(footer)) return 'plan';
    if (/(?:Ask|Auto(?:\+Approve)?|YOLO)\s*·.*Shift\+Tab ask\/auto\/plan/i.test(footer)) return 'build';
  }
  if (runtimeId === 'cli:copilot') {
    if (/open sidebar\s*·\s*plan\s*·/i.test(footer)) return 'plan';
    if (/open sidebar\s*·\s*(?:interactive\s*·\s*)?\/ commands/i.test(footer)) return 'build';
    if (/open sidebar\s*·\s*autopilot\s*·/i.test(footer)) return 'other';
  }
  if (runtimeId === 'cli:claude') {
    if (/plan mode on.*shift\+tab to cycle/i.test(footer)) return 'plan';
    if (/\? for shortcuts/.test(footer)) return 'build';
    if (/shift\+tab to cycle/i.test(footer)) return 'other';
  }
  if (runtimeId === 'cli:kimi') {
    const rail = lines.findLast(line => /(?:Ask When Needed|Never Ask|Auto).*thinking:/i.test(line));
    if (rail) return /\bplan\b/i.test(rail) ? 'plan' : 'build';
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
    const previousRail = target.screen().split(/\r?\n/).filter(line => /shift\+tab to cycle|open sidebar/i.test(line)).join('\n');
    if (runtimeId === 'cli:kimi' || runtimeId === 'cli:grok') await target.submit(runtimeId === 'cli:kimi' ? '/plan off' : '/plan');
    else if (!target.write(runtimeId === 'cli:opencode' ? '\t' : '\x1b[Z')) throw Error('Build mode key could not be sent.');
    let changed = false;
    for (let poll = 0; poll < 30; poll++) {
      await target.sleep(100);
      current();
      const next = cliBuildModeState(runtimeId, target.screen());
      const nextRail = target.screen().split(/\r?\n/).filter(line => /shift\+tab to cycle|open sidebar/i.test(line)).join('\n');
      if (next && (next !== state || (next === 'other' && nextRail !== previousRail))) { state = next; changed = true; break; }
    }
    if (!changed) throw Error('The CLI did not confirm leaving Plan mode.');
  }
  throw Error('The CLI did not confirm Build mode.');
}
