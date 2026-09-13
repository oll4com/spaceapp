import type { PaneCliModelSettings } from '@space/contracts';
import { SpaceConflictError } from '@space/runtime';

type Model = PaneCliModelSettings['models'][number];
type Control = {
  read: () => Promise<{ text: string; revision: number }>;
  write: (data: string) => Promise<unknown>;
  assertCurrent: () => Promise<void>;
  wait?: (ms: number) => Promise<void>;
  /** Advertised catalog for disambiguating wrapped menu fragments. */
  models: readonly Model[];
};
const compact = (value: string) => value.replace(/\s/g, '').toLowerCase();
const modelMenu = /Select model/;
const variantMenu = /Select(?:\s+esc)?\s+variant/;
// 1.18.x marks the selected menu row with a bullet that varies by width/theme.
const selectedMarker = /^[●•]\s/;
const stripSelectedMarker = (row: string) => row.replace(/^[●•]\s*/, '');

/** The attached TUI never showed a readable composer, so no keys were sent. */
export class OpenCodeNativeInputNotReadyError extends SpaceConflictError {
  constructor() {
    super('OpenCode is still preparing its native input. Try again shortly.');
    this.name = 'OpenCodeNativeInputNotReadyError';
  }
}

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
    if (!/^╹[▀━─]{3,}/m.test(next) && !/\(\d+(?:\.\d+)?%\)/.test(next) && !/ctrl\+p/.test(next)) continue;
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

/** Native dialogs separate their title, search, results and actions by empty rows. */
export function openCodeMenuRows(screen: string, heading: RegExp): string[] | null {
  const lines = screen.split('\n');
  const match = heading.exec(screen);
  if (!match) return null;
  const start = screen.slice(0, match.index).split('\n').length - 1;
  const groups: string[][] = [[]];
  for (const line of lines.slice(start)) {
    if (!line.trim()) { if (groups.at(-1)!.length) groups.push([]); }
    else groups.at(-1)!.push(line.trim());
    if (groups.length === 4) break;
  }
  return groups[2] ?? null;
}

export async function switchOpenCodeTuiSettings(input: Control & { model: Model; effort: string; skipModelStep?: boolean }): Promise<void> {
  const wait = input.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const send = async (keys: string) => { await input.assertCurrent(); await input.write(keys); await wait(60); };
  const observe = async () => { await input.assertCurrent(); return (await input.read()).text; };
  const awaitMenu = async (heading: RegExp) => {
    for (let i = 0; i < 40; i++) {
      const screen = await observe();
      if (heading.test(screen)) return screen;
      await wait(50);
    }
    throw new SpaceConflictError(`OpenCode did not open its native ${heading === modelMenu ? 'model' : 'reasoning'} menu.`);
  };
  const openModels = async () => {
    // Native shortcuts open a dialog without replacing an unsubmitted draft.
    await send('\u0018'); await send('m'); await awaitMenu(modelMenu);
  };
  const openVariants = async () => {
    await send('\u0010'); await awaitMenu(/Commands/);
    await send('Switch model variant'); await send('\r'); await awaitMenu(variantMenu);
  };
  const filter = async (heading: RegExp, query: string) => {
    await send(query);
    const rows = openCodeMenuRows(await awaitMenu(heading), heading);
    if (!rows?.length || rows.some(row => /No (?:results|matches)/i.test(row))) {
      throw new SpaceConflictError('OpenCode did not find the selected model setting.');
    }
    return rows;
  };
  /** A menu row is addressable only when its head names an advertised model. */
  const rowNamesKnownModel = (row: string) =>
    input.models.some(model => stripSelectedMarker(row).split(/\s{2,}/)[0] === model.displayName);
  const choose = async (rows: string[], label: string) => {
    const index = rows.length === 1 ? 0 : rows.findIndex(row => stripSelectedMarker(row).split(/\s{2,}/)[0] === label);
    if (index < 0 && rows.some(rowNamesKnownModel)) {
      throw new SpaceConflictError('OpenCode could not distinguish this model in its native menu. Expand the pane and try again.');
    }
    // Narrow panes wrap each result across fragment rows that no exact row
    // can match. The filter already focuses its top match: pressing Enter
    // without arrows selects it, and the server readback below confirms the
    // applied model before anything is persisted.
    for (let i = 0; i < Math.max(index, 0); i++) await send('\u001b[B');
    await send('\r');
  };
  const query = [input.model.displayName, input.model.description].filter(Boolean).join(' ');
  if (/[\u0000-\u001f\u007f]/.test(query)) throw new SpaceConflictError('The native model label is invalid.');
  await input.assertCurrent();
  let screen = await observe();
  // The HTTP catalog is ready before a newly attached TUI accepts keys.
  // Require its composer and keyboard hints to settle before the first shortcut.
  // The composer is detected structurally (bordered input row closed by the
  // input rail) so narrow panes without middle-dot separators qualify too.
  if (!modelMenu.test(screen) && !variantMenu.test(screen)) {
    let stable = 0;
    for (let i = 0; i < 60; i++) {
      if (openCodeComposerLine(screen) && /ctrl\+p/.test(screen) && /commands/.test(screen)) stable++;
      else stable = 0;
      if (stable >= 2) break;
      await wait(60); screen = await observe();
    }
    if (stable < 2) throw new OpenCodeNativeInputNotReadyError();
  }
  if (/allow (?:once|always)|approve this|permission required|esc to interrupt/i.test(screen)) {
    throw new SpaceConflictError('Finish the current OpenCode turn or approval before changing model settings.');
  }
  try {
    if (modelMenu.test(screen) || variantMenu.test(screen) || /Commands/.test(screen)) await send('\u001b');
    // Reasoning-only changes skip the model menu entirely: re-selecting the
    // already active model flashes the TUI through an extra model switch
    // without changing anything. Go straight to the variant step instead.
    if (!input.skipModelStep) {
      await openModels();
      await choose(await filter(modelMenu, query), input.model.displayName);
      // Dismiss whichever follow-up the TUI opened (the unified reasoning step
      // or the legacy variant dialog). A single pass keeps the terminal from
      // flashing menus repeatedly; the server readback below stays authoritative.
      await send('\u001b');
    }
    if (input.model.reasoningOptions?.length) {
      await openVariants();
      await choose(await filter(variantMenu, input.effort === 'default' ? 'Default' : input.effort), input.effort === 'default' ? 'Default' : input.effort);
    }
  } finally {
    screen = await observe();
    if (modelMenu.test(screen) || variantMenu.test(screen) || /Commands/.test(screen)) await send('\u001b');
  }
}
