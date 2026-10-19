import { describe, expect, it, vi } from 'vitest';
import { cliBuildModeState, returnCliToBuildMode } from '../src/features/terminal-pane/cli-build-mode.js';
const codexPlan = '›\ngpt-6 high · /etc\nPlan mode (shift+tab to cycle)';
const codexBuild = '› Ask Codex to do anything\ngpt-6 high · /etc';
function target(screens: string[]) {
  let index = 0;
  return { screen: () => screens[Math.min(index, screens.length - 1)]!, isCurrent: () => true,
    write: vi.fn(() => { index++; return true; }), submit: vi.fn(async () => { index++; }), sleep: async () => {} };
}
describe('return to native Build', () => {
  it('leaves Codex plan once and never re-enables it', async () => {
    const control = target([codexPlan, codexBuild]);
    await returnCliToBuildMode('cli:codex', control);
    await returnCliToBuildMode('cli:codex', control);
    expect(control.write.mock.calls).toEqual([['\x1b[Z']]);
  });
  it('reads the persistent Antigravity rail after transient notices disappear', async () => {
    const control = target(['>\n? for shortcuts    plan · Gemini 3.8 Flash · high', '>\n? for shortcuts    Gemini 3.8 Flash · high']);
    await returnCliToBuildMode('cli:gemini', control);
    expect(control.write).toHaveBeenCalledTimes(1);
  });
  it('uses Kimi explicit off without toggling an already normal session', async () => {
    const control = target(['Ask When Needed plan K3 thinking: high /etc', 'Ask When Needed K3 thinking: high /etc']);
    await returnCliToBuildMode('cli:kimi', control);
    await returnCliToBuildMode('cli:kimi', control);
    expect(control.submit.mock.calls).toEqual([['/plan off']]);
  });
  it('passes through Cursor Debug before returning to Agent', async () => {
    const control = target(['Plan (shift+tab to cycle)', 'Debug (shift+tab to cycle)', 'Ask (shift+tab to cycle)', '→ Plan, search, build anything\nCursor Grok 4.6 High Fast   Run Everything\n/etc']);
    await returnCliToBuildMode('cli:cursor', control);
    expect(control.write).toHaveBeenCalledTimes(3);
  });
  it('recognizes Reasonix Auto+Approve as outside Plan', async () => {
    const control = target(['Auto+Approve · ready · Shift+Tab ask/auto/plan · Ctrl+Y YOLO']);
    await returnCliToBuildMode('cli:deepseek', control);
    expect(control.write).not.toHaveBeenCalled();
  });
  it('recognizes Reasonix YOLO in read-only/workspace/YOLO/plan rail as outside Plan', async () => {
    const control = target(['YOLO · Shift+Tab read-only/workspace/YOLO/plan · Ctrl+Y YOLO']);
    await returnCliToBuildMode('cli:deepseek', control);
    expect(control.write).not.toHaveBeenCalled();
  });
  it('cycles Reasonix from Plan mode back to Build mode with Shift+Tab', async () => {
    const control = target([
      'Plan · Shift+Tab read-only/workspace/YOLO/plan · Ctrl+Y YOLO',
      'workspace · Shift+Tab read-only/workspace/YOLO/plan · Ctrl+Y YOLO'
    ]);
    await returnCliToBuildMode('cli:deepseek', control);
    expect(control.write).toHaveBeenCalledWith('\x1b[Z');
  });
  it('leaves Claude Plan with one Shift+Tab and keeps bypass permissions instead of cycling to default mode', async () => {
    const plan = '❯ \n  ⏸ plan mode on (shift+tab to cycle) · ← for agents';
    const bypass = '❯ \n  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents';
    const control = target([plan, bypass, '❯ \n  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents']);
    await returnCliToBuildMode('cli:claude', control);
    expect(control.write.mock.calls).toEqual([['\x1b[Z']]);
    const already = target([bypass]);
    await returnCliToBuildMode('cli:claude', already);
    expect(already.write).not.toHaveBeenCalled();
    expect(cliBuildModeState('cli:claude', '❯ \n  ? for shortcuts · ← for agents')).toBe('build');
  });
  it('reads Claude Plan and Build while background shells and agents are listed below the footer', async () => {
    const panel = '\n\n  ● main\n  ◯ Plan      Inspecting space-queue…  7m 13s · ↓ 231.2k tokens\n' +
      '  ◯ Explore   Counting MCP servers…    4m 59s · ↓ 125.1k tokens\n  ◯ general-purpose  1h 58m 48s · ↓ 893.4k tokens · 1 queued';
    const plan = `❯ \n────\n  ⏸ plan mode on · 3 shells · ← for agents · ↓ to manage${panel}`;
    const bypass = `❯ \n────\n  ⏵⏵ bypass permissions on · 3 shells · ← for agents · ↓ to manage${panel}`;
    expect(cliBuildModeState('cli:claude', plan)).toBe('plan');
    expect(cliBuildModeState('cli:claude', bypass)).toBe('build');
    const control = target([plan, bypass]);
    await returnCliToBuildMode('cli:claude', control);
    expect(control.write.mock.calls).toEqual([['\x1b[Z']]);
  });
  it('uses OpenCode Tab and confirms Build', async () => {
    const control = target(['┃ Plan · model\ntab agents ctrl+p commands', '┃ Build · model\ntab agents ctrl+p commands']);
    await returnCliToBuildMode('cli:opencode', control);
    expect(control.write).toHaveBeenCalledWith('\t');
  });
  it('cycles through intermediate Copilot mode back to Interactive', async () => {
    const control = target(['open sidebar · plan · / commands', 'open sidebar · autopilot · / commands', '← open sidebar · / commands · ? help · tab next tab']);
    await returnCliToBuildMode('cli:copilot', control);
    expect(control.write).toHaveBeenCalledTimes(2);
  });
  // Rails captured from the installed TUIs (omp 18.6, qodercli 1.1.58, droid 0.234).
  it('toggles Oh My Pi Plan off from its status rail', async () => {
    const control = target([
      'π > ⟳ GPT-6 Sol > 🗺 Plan ⏸ > 📁 /etc ▶─1%────┃──1.1M─\n╰─   ⇧⇥ to change thinking effort',
      'π > ⟳ GPT-6 Sol > 📁 /etc ▶─1%────┃──1.1M─\n╰─   ⇧⇥ to change thinking effort'
    ]);
    await returnCliToBuildMode('cli:omp', control);
    await returnCliToBuildMode('cli:omp', control);
    expect(control.submit.mock.calls).toEqual([['/plan']]);
  });
  it('leaves Qoder Plan with /plan and keeps its YOLO permission mode', async () => {
    const control = target([
      ' YOLO Shift+Tab to Auto Mode | plan on        1 AGENTS.md file · 2 MCP servers\n >   Type your message',
      ' YOLO Shift+Tab to Auto Mode                  1 AGENTS.md file · 2 MCP servers\n >   Type your message'
    ]);
    await returnCliToBuildMode('cli:qoder', control);
    expect(control.submit.mock.calls).toEqual([['/plan']]);
    expect(control.write).not.toHaveBeenCalled();
  });
  it('leaves Droid Spec mode with one Shift+Tab', async () => {
    const control = target([
      ' Auto (High) · allow all commands      GPT-6.1 Sol (High)\n╭── Spec ──────────╮\n│ > Try something │\n╰─────────────────╯',
      ' Auto (High) · allow all commands      GPT-6.1 Sol (High)\n╭──────────────────╮\n│ > Try something │\n╰─────────────────╯'
    ]);
    await returnCliToBuildMode('cli:droid', control);
    expect(control.write.mock.calls).toEqual([['\x1b[Z']]);
  });
  it('reads Droid Build mode in a narrow pane, where the rail reads "Auto…"', () => {
    expect(cliBuildModeState('cli:droid', ' Auto… Claude Opus 5.5 API credits (High)\n╭──────╮\n│ >    │\n╰──────╯\n? for help')).toBe('build');
  });
  it('does not act on prose, unknown mode or a changed session', async () => {
    expect(cliBuildModeState('cli:codex', 'I will use plan mode now.')).toBeNull();
    const control = target([codexPlan]);
    control.isCurrent = () => false;
    await expect(returnCliToBuildMode('cli:codex', control)).rejects.toThrow('changed');
    expect(control.write).not.toHaveBeenCalled();
    await expect(returnCliToBuildMode('cli:unknown', target(['hello']))).rejects.toThrow('not visible');
  });
  it('stops if the native mode does not respond', async () => {
    const control = target([codexPlan]);
    await expect(returnCliToBuildMode('cli:codex', control)).rejects.toThrow('did not confirm');
    expect(control.write).toHaveBeenCalledTimes(1);
  });
  it.each([['cli:autohand', '/plan off'], ['cli:qwen', '/approval-mode default']])('uses the explicit normal-mode command for %s', async (runtime, command) => {
    const control = target(['']); await returnCliToBuildMode(runtime, control);
    expect(control.submit).toHaveBeenCalledWith(command);
  });
});
