import { describe, expect, it } from 'vitest';
import { advertisedOpenCodeModel, openCodeCurrentSelection, openCodeCurrentSelectionWithSource, openCodeTuiSelection } from '../src/cli-opencode-model-picker.js';

const model = {
  id: 'opencode/ling-3.0-flash-fin-free', displayName: 'Ling 3.0 Flash Fin Free', description: 'OpenCode Zen',
  isDefault: false, defaultReasoningEffort: 'low', supportedReasoningEfforts: ['default','low','medium','high'],
  reasoningOptions: ['default','low','medium','high'].map(reasoningEffort => ({reasoningEffort}))
};

describe('OpenCode native selection', () => {
  it('reads the full model and reasoning from the independently wrapped narrow footer columns', () => {
    const screen = ['  ┃  Bu ·Ling 3.0   O·m', '  ┃  il  Flash Fin  p e', '  ┃  d   Free       e d',
      '  ┃                 n i', '  ┃                 C u', '  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀'].join('\n');
    expect(openCodeTuiSelection(screen, [model])).toEqual({modelId:model.id,reasoningEffort:'medium'});
    expect(openCodeTuiSelection(screen, [model,{...model,id:'another/model'}])).toBeNull();
  });

  it('reads an unset native variant as Default and ignores a model menu without the composer', () => {
    expect(openCodeTuiSelection('  ┃ Build · Ling 3.0 Flash Fin Free OpenCode Zen\n  ╹▀▀', [model])).toEqual({modelId:model.id,reasoningEffort:'default'});
    expect(openCodeTuiSelection('Select model\n\nSearch\n\n● Ling 3.0 Flash Fin Free OpenCode Zen', [model])).toBeNull();
    expect(openCodeTuiSelection('  ┃ Build · Ling 3.0 Flash Fin Free OpenCode Zen · high       /etc\n  ╹▀▀', [model])).toEqual({modelId:model.id,reasoningEffort:'high'});
  });

  it('prefers the picker-applied server model over a stale native footer', () => {
    const server = { modelId: 'legacy/kimi-k3', reasoningEffort: 'default' };
    const staleNative = { modelId: 'opencode/deepseek-v4-flash-free', reasoningEffort: 'default' };
    expect(openCodeCurrentSelection('legacy/kimi-k3', server, staleNative)).toEqual(server);
    expect(openCodeCurrentSelection('legacy/kimi-k3', server, null)).toEqual(server);
    // Genuine native drift (server moved on too) still wins.
    expect(openCodeCurrentSelection('legacy/kimi-k3', staleNative, staleNative)).toEqual(staleNative);
    // Without a picker-applied model the native footer stays authoritative.
    expect(openCodeCurrentSelection(null, server, staleNative)).toEqual(staleNative);
    expect(openCodeCurrentSelection(null, server, null)).toEqual(server);
    expect(openCodeCurrentSelection(null, null, null)).toBeNull();
  });

  it('falls back to persisted session model on fresh panes like Codex does', () => {
    const catalog = [model, { ...model, id: 'opencode/muse-spark-1.3-free', displayName: 'Muse Spark 1.3 Free', defaultReasoningEffort: 'xhigh', supportedReasoningEfforts: ['default', 'xhigh'] }];
    // Fresh OpenCode pane: TUI unreadable, server has no current yet.
    expect(openCodeCurrentSelection('opencode/muse-spark-1.3-free', null, null, catalog, 'xhigh'))
      .toEqual({ modelId: 'opencode/muse-spark-1.3-free', reasoningEffort: 'xhigh' });
    // Invalid persisted effort falls back to model default.
    expect(openCodeCurrentSelection('opencode/muse-spark-1.3-free', null, null, catalog, 'ultra'))
      .toEqual({ modelId: 'opencode/muse-spark-1.3-free', reasoningEffort: 'xhigh' });
    // Unadvertised persisted model stays null instead of inventing selection.
    expect(openCodeCurrentSelection('unknown/model', null, null, catalog, 'xhigh')).toBeNull();
  });

  it('resolves the bare native alias a freshly opened pane persists', () => {
    const bigPickle = { ...model, id: 'opencode/big-pickle', displayName: 'Big Pickle',
      defaultReasoningEffort: 'default', supportedReasoningEfforts: ['default', 'low', 'medium'] };
    const catalog = [model, bigPickle];
    // A fresh OpenCode pane persists the runtime descriptor default bare
    // ('big-pickle') while the catalog advertises 'opencode/big-pickle'.
    expect(advertisedOpenCodeModel('big-pickle', catalog)).toEqual(bigPickle);
    expect(openCodeCurrentSelection('big-pickle', null, null, catalog, 'medium'))
      .toEqual({ modelId: 'opencode/big-pickle', reasoningEffort: 'medium' });
    // An unadvertised persisted effort falls back to the model default.
    expect(openCodeCurrentSelection('big-pickle', null, null, catalog, 'ultra'))
      .toEqual({ modelId: 'opencode/big-pickle', reasoningEffort: 'default' });
    // The server's own current model still wins over the alias default.
    expect(openCodeCurrentSelection('big-pickle', { modelId: 'opencode/big-pickle', reasoningEffort: 'low' }, null, catalog))
      .toEqual({ modelId: 'opencode/big-pickle', reasoningEffort: 'low' });
    // An ambiguous alias is never resolved into a selection.
    const ambiguous = [bigPickle, { ...bigPickle, id: 'legacy/big-pickle' }];
    expect(advertisedOpenCodeModel('big-pickle', ambiguous)).toBeNull();
    expect(openCodeCurrentSelection('big-pickle', null, null, ambiguous)).toBeNull();
    // Exact composite ids keep winning and unknown slashed ids stay unmatched.
    expect(advertisedOpenCodeModel('opencode/big-pickle', catalog)).toEqual(bigPickle);
    expect(advertisedOpenCodeModel('other/big-pickle', catalog)).toBeNull();
  });

  it('reads a separator-less narrow composer against advertised display names', () => {
    const spark = { ...model, id: 'opencode/muse-spark-1.3-contributor-free', displayName: 'Muse Spark 1.3 Free', description: 'OpenCode Zen',
      defaultReasoningEffort: 'default', supportedReasoningEfforts: ['default', 'xhigh'] };
    const qwen = { ...model, id: 'opencode-go/qwen3.7-max', displayName: 'Qwen3.7 Max', description: 'OpenCode Go' };
    const screen = [
      '  ┃  Build   Muse Spark 1.3 Free OpenCode Zen   xhigh',
      '  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀',
      '             esc interrupt   272.2K (26%)  ctrl+p commands'
    ].join('\n');
    expect(openCodeTuiSelection(screen, [spark, qwen])).toEqual({ modelId: spark.id, reasoningEffort: 'xhigh' });
    expect(openCodeTuiSelection(screen, [qwen])).toBeNull();
    expect(openCodeTuiSelection('  ┃  Build   Qwen3.7 Max OpenCode Go', [spark, qwen])).toBeNull();
  });
});

describe('OpenCode current model provenance', () => {
  const spark = { ...model, id: 'opencode/muse-spark-1.3-free', displayName: 'Muse Spark 1.3 Free',
    description: 'OpenCode Zen', defaultReasoningEffort: 'minimal',
    supportedReasoningEfforts: ['default', 'minimal', 'xhigh'] };
  const bigPickle = { ...model, id: 'opencode/big-pickle', displayName: 'Big Pickle',
    description: 'OpenCode Zen', defaultReasoningEffort: 'default',
    supportedReasoningEfforts: ['default', 'low', 'medium'] };
  const catalog = [spark, bigPickle];
  // Operator-reported footer of a freshly opened pane (2026-09-10): the CLI runs
  // Muse Spark 1.3 Free while the pane's persisted session default is big-pickle.
  const footer = [
    '  ┃ Build · Muse Spark 1.3 Free OpenCode Zen · minimal                  /etc',
    '  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀',
    '             esc interrupt   272.2K (26%)  ctrl+p commands'
  ].join('\n');

  it('reads the model and reasoning a fresh pane shows in its own footer', () => {
    expect(openCodeTuiSelection(footer, catalog)).toEqual({ modelId: spark.id, reasoningEffort: 'minimal' });
  });

  it('marks the persisted session default as provisional instead of the CLI model', () => {
    // Neither the TUI nor the OpenCode server reports a model yet: the reading is
    // the persisted descriptor default and must stay marked as provisional so the
    // pane keeps re-reading instead of showing 'Big Pickle' indefinitely.
    expect(openCodeCurrentSelectionWithSource('big-pickle', null, null, catalog, null))
      .toEqual({ current: { modelId: bigPickle.id, reasoningEffort: 'default' }, source: 'session-default' });
    // The native footer is the CLI's own state: it settles the picker.
    expect(openCodeCurrentSelectionWithSource('big-pickle', null, { modelId: spark.id, reasoningEffort: 'minimal' }, catalog))
      .toEqual({ current: { modelId: spark.id, reasoningEffort: 'minimal' }, source: 'native' });
    // The runtime server's model settles it too, even before the footer is readable.
    expect(openCodeCurrentSelectionWithSource('big-pickle', { modelId: spark.id, reasoningEffort: 'minimal' }, null, catalog))
      .toEqual({ current: { modelId: spark.id, reasoningEffort: 'minimal' }, source: 'server' });
    // A picker-applied model the server agrees with stays a server reading.
    expect(openCodeCurrentSelectionWithSource('big-pickle', { modelId: bigPickle.id, reasoningEffort: 'low' }, null, catalog))
      .toEqual({ current: { modelId: bigPickle.id, reasoningEffort: 'low' }, source: 'server' });
    // Nothing confirmed and no advertised default: no selection is invented.
    expect(openCodeCurrentSelectionWithSource('unknown/model', null, null, catalog))
      .toEqual({ current: null, source: null });
  });

  it('keeps the plain selection API returning the same reading', () => {
    expect(openCodeCurrentSelection('big-pickle', null, { modelId: spark.id, reasoningEffort: 'minimal' }, catalog))
      .toEqual({ modelId: spark.id, reasoningEffort: 'minimal' });
  });
});
