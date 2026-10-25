import { describe, expect, it } from 'vitest';
import { OSK_CLI_COMMANDS, cliModeShortcutAvailable, cliShortcutCommandsForRuntime, resolveCliModeShortcut } from '../src/features/osk-keyboard/cli-shortcuts.js';

describe('native CLI mode controls', () => {
  it('keeps both surfaces semantic until the target runtime is known', () => {
    for (const action of ['plan', 'build', 'permissions'] as const) {
      expect(OSK_CLI_COMMANDS.find(command => command.id === action)).toMatchObject({ action, text: '' });
    }
  });
  it.each([
    ['codex', '/plan', '/permissions'], ['claude', '/plan', '/permissions'],
    ['qwen', '/plan', '/approval-mode'], ['autohand', '/plan', '/permissions'],
    ['kimi', '/plan', '/permission'], ['grok', '/plan', '/always-approve'],
    ['cursor', '/plan', '/settings']
  ])('%s submits its own native slash controls', (runtime, plan, permissions) => {
    expect(resolveCliModeShortcut(`cli:${runtime}`, 'plan')).toEqual({ text: plan, enter: true });
    expect(resolveCliModeShortcut(`cli:${runtime}`, 'permissions')).toEqual({ text: permissions, enter: true });
  });
  it.each(['gemini', 'copilot', 'deepseek'])('%s cycles modes without submitting a model prompt', runtime => {
    expect(resolveCliModeShortcut(`cli:${runtime}`, 'plan')).toEqual({ text: '\x1b[Z', enter: false });
  });
  it.each(['gemini', 'copilot'])('%s opens native permissions', runtime => {
    expect(resolveCliModeShortcut(`cli:${runtime}`, 'permissions')).toEqual({ text: '/permissions', enter: true });
  });
  it('uses Reasonix native YOLO key and OpenCode command palette without auto-confirming', () => {
    expect(resolveCliModeShortcut('cli:deepseek', 'permissions')).toEqual({ text: '\x19', enter: false });
    expect(resolveCliModeShortcut('cli:opencode', 'plan')).toEqual({ text: '\t', enter: false });
    expect(resolveCliModeShortcut('cli:opencode', 'permissions')).toEqual({ prefix: '\x10', text: 'auto-approve permissions', enter: false });
  });
  it('maps Oh My Pi, Qoder, Droid and Muse to the controls their TUIs actually have', () => {
    expect(resolveCliModeShortcut('cli:omp', 'plan')).toEqual({ text: '/plan', enter: true });
    expect(resolveCliModeShortcut('cli:qoder', 'plan')).toEqual({ text: '/plan', enter: true });
    expect(resolveCliModeShortcut('cli:qoder', 'permissions')).toEqual({ text: '\x1b[Z', enter: false });
    expect(resolveCliModeShortcut('cli:droid', 'plan')).toEqual({ text: '\x1b[Z', enter: false });
    expect(resolveCliModeShortcut('cli:droid', 'permissions')).toEqual({ text: '\x0c', enter: false });
    expect(resolveCliModeShortcut('cli:muse', 'permissions')).toEqual({ text: '/permissions', enter: true });
    expect(cliModeShortcutAvailable('cli:omp', 'permissions')).toBe(false);
    expect(cliModeShortcutAvailable('cli:muse', 'plan')).toBe(false);
    expect(cliModeShortcutAvailable('cli:muse', 'build')).toBe(false);
    for (const runtime of ['omp', 'qoder', 'droid']) expect(cliModeShortcutAvailable(`cli:${runtime}`, 'build')).toBe(true);
  });
  it('leaves controls a CLI lacks out of its shortcut menu', () => {
    const ids = (runtimeId: string) => cliShortcutCommandsForRuntime(runtimeId).map(command => command.id);
    expect(ids('cli:muse')).not.toContain('plan');
    expect(ids('cli:muse')).not.toContain('build');
    expect(ids('cli:muse')).toContain('permissions');
    expect(ids('cli:omp')).not.toContain('permissions');
    expect(ids('cli:codex')).toEqual(OSK_CLI_COMMANDS.map(command => command.id));
    expect(cliShortcutCommandsForRuntime('cli:muse')).toBe(cliShortcutCommandsForRuntime('cli:muse'));
  });
  it('leaves Hermes planning task for the operator to complete', () => {
    expect(resolveCliModeShortcut('cli:hermes', 'plan')).toEqual({ text: '/plan ', enter: false });
    expect(resolveCliModeShortcut('cli:hermes', 'permissions')).toEqual({ text: '/yolo', enter: true });
  });
  it('fails closed for unknown runtimes', () => {
    expect(resolveCliModeShortcut('cli:unknown', 'plan')).toHaveProperty('unavailable');
    expect(resolveCliModeShortcut('cli:unknown', 'permissions')).toHaveProperty('unavailable');
  });
});

it('submits the exact progress and combined deploy prompts', () => {
  expect(OSK_CLI_COMMANDS.find(command => command.id === 'plan_progress')).toMatchObject({ text: 'Plan completion percentage', enter: true });
  expect(OSK_CLI_COMMANDS.find(command => command.id === 'deploy')).toMatchObject({ text: 'Deploy the project to Gitea and GitHub.', enter: true });
  expect(OSK_CLI_COMMANDS.find(command => command.id === 'test')).toMatchObject({ text: 'test', enter: true });
  expect(OSK_CLI_COMMANDS.find(command => command.id === 'clean_worktree')).toMatchObject({
    label: 'Clean worktree',
    text: expect.stringContaining('worktree'),
    enter: true,
    icon: 'Archive'
  });
  expect(OSK_CLI_COMMANDS.find(command => command.id === 'scroll_top')).toMatchObject({
    id: 'scroll_top',
    label: 'Scroll to top',
    action: 'scroll_top',
    icon: 'ArrowUpToLine'
  });
  expect(OSK_CLI_COMMANDS.find(command => command.id === 'scroll_bottom')).toMatchObject({
    id: 'scroll_bottom',
    label: 'Scroll to bottom',
    action: 'scroll_bottom',
    icon: 'ArrowDownToLine'
  });
});
