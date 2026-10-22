import type { PaneCliModelSettings } from '@space/contracts';

type Model = PaneCliModelSettings['models'][number];
const compact = (value: string) => value.replace(/\s/g, '').toLowerCase();
/** Find the native composer row without relying on column separators.
 * Narrow panes omit the middle dots, so this matches the bordered input row
 * by structure instead: a bordered line closed by the input rail below. */
export function openCodeComposerLine(screen: string): string | null {
  const lines = screen.split('\n');
  const window = lines.slice(-14);
  for (let i = window.length - 1; i >= 0; i--) {
    const line = window[i]!;
    if (!/^\s*[┃│]/.test(line)) continue;
    const next = window.slice(i + 1, i + 3).join('\n');
    if (!/^[ \t]*╹[▀━─]{3,}/m.test(next) && !/\(\d+(?:\.\d+)?%\)/.test(next) && !/ctrl\+p/.test(next)) continue;
    return line;
  }
  return null;
}

/** Resolve a persisted OpenCode model id to its advertised catalog entry.
 * A fresh pane persists the runtime descriptor's bare native alias
 * ("big-pickle"), while the OpenCode catalog advertises composite
 * "provider/model" ids ("opencode/big-pickle"). An exact id always wins; a
 * bare alias is resolved only when a single advertised model matches it, so
 * an ambiguous alias never invents a selection. */
export function advertisedOpenCodeModel(
  persistedModelId: string | null | undefined,
  models: readonly Model[]
): Model | null {
  if (!persistedModelId) return null;
  const exact = models.find((model) => model.id === persistedModelId);
  if (exact) return exact;
  if (persistedModelId.includes('/')) return null;
  const native = models.filter((model) => model.id.split('/').slice(1).join('/') === persistedModelId);
  return native.length === 1 ? native[0]! : null;
}

/** Where an OpenCode pane's reported current model came from.
 * 'session-default' is the pane's persisted session default (a fresh pane
 * persists the runtime descriptor default), used only as a placeholder while
 * neither the native TUI nor the OpenCode server reports a model. It is NOT
 * evidence of the model the CLI actually runs, so callers must keep re-reading
 * until a native or server reading confirms it. */
export type OpenCodeCurrentSource = 'native' | 'server' | 'session-default';

/** Prefer the picker-applied server model over a stale native footer. */
export function openCodeCurrentSelection(
  persistedModelId: string | null | undefined,
  serverCurrent: PaneCliModelSettings['current'],
  nativeCurrent: PaneCliModelSettings['current'],
  models?: readonly Model[],
  persistedReasoningEffort?: string | null
): PaneCliModelSettings['current'] {
  return openCodeCurrentSelectionWithSource(
    persistedModelId, serverCurrent, nativeCurrent, models, persistedReasoningEffort
  ).current;
}

/** The current selection together with the source that produced it, so a pane
 * can tell a confirmed reading from the provisional session default. */
export function openCodeCurrentSelectionWithSource(
  persistedModelId: string | null | undefined,
  serverCurrent: PaneCliModelSettings['current'],
  nativeCurrent: PaneCliModelSettings['current'],
  models?: readonly Model[],
  persistedReasoningEffort?: string | null
): { current: PaneCliModelSettings['current']; source: OpenCodeCurrentSource | null } {
  // An idle TUI does not re-render its footer after a server-side switch,
  // so a stale native label can mask the applied model. When the picker
  // explicitly set a model and the server agrees with it, trust the server.
  // A native change made inside the TUI updates the server too, so genuine
  // native drift still wins through the fallback below. The persisted id is
  // compared in its advertised form as well, so a pane whose session still
  // holds the descriptor's bare alias does not lose the server's model.
  const persistedModel = advertisedOpenCodeModel(persistedModelId, models ?? []);
  if (serverCurrent && (serverCurrent.modelId === persistedModelId || serverCurrent.modelId === persistedModel?.id)) {
    return { current: serverCurrent, source: 'server' };
  }
  if (nativeCurrent) return { current: nativeCurrent, source: 'native' };
  if (serverCurrent) return { current: serverCurrent, source: 'server' };
  // Fresh pane: TUI not readable yet and server has no current. Fall back to
  // the persisted session defaults when advertised, like Codex and native
  // runtimes do, so the picker shows model + reasoning from the start.
  // Without resolving the bare alias first, a fresh OpenCode pane reported no
  // current model at all, which hid the model AND the reasoning control in the
  // compact picker until an explicit model switch. The reading stays marked as
  // the session default: it is a placeholder, not what the CLI runs.
  if (persistedModel) {
    const effort = persistedReasoningEffort && persistedModel.supportedReasoningEfforts.includes(persistedReasoningEffort)
      ? persistedReasoningEffort
      : persistedModel.defaultReasoningEffort;
    return { current: { modelId: persistedModel.id, reasoningEffort: effort }, source: 'session-default' };
  }
  return { current: null, source: null };
}

/** Read the native composer, including OpenTUI's separately wrapped columns. */
export function openCodeTuiSelection(screen: string, models: readonly Model[]): PaneCliModelSettings['current'] {
  const lines = screen.split('\n');
  const start = lines.findLastIndex(line => /^\s*[┃│].*·/.test(line));
  if (start >= 0) {
    const wide = readWideOpenCodeComposer(lines, start, models);
    if (wide) return wide;
  }
  // Narrow panes omit the middle-dot separators: match the composer row
  // against advertised display names and read a trailing effort token.
  // Narrow panes also WRAP the footer across rows, so a single line never
  // holds the full model name: join every bordered middle-dot row (except
  // the hints row) before matching. The effort tail can split across the
  // wrap; report 'unknown' instead of guessing when it does not match.
  const composer = openCodeComposerLine(screen);
  const region = lines.filter(
    (line) => /^\s*[┃│]/.test(line) && line.includes('·') && !/ctrl\+p/i.test(line)
  );
  const flat = compact([...(composer ? [composer] : []), ...region].join(''));
  if (flat) {
    const narrow = models.filter(model => flat.includes(compact(model.displayName)));
    if (narrow.length === 1) {
      const model = narrow[0]!;
      const tailSource = region.length ? region.at(-1)! : composer!;
      const tail = tailSource.trim().split(/\s+/).at(-1) ?? '';
      return {
        modelId: model.id,
        reasoningEffort: model.supportedReasoningEfforts.includes(tail) ? tail : 'unknown'
      };
    }
  }
  return null;
}

function readWideOpenCodeComposer(lines: string[], start: number, models: readonly Model[]): PaneCliModelSettings['current'] {
  const first = lines[start]!;
  const footer = lines.slice(start, start + 12).filter(line => /^\s*[┃│]/.test(line));
  const modelStart = first.indexOf('·') + 1;
  const gap = /\S(\s{2,})\S/.exec(first.slice(modelStart));
  const nameColumnEnd = gap ? modelStart + gap.index + 1 + gap[1]!.length : null;
  const nameColumn = nameColumnEnd === null ? null : compact(footer.map(line => line.slice(modelStart, nameColumnEnd)).join(''));
  const candidates = models.filter(model => {
    if (nameColumn === compact(model.displayName)) return true;
    const label = compact(model.displayName + (model.description ?? ''));
    return compact(first.slice(modelStart).split('·')[0]!) === label;
  });
  if (candidates.length !== 1) return null;
  const model = candidates[0]!;
  const effortAt = first.lastIndexOf('·');
  if (effortAt < modelStart) return { modelId: model.id, reasoningEffort: 'default' };
  const effortText = compact(footer.map(line => line.slice(effortAt + 1).trim().split(/\s{2,}/)[0]).join(''));
  const effort = model.supportedReasoningEfforts.filter(value => value.startsWith(effortText));
  return { modelId: model.id, reasoningEffort: effortText && effort.length === 1 ? effort[0]! : 'unknown' };
}
