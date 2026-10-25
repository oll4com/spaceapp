import { afterEach, describe, expect, it, vi } from 'vitest';
import { submitCliShortcut, CLI_SHORTCUT_ENTER_DELAY_MS } from '../src/features/terminal-pane/submit-cli-shortcut.js';
import { OSK_CLI_COMMANDS } from '../src/features/osk-keyboard/cli-shortcuts.js';
afterEach(() => vi.useRealTimers());
describe('CLI shortcut submission', () => {
  it.each(OSK_CLI_COMMANDS.filter(command => !command.action))('waits for preparation and sends one delayed Enter for $id', async command => {
    vi.useFakeTimers();
    const events: string[] = [];
    let prepared!: () => void;
    const preparation = new Promise<void>(resolve => { prepared = resolve; });
    const pending = submitCliShortcut(command, { isCurrent: () => true, prepare: () => preparation,
      write: text => { events.push(text); return true; }, enter: () => { events.push('ENTER'); return true; } });
    expect(events).toEqual([]);
    prepared();
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual([command.text]);
    await vi.advanceTimersByTimeAsync(CLI_SHORTCUT_ENTER_DELAY_MS - 1);
    expect(events).toEqual([command.text]);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(events).toEqual([command.text, 'ENTER']);
  });
  it('sends nothing if Low reasoning preparation fails', async () => {
    const write = vi.fn(); const enter = vi.fn();
    await expect(submitCliShortcut(OSK_CLI_COMMANDS.find(command => command.id === "memory")!, { isCurrent: () => true,
      prepare: async () => { throw new Error('Low unavailable'); }, write, enter })).rejects.toThrow('Low unavailable');
    expect(write).not.toHaveBeenCalled(); expect(enter).not.toHaveBeenCalled();
  });
  it('does not send delayed Enter into a changed session or hidden room', async () => {
    vi.useFakeTimers(); let current = true; const enter = vi.fn();
    const pending = submitCliShortcut(OSK_CLI_COMMANDS[0]!, { isCurrent: () => current, prepare: async () => {}, write: () => true, enter });
    const rejected = expect(pending).rejects.toThrow('cancelled');
    await vi.advanceTimersByTimeAsync(0); current = false;
    await vi.advanceTimersByTimeAsync(CLI_SHORTCUT_ENTER_DELAY_MS);
    await rejected; expect(enter).not.toHaveBeenCalled();
  });
});
