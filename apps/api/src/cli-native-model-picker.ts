import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PaneCliModelSettings } from "@space/contracts";
import { parseCliModelsTsv } from "./chat-providers.js";
import { SpaceConflictError, SpaceFeatureDisabledError } from "@space/runtime";

const execute = promisify(execFile);
type Model = PaneCliModelSettings["models"][number];
type Screen = { text: string; revision: number };
type NativeControl = { runtimeId: string; read: () => Promise<Screen>; write: (data: string) => Promise<unknown>; assertCurrent: () => Promise<void>; wait?: (ms: number) => Promise<void> };
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const cursorFamilyName = (name: string) => name.replace(/(?:\s+(?:\d+(?:\.\d+)?[MK]|Extra High|None|Low|Medium|High|Thinking|Fast|Max))+$/i, "").trim();
const geminiFamilyName = (name: string) => name.replace(/\s*\((?:Extra High|None|Low|Medium|High|Thinking|Fast|Max)\)\s*$/i, "").trim();

function nativeSettingsMenu(screen: string): boolean {
  // Cursor can retain a rendered model list above its next composer. Only the
  // interaction at the bottom is active; old transcript menus need no Escape.
  const lastPrompt = [...screen.matchAll(/^\s*(?:[│┃]\s*[❯›>]|[❯›>]|→)\s*(.*)$/gm)].at(-1);
  const menu = [...screen.matchAll(/Select (?:a )?model|Select thinking effort|Type to filter[\s\S]*?Tab to\s+edit|Edit\s+P\s*a\s*r\s*a\s*m\s*e\s*t\s*e\s*r\s*s[\s\S]*?Esc to go\s+back|Changes apply to this session only/gi)].at(-1);
  return Boolean(menu && (!lastPrompt || menu.index! + menu[0].length > lastPrompt.index! || /Select (?:a )?model|Select thinking effort/i.test(menu[0])));
}

function nativeApprovalOrTurn(screen: string): boolean {
  return /esc(?:ape)?\s+to\s+interrupt|ctrl\+c to interrupt|allow (?:once|always)|approve this|do you want to proceed/i.test(screen);
}

/** Model controls may replace a native settings menu, never a user prompt or approval. */
export async function prepareNativeCliSettings(input: NativeControl): Promise<Screen> {
  const wait = input.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  await input.assertCurrent();
  let screen = await input.read();
  if (nativeApprovalOrTurn(screen.text)) {
    throw new SpaceConflictError('Finish the current CLI turn or dialog before changing model settings.');
  }
  for (let attempt = 0; nativeSettingsMenu(screen.text) && attempt < 3; attempt++) {
    await input.assertCurrent(); await input.write('\u001b'); await wait(350); screen = await input.read();
    if (nativeApprovalOrTurn(screen.text)) throw new SpaceConflictError('Finish the current CLI turn or dialog before changing model settings.');
  }
  if (nativeSettingsMenu(screen.text)) throw new SpaceConflictError('Close the native model menu before changing settings.');
  const promptLines = screen.text.split('\n');
  const promptAt = input.runtimeId === 'cli:omp'
    ? promptLines.findLastIndex(line => /^\s*╰─\s*/u.test(line))
    : promptLines.findLastIndex(line => /^\s*(?:[│┃]\s*[❯›>]|[❯›>]|→)\s*/u.test(line));
  let prompt = promptLines[promptAt]?.replace(/^\s*(?:[│┃]\s*[❯›>]|[❯›>]|→|╰─)\s*/u, '').replace(/\s*[│┃]\s*$/, '').trim();
  if (input.runtimeId === 'cli:cursor' && prompt && !prompt.startsWith('/')) {
    for (const next of promptLines.slice(promptAt + 1, promptAt + 4)) {
      if (!/^\s+\S/.test(next) || /Run Everything|Ask Every Time|^[\s│┃╭╰─]*$/u.test(next)) break;
      prompt += ` ${next.trim()}`;
    }
  }
  if (input.runtimeId === 'cli:omp' && prompt && promptAt >= 0) {
    for (const next of promptLines.slice(promptAt + 1)) {
      if (/^\s*[❯›>π╭╰]/.test(next) || !next.trim()) break;
      prompt += ` ${next.trim()}`;
    }
  }
  // Escape can restore a previous settings command. A normal draft is never
  // cleared, even when a previous picker attempt failed.
  if (prompt && /^\/(?:model|effort|reasoning|thinking|switch)(?:\s|$)/.test(prompt)) {
    await input.assertCurrent(); await input.write('\u0015'); await wait(250); screen = await input.read();
  } else if (prompt && !(input.runtimeId === 'cli:gemini' && /^(?:Accept-edits|Plan|Default) mode: /.test(prompt)) && !(input.runtimeId === 'cli:hermes' && [
    'Ask me anything…', 'Try "explain this codebase"', 'Try "write a test for…"',
    'Try "refactor the auth module"', 'Try "/help" for commands',
    'Try "fix the lint errors"', 'Try "how does the config loader work?"'
  ].some(placeholder => prompt.length >= 12 && placeholder.startsWith(prompt))) && !/^(?:Ask anything(?:\.{3}|…)?|Ask (?:Cursor|Codex) to do anything|Plan, search, build(?: anything)?|Type your message(?:\.{3}|…)?|Send a message(?:\.{3}|…)?|Try "\/help" for(?: commands)?|(?:Accept-edits|Plan|Default) mode: [^\n]*\.\.\.)$/i.test(prompt)) {
    throw new SpaceConflictError('Send or clear the current CLI draft before changing model settings.');
  }
  return screen;
}

async function cleanupNativeSettingsMenu(input: NativeControl): Promise<void> {
  const wait = input.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < 3; attempt++) {
    await input.assertCurrent();
    const screen = (await input.read()).text;
    if (input.runtimeId === 'cli:omp' && /╰─[^\n]*\/switch/i.test(screen)) {
      await input.write('\u0015'); await wait(250);
      return;
    }
    if (nativeApprovalOrTurn(screen) || !nativeSettingsMenu(screen)) return;
    await input.write('\u001b'); await wait(250);
  }
}

/** Cursor lays out its model footer in a narrow column beside its mode. */
function cursorFooter(screen: string): string | null {
  const lines = screen.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = lines[i]!.trim().match(/^(?:(.*?)\s{2,})?(?:Run Everything|Ask Every Time)\s*$/);
    if (!match) continue;
    let model = match[1] ?? '';
    if (!model) {
      // At twenty columns Ink can allocate one character to the model column.
      const groups: string[] = [];
      let group = '';
      for (const next of lines.slice(i + 1)) {
        const part = next.trim();
        if (part.startsWith('/') || /^[╭╰│┃→❯›>]/u.test(part)) break;
        if (!part) { if (group) groups.push(group); group = ''; }
        else group += part;
      }
      if (group) groups.push(group);
      return groups.join(' ').replace(/\[\d+m/g, '').replace(/\s+/g, ' ').trim();
    }
    for (const next of lines.slice(i + 1)) {
      const part = next.trim();
      if (!part) continue;
      if (part.startsWith('/') || /^[╭╰│┃→❯›>]/u.test(part)) break;
      // Ink wraps a word in the middle when its footer column is very narrow.
      model += /[.-]$/.test(model) || /^\d/.test(part) && /\d$/.test(model) ? part : ` ${part}`;
    }
    return model;
  }
  return null;
}

export function nativeCliReasoningLevels(commandPath: string, model: Model): string[] {
  if (commandPath.endsWith('/deepseek-vscode-parity')) return ['auto', ...model.supportedReasoningEfforts.filter(e => e !== 'none')];
  if (commandPath.endsWith('/kimi-vscode-parity') && /^kimi-code\/k3(?:-256k)?$/.test(model.id)) return ['low', 'high', 'max'];
  if (commandPath.endsWith('/grok-vscode-parity')) return ['low', 'medium', 'high', 'xhigh'];
  if (commandPath.endsWith('/hermes-vscode-parity')) return ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  if (commandPath.endsWith('/claude-vscode-parity')) return ['auto', 'low', 'medium', 'high', 'xhigh'];
  if (commandPath.endsWith('/omp-vscode-parity')) return model.supportedReasoningEfforts.filter(e => e !== 'none');
  return [];
}

export function nativeCliCatalogModels(commandPath: string, raw: string): Model[] {
  const advertised = parseCliModelsTsv(raw);
  const families = new Map<string, Model>();
  const isCursor = commandPath.endsWith("/cursor-vscode-parity");
  const isGemini = commandPath.endsWith("/gemini-vscode-parity");
  for (const model of advertised) {
    const efforts = nativeCliReasoningLevels(commandPath, model);
    const displayName = isCursor
      ? cursorFamilyName(model.displayName)
      : isGemini
        ? geminiFamilyName(model.displayName)
        : model.displayName;
    const id = isCursor
      ? `cursor-family:${displayName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`
      : isGemini
        ? model.id.replace(/-(low|medium|high|thinking)$/, "")
        : model.id;

    if (isGemini) {
      const variantEffort = model.id.match(/-(low|medium|high)$/)?.[1]
        ?? (model.displayName.match(/\b(Low|Medium|High|Thinking)\b/i)?.[1]?.toLowerCase());
      if (variantEffort) {
        const normalizedEffort = variantEffort === "thinking" ? "high" : variantEffort;
        if (!efforts.includes(normalizedEffort)) efforts.push(normalizedEffort);
      }
      const previous = families.get(id);
      if (previous) {
        for (const eff of efforts) {
          if (!previous.supportedReasoningEfforts.includes(eff)) {
            previous.supportedReasoningEfforts.push(eff);
            previous.reasoningOptions?.push({ reasoningEffort: eff });
          }
        }
      }
    }
    if (isCursor) {
      const variantEffort = model.displayName.match(/\b(Extra High|None|Low|Medium|High|Max)(?:\s+Fast)?$/i)?.[1]?.toLowerCase().replace('extra high', 'xhigh')
        ?? model.id.match(/-(extra-high|none|low|medium|high|max)(?:-fast)?$/)?.[1]?.replace('extra-high','xhigh');
      if (variantEffort) efforts.push(variantEffort);
      const previous = families.get(id);
      if (previous && variantEffort && !previous.supportedReasoningEfforts.includes(variantEffort)) {
        previous.supportedReasoningEfforts.push(variantEffort);
        previous.reasoningOptions?.push({ reasoningEffort: variantEffort });
      }
    }
    if (!families.has(id)) {
      families.set(id, {
        ...model,
        id,
        displayName,
        defaultReasoningEffort: isGemini
          ? (efforts.includes("high") ? "high" : efforts[0] ?? "none")
          : efforts.includes(model.defaultReasoningEffort)
            ? model.defaultReasoningEffort
            : efforts[0] ?? "none",
        supportedReasoningEfforts: efforts.length ? [...efforts] : ["none"],
        reasoningOptions: efforts.map((reasoningEffort) => ({ reasoningEffort }))
      });
    }
  }
  return [...families.values()].map(model => {
    const order = ['auto','none','disabled','minimal','low','medium','high','xhigh','max','ultra'];
    model.supportedReasoningEfforts.sort((a,b) => order.indexOf(a) - order.indexOf(b));
    model.reasoningOptions?.sort((a,b) => order.indexOf(a.reasoningEffort) - order.indexOf(b.reasoningEffort));
    if (commandPath.endsWith('/cursor-vscode-parity') && model.supportedReasoningEfforts.includes('medium')) model.defaultReasoningEffort = 'medium';
    if (commandPath.endsWith('/gemini-vscode-parity') && model.supportedReasoningEfforts.includes('high')) model.defaultReasoningEffort = 'high';
    return model;
  });
}

/**
 * The catalog is advertised whole to the picker: slicing it here silently
 * dropped models the CLI had already advertised (Reasonix now returns 300+),
 * which made the picker offer a different set than the API had parsed.
 * The transport owns the byte bound instead (`nativeCliCatalogBufferBytes`).
 */
export const nativeCliCatalogBufferBytes = 8 * 1024 * 1024;

function nativeControlScreen(screen: string, runtimeId: string): string {
  // Reasonix draws a scrollbar at the right edge of every transcript row.
  return runtimeId === 'cli:deepseek' || runtimeId === 'cli:hermes' ? screen.replace(/[ \t]*[│┃█][ \t]*$/gm, '') : screen;
}

export function nativeCliConfirmedReasoning(screen: string, runtimeId: string, model?: Model): string | null {
  screen = nativeControlScreen(screen, runtimeId);
  if (runtimeId === 'cli:deepseek') {
    screen = screen.replace(/(effort for[^\n]*)(?:\n([^·❯›>─\n][^\n]*)){0,3}/g, value => value.replace(/\n/g, ' '));
  }
  if (runtimeId === 'cli:gemini') {
    const footer = screen.match(/(?:^|·)\s*Gemini [^·\n]+\s*·\s*(low|medium|high)\s*$/im);
    if (footer) return footer[1]!.toLowerCase();
    const setMsg = screen.match(/Model set to [^(\n]+\((High|Medium|Low)\)/i);
    if (setMsg) return setMsg[1]!.toLowerCase();
    if (model?.reasoningOptions?.length) return model.defaultReasoningEffort;
  }
  if (runtimeId === 'cli:cursor') {
    const footer = cursorFooter(screen);
    if (footer) return footer.replace(/\s/g, '').match(/(ExtraHigh|None|Low|Medium|High|Max)(?:Fast)?$/i)?.[1]?.toLowerCase().replace('extrahigh', 'xhigh') ?? null;
  }
  for (const raw of screen.split(/\r?\n/).reverse()) {
    const line = raw.trim().replace(/^[│┃·●⎿✓]\s*/, '');
    if (/\/(?:effort|thinking|reasoning|switch)\b|unknown|invalid|error/i.test(line)) continue;
    if (runtimeId === 'cli:omp' && /^\s*╰─/u.test(line)) continue;
    if (runtimeId === 'cli:grok') {
      // Grok clips its footer against the closing border at small widths.
      // A visible effort prefix is usable only when it identifies one level.
      const prefix = line.match(/^╰─+\s*Grok [\d.]+\s*\(([a-z]+)─+╯$/i)?.[1]?.toLowerCase();
      if (prefix) {
        const matches = ['low', 'medium', 'high', 'xhigh'].filter(effort => effort.startsWith(prefix));
        if (matches.length === 1) return matches[0]!;
      }
    }
    if (runtimeId === 'cli:omp') {
      const glyphMatch = line.match(/^π\s*>\s*(?:([o○◔◑◒◕◉⟳]|\[[^\]]+\])\s+)?([^>]+?)\s*>/)?.[1];
      if (glyphMatch) {
        const g = glyphMatch.toLowerCase();
        if (g === 'o' || g === '○' || g === '[min]') return 'minimal';
        if (g === '◔' || g === '[low]') return 'low';
        if (g === '◑' || g === '[med]') return 'medium';
        if (g === '◒' || g === '[high]') return 'high';
        if (g === '◕' || g === '[xhi]') return 'xhigh';
        if (g === '◉' || g === '[max]') return 'max';
        if (g === '⟳' || g === '[~]') return 'auto';
      }
      const effortMatch = line.match(/(?:\bthinking:\s*|\bthinking level:\s*|\bthinking\s+)(auto|off|minimal|low|medium|high|max|xhigh)\b/i)?.[1];
      if (effortMatch) return effortMatch.toLowerCase();
    }
    const value = runtimeId === 'cli:deepseek' ? line.match(/(?:\bEFFORT\s+|effort for .+? set to\s+)(auto|disabled|low|medium|high|xhigh|max)\b/)?.[1]
      : runtimeId === 'cli:kimi' ? line.match(/(?:\bthinking:\s*|^Thinking set to\s+)(low|high|max)\b/i)?.[1]
      : runtimeId === 'cli:grok' ? line.match(/Grok [\d.]+\s*\((low|medium|high|xhigh)\)/i)?.[1]
      : runtimeId === 'cli:hermes' ? line.match(/^reasoning:\s*(none|minimal|low|medium|high|xhigh|max|ultra)\b/i)?.[1]
      : runtimeId === 'cli:claude' && !/not applied|overrides|still controls|saved as your default for new/i.test(line) ? line.match(/^(?:Set effort level to|Current effort level:|Effort level set to)\s*(auto|low|medium|high|xhigh)\b/i)?.[1]
      : runtimeId === 'cli:cursor' && /\s{2,}(?:Run Everything|Ask Every Time)\s*$/.test(line) ? line.match(/\b(Extra High|None|Low|Medium|High|Max)(?:\s+Fast)?\s{2,}/i)?.[1]?.replace(/extra high/i,'xhigh')
      : null;
    if (value) return value.toLowerCase();
  }
  return null;
}

async function applyNativeCliReasoning(input: {
  runtimeId: string; effort: string; model: Model;
  read: () => Promise<Screen>; write: (data: string) => Promise<unknown>;
  assertCurrent: () => Promise<void>; wait?: (ms: number) => Promise<void>;
}): Promise<void> {
  if (!input.model.supportedReasoningEfforts.includes(input.effort)) throw new SpaceConflictError('This reasoning level is not supported by the selected model.');
  if (input.effort === 'none' && input.model.reasoningOptions?.length === 0) return;
  if (input.runtimeId === 'cli:cursor' && input.model.reasoningOptions?.length) return switchCursorReasoning(input);
  const prefix = ({'cli:deepseek':'/effort', 'cli:grok':'/effort', 'cli:claude':'/effort', 'cli:kimi':'/thinking', 'cli:hermes':'/reasoning'} as Record<string,string>)[input.runtimeId];
  if (!prefix) {
    if (input.runtimeId === 'cli:omp') {
      const wait = input.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
      const before = await prepareNativeCliSettings(input);
      if (nativeCliConfirmedReasoning(before.text, input.runtimeId, input.model) === input.effort) return;
      await input.write(`/switch ${input.model.id}:${input.effort}\r`);
      for (let i = 0; i < 40; i++) {
        await wait(250); await input.assertCurrent();
        const after = await input.read();
        if (after.revision === before.revision) continue;
        const confirmed = nativeCliConfirmedReasoning(after.text, input.runtimeId, input.model);
        if (confirmed === input.effort) return;
        if (/unknown command|unrecognized command|invalid (?:slash command|model|effort|reasoning)|model (?:not found|unavailable)|error:\s*(?:unknown model|invalid)/i.test(after.text)) {
          throw new SpaceConflictError('The CLI rejected this reasoning level.');
        }
        if (/╰─[^\n]*\/switch/i.test(after.text)) {
          await input.assertCurrent();
          await input.write('\r');
        }
        if (!confirmed && nativeCliConfirmedModel(after.text, [input.model], input.runtimeId) === input.model.id
          && !/╰─[^\n]*\/switch/i.test(after.text)
          && /Session-only model:/i.test(after.text)) {
          return;
        }
      }
      throw new SpaceConflictError('The CLI has not confirmed the reasoning change. Check its current settings.');
    }
    if (input.effort !== 'none') throw new SpaceConflictError('This CLI does not expose a separate reasoning control.');
    return;
  }
  const wait = input.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const before = await prepareNativeCliSettings(input);
  if (nativeCliConfirmedReasoning(before.text, input.runtimeId, input.model) === input.effort) return;
  if (/esc(?:ape)?\s+to\s+(?:interrupt|cancel)|ctrl\+c to interrupt|allow (?:once|always)|approve this|enter to (?:confirm|select)/i.test(before.text)) throw new SpaceConflictError('Finish the current CLI turn or dialog before changing reasoning.');
  const command = input.runtimeId === 'cli:kimi' ? prefix : `${prefix} ${input.effort}`;
  await input.write(command + (input.runtimeId === 'cli:deepseek' ? ' ' : ''));
  await wait(250); await input.assertCurrent(); await input.write('\r');
  let submitted = false;
  let kimiSelection = nativeCliConfirmedReasoning(before.text, input.runtimeId, input.model) ?? undefined;
  for (let i = 0; i < 40; i++) {
    await wait(250); await input.assertCurrent();
    const after = await input.read();
    if (after.revision === before.revision) continue;
    if ((!nativeSettingsMenu(after.text) || input.runtimeId !== 'cli:kimi') && nativeCliConfirmedReasoning(after.text, input.runtimeId, input.model) === input.effort) return;
    if (/unknown command|invalid (?:effort|reasoning)|unsupported effort/i.test(after.text)) throw new SpaceConflictError('The CLI rejected this reasoning level.');
    if (!submitted && input.runtimeId === 'cli:deepseek' && after.text.split('\n').some(l => l.trim() === `❯ ${command}`)) { await input.write('\r'); submitted = true; }
    if (!submitted && input.runtimeId === 'cli:kimi' && /Select thinking effort/.test(after.text)) {
      const selected = after.text.match(/\[\s*(Low|High|Max)\b/)?.[1]?.toLowerCase() ?? kimiSelection ?? (/\bLow\s+High\b/.test(after.text) ? 'max' : undefined);
      if (selected === input.effort) { await input.write('\u001bs'); submitted = true; }
      else if (selected) {
        const levels = ['low','high','max'];
        const direction = levels.indexOf(selected) < levels.indexOf(input.effort) ? 1 : -1;
        await input.write(direction > 0 ? '\u001b[C' : '\u001b[D');
        kimiSelection = levels[levels.indexOf(selected) + direction];
      }
    }
  }
  throw new SpaceConflictError('The CLI has not confirmed the reasoning change. Check its current settings.');
}

async function switchCursorReasoning(input: Parameters<typeof switchNativeCliReasoning>[0]): Promise<void> {
  const wait = input.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const before = await prepareNativeCliSettings(input);
  if (nativeCliConfirmedReasoning(before.text, input.runtimeId, input.model) === input.effort) return;
  if (/esc(?:ape)?\s+to\s+(?:interrupt|cancel)|ctrl\+c to interrupt|allow (?:once|always)|approve this|enter to (?:confirm|select)/i.test(before.text)) throw new SpaceConflictError('Finish the current CLI turn or dialog before changing reasoning.');
  await input.write('/model'); await wait(250); await input.assertCurrent(); await input.write('\r');
  let edited = false;
  let selected = false;
  let escaped = false;
  const label = input.effort === 'xhigh' ? 'Extra High' : input.effort[0]!.toUpperCase() + input.effort.slice(1);
  for (let i=0; i<70; i++) {
    await wait(250); await input.assertCurrent();
    const after = await input.read();
    if (after.revision === before.revision) continue;
    if (selected && nativeCliConfirmedReasoning(after.text, input.runtimeId, input.model) === input.effort) return;
    if (!edited && /Type to filter[\s\S]*Tab to\s+edit/.test(after.text)) { await input.write('\t'); edited = true; continue; }
    if (edited && /Edit\s+P\s*a\s*r\s*a\s*m\s*e\s*t\s*e\s*r\s*s/.test(after.text)) {
      const rows = after.text.split('\n').filter(l => /^[\s→]*[●○◯]/.test(l));
      const active = rows.findIndex(l => l.includes('→'));
      const target = rows.findIndex(l => l.replace(/^[\s→●○◯]+/,'').replace(/\s*✓\s*$/,'').trim() === label);
      if (target < 0) { await input.write('\u001b'); await wait(250); await input.write('\u001b'); throw new SpaceConflictError('The current Cursor model does not offer this reasoning level.'); }
      if (!selected && active === target) { await input.write('\r'); selected = true; continue; }
      if (!selected && active >= 0) { await input.write(active < target ? '\u001b[B' : '\u001b[A'); continue; }
      if (selected && !escaped) { await input.write('\u001b'); escaped = true; continue; }
    }
    if (selected && /Type to filter[\s\S]*Tab to\s+edit/.test(after.text)) { await input.write('\r'); }
  }
  throw new SpaceConflictError('Cursor has not confirmed the reasoning change.');
}

/** Only model metadata leaves the existing credential-owning CLI wrappers. */
export function createNativeCliModelCatalog() {
  const cache = new Map<string, { expires: number; value: Promise<Model[]> }>();
  return async (commandPath: string, accountProfileId: string | null = null): Promise<Model[]> => {
    const key = `${commandPath}:${accountProfileId ?? ""}`;
    const previous = cache.get(key);
    if (previous && previous.expires > Date.now()) return previous.value;
    const value = (async () => {
      try {
        const { stdout } = await execute(commandPath, ["models"], {
          timeout: 35_000, maxBuffer: nativeCliCatalogBufferBytes, encoding: "utf8",
          env: { PATH: process.env.PATH, LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TERM: "dumb",
            ...(accountProfileId && accountProfileId !== "main"
              ? { SPACE_GEMINI_ACCOUNT_PROFILE: accountProfileId, SPACE_CURSOR_ACCOUNT_PROFILE: accountProfileId }
              : {}) }
        });
        // Native adapters define their own effort levels; Chat metadata alone
        // does not establish support for an interactive CLI command.
        const models = nativeCliCatalogModels(commandPath, stdout);
        if (!models.length) throw new Error("empty catalog");
        return models;
      } catch {
        const disabledErr = new SpaceFeatureDisabledError("CLI_MODEL_CATALOG_UNAVAILABLE", "The CLI model catalog is unavailable. Try again shortly.");
        const rejected = Promise.reject(disabledErr);
        rejected.catch(() => {});
        cache.set(key, { expires: Date.now() + 15_000, value: rejected });
        throw disabledErr;
      }
    })();
    cache.set(key, { expires: Date.now() + 60_000, value });
    return value;
  };
}

/** A command echo or highlighted menu entry is never confirmation. */
export function nativeCliConfirmedModel(screen: string, models: readonly Model[], runtimeId = ""): string | null {
  screen = nativeControlScreen(screen, runtimeId);
  const footer = runtimeId === "cli:cursor" ? cursorFooter(screen) : null;
  const rawLines = (footer ? `${screen}\nModel: ${footer}` : screen).split(/\r?\n/);
  const lines = rawLines.map((line, index) => {
    let text = line.trim().replace(/^[│┃·●⎿└]\s*/, "");
    if (runtimeId === 'cli:gemini' && rawLines[index + 1]?.trim().startsWith('/') && models.some(model => model.displayName === text || model.displayName === geminiFamilyName(text))) text = `Model: ${text}`;
    if (/^(?:Model (?:set|changed|switched) to|Switched to|Already on|model →|Session-only model:?)/i.test(text)) {
      for (const next of rawLines.slice(index + 1, index + 7)) {
        if (!next.trim() || /^\s*[│┃╭╰─❯›>⎿└·●]/u.test(next) || /^(?:Model|Switched|Thinking set|reasoning:|EFFORT|YOLO|Ask When|Session-only)\b/i.test(next.trim())) break;
        text += /[-/]$/.test(text) ? next.trim() : ` ${next.trim()}`;
      }
    }
    return text;
  });
  for (const line of lines.reverse()) {
    if (/^\s*(?:\/(?:model|switch)\b|[❯›>→])/u.test(line)) continue;
    if (runtimeId === 'cli:omp' && /^\s*╰─/u.test(line)) continue;
    if (!/Session-only model:/i.test(line) && (/(?:^|\s)\/(?:model|switch)(?:\s|$)/i.test(line) || /(?:unknown|invalid|failed|rejected|unavailable|not found|error)\b/i.test(line))) continue;
    let modelText = line.match(/^(?:[✓✔✅*]\s*)?(?:(?:current |active )?model\s*[:→]|(?:model\s+)?(?:switched|changed|set|updated)(?:\s+model)?\s+(?:to\s*:?[ ]*)?|already on\s+|using\s+(?:model\s+)?)[ ]*(.*)$/i)?.[1];
    if (runtimeId === 'cli:gemini') {
      const footer = line.match(/(?:^|·)\s*(Gemini [^·]+)\s*·\s*(low|medium|high)\s*$/i);
      if (footer) modelText = `${footer[1]!.trim()} (${footer[2]![0]!.toUpperCase()}${footer[2]!.slice(1).toLowerCase()})`;
    }
    if (runtimeId === "cli:hermes" && /^[^│┃·]+\s*·\s*Nous Research/.test(line)) modelText ??= line.split(/\s*·\s*/)[0];
    if (runtimeId === "cli:deepseek") modelText ??= line.match(/\bMODEL\s+(.+?)\s+EFFORT\b/)?.[1];
    if (runtimeId === "cli:cursor" && /\s{2,}(?:Run Everything|Ask Every Time)\s*$/.test(line)) modelText = line.split(/\s{2,}/)[0];
    if (runtimeId === "cli:copilot" && /open sidebar.*tab next tab/i.test(line)) modelText = line.split(/\s{2,}/).at(-1);
    if (runtimeId === "cli:grok") modelText ??= line.match(/(Grok [0-9.]+)\s*\([^)]*\)\s*·/)?.[1]
      ?? line.match(/^╰─+\s*(Grok [0-9.]+)\s*\(/)?.[1];
    if (runtimeId === "cli:omp") {
      modelText ??= line.match(/(?:Session-only model:\s*|Model set to\s*|Current model:\s*)([^\s]+?)(?:\.\s|\.$|\s|$)/i)?.[1]
        ?? line.match(/^π\s*>\s*(?:([o○◔◑◒◕◉⟳]|\[[^\]]+\])\s+)?([^>]+?)\s*>/)?.[2];
    }
    if (!modelText || /^persisted\b/i.test(modelText) || /…|\.\.\./.test(modelText)) continue;
    modelText = modelText.replace(/[.,;:]+$/, "");
    if (runtimeId === "cli:omp") modelText = modelText.replace(/:(?:auto|off|minimal|low|medium|high|max|xhigh)$/i, "");
    const matched = new Set<string>();
    for (const model of models) {
      const candidateText = (runtimeId === "cli:cursor" && model.id.startsWith("cursor-family:")
        ? cursorFamilyName(modelText.trim())
        : runtimeId === "cli:gemini" && !/-(low|medium|high)$/.test(model.id)
          ? geminiFamilyName(modelText.trim())
          : modelText.trim()).replace(/\s+/g, ' ');
      const names = [model.id, model.displayName];
      if (runtimeId === "cli:gemini") names.push(geminiFamilyName(model.displayName));
      if (runtimeId === "cli:deepseek") names.push(model.id.slice(model.id.indexOf("/") + 1));
      if (runtimeId === "cli:hermes" && model.id.includes(":")) names.push(model.id.slice(model.id.indexOf(":") + 1));
      if (runtimeId === "cli:grok") names.push(model.id.replace(/^grok-/, "Grok "));
      if (runtimeId === "cli:omp" && model.id.includes("/")) names.push(model.id.split("/").slice(1).join("/"));
      for (const name of names) {
        if (runtimeId === 'cli:cursor') {
          // Ink wraps both words and tokens in a 1–8 character footer column.
          // Compare the advertised family and only known parameter suffixes.
          const compact = candidateText.replace(/\s/g, '').toLowerCase();
          const compactName = name.replace(/\s/g, '').toLowerCase();
          if (!compact.startsWith(compactName)) continue;
          const suffix = compact.slice(compactName.length);
          if (!suffix || model.id.startsWith('cursor-family:') && /^(?:\d+(?:\.\d+)?[mk]|extrahigh|none|low|medium|high|thinking|fast|max)+$/.test(suffix)) matched.add(model.id);
          continue;
        }
        const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const escaped = runtimeId === 'cli:deepseek' && !/\s/.test(name) ? [...name].map(escape).join('\\s*') : escape(name);
        if (new RegExp(`^["']?${escaped}(?:["']?$|["']?\\s*(?:[│┃·]|-(?:low|medium|high|thinking)|\\(|with thinking\\b|for this session\\b))`, "i").test(candidateText)) matched.add(model.id);
      }
    }
    if (matched.size === 1) return [...matched][0]!;
    if (runtimeId !== "cli:omp") return null;
  }
  return null;
}

async function applyNativeCliModel(input: {
  model: Model;
  runtimeId: string;
  effort?: string;
  read: () => Promise<Screen>;
  write: (data: string) => Promise<unknown>;
  assertCurrent: () => Promise<void>;
  wait?: (ms: number) => Promise<void>;
}): Promise<void> {
  if (!identifier.test(input.model.id)) throw new SpaceConflictError("The selected CLI model identifier is invalid.");
  const wait = input.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const before = await prepareNativeCliSettings(input);
  if (nativeCliConfirmedModel(before.text, [input.model], input.runtimeId) === input.model.id) {
    if ((input.runtimeId === 'cli:omp' || input.runtimeId === 'cli:gemini') && input.effort && input.effort !== 'none') {
      const confirmedEffort = nativeCliConfirmedReasoning(before.text, input.runtimeId, input.model);
      if (confirmedEffort && confirmedEffort === input.effort) return;
    } else {
      return;
    }
  }
  if (/esc(?:ape)?\s+to\s+(?:interrupt|cancel)|ctrl\+c to interrupt|allow (?:once|always)|approve this|enter to (?:confirm|select)/i.test(before.text)) {
    throw new SpaceConflictError("Finish the current CLI turn or dialog before changing models.");
  }
  const hermesParts = input.runtimeId === "cli:hermes" ? input.model.id.split(/:(.*)/s) : null;
  let targetModel = input.model.id;
  if (input.runtimeId === "cli:cursor") {
    targetModel = input.model.displayName;
  } else if (input.runtimeId === "cli:gemini") {
    const effort = input.effort ?? input.model.defaultReasoningEffort;
    if (effort && ['low', 'medium', 'high'].includes(effort) && !/-(low|medium|high)$/.test(targetModel)) {
      targetModel = `${targetModel}-${effort}`;
    }
  }
  const command = hermesParts?.[1]
    ? `/model ${hermesParts[1]} --provider ${hermesParts[0]} --session`
    : input.runtimeId === "cli:omp"
      ? `/switch ${input.model.id}${input.effort && input.effort !== 'none' ? `:${input.effort}` : ''}`
      : `/model ${targetModel}${input.runtimeId === "cli:hermes" ? " --session" : ""}`;
  if (/[\u0000-\u001f\u007f]/.test(command)) throw new SpaceConflictError("The CLI model label contains unsupported control characters.");
  await input.write(command + (input.runtimeId === "cli:deepseek" ? " " : ""));
  await wait(250);
  await input.assertCurrent();
  await input.write("\r");
  let lastMenuRevision = -1;
  let submittedCompletion = false;
  let kimiFiltered = false;
  for (let attempt = 0; attempt < 32; attempt++) {
    await wait(250);
    await input.assertCurrent();
    const after = await input.read();
    if (after.revision === before.revision) continue;
    // The preflight ruled out this model. Confirm the newly observed complete
    // screen: narrow acknowledgements can reuse an unchanged first line.
    const newLines = after.text.split(/\r?\n/).filter((line) => !before.text.split(/\r?\n/).includes(line)).join("\n");
    if (nativeCliConfirmedModel(after.text, [input.model], input.runtimeId) === input.model.id) {
      if ((input.runtimeId === 'cli:omp' || input.runtimeId === 'cli:gemini') && input.effort && input.effort !== 'none') {
        const confirmedEffort = nativeCliConfirmedReasoning(after.text, input.runtimeId, input.model);
        if (confirmedEffort === input.effort || (!confirmedEffort && !/unknown|invalid|error/i.test(after.text) && !/╰─[^\n]*\/switch/i.test(after.text))) return;
      } else {
        return;
      }
    }
    if (/models matching.*\(no matches\)/i.test(newLines)) {
      await input.assertCurrent();
      await input.write("\u001b");
      throw new SpaceConflictError("This model is not available in the CLI's current model menu. Choose another model.");
    }
    if (/can't be selected|only Auto mode is available/i.test(newLines)) {
      throw new SpaceConflictError("This CLI account does not allow the selected model. Choose Auto or check your plan.");
    }
    if (/unknown command|unrecognized command|invalid (?:slash command|model)|model (?:not found|unavailable)|error:\s*unknown model/i.test(newLines)) {
      throw new SpaceConflictError("The CLI rejected the model selection. Check its model menu.");
    }
    if (input.runtimeId === 'cli:kimi' && /Select a model/.test(after.text)) {
      if (!kimiFiltered) {
        await input.assertCurrent(); await input.write(input.model.displayName); kimiFiltered = true; continue;
      }
      // A single result for the complete advertised name is unambiguous even
      // when the native menu truncates that result's label at small widths.
      if (/^\s*1 \/ \d+\s*$/m.test(after.text)) {
        await input.assertCurrent(); await input.write('\u001bs'); continue;
      }
    }
    // Some CLIs open their native picker even when /model has an argument.
    // Navigate only an observed model menu, and still require its acknowledgement.
    if (after.revision !== lastMenuRevision && /select (?:a )?model|choose (?:a )?model|models matching/i.test(after.text)) {
      const highlighted = after.text.split(/\r?\n/).find((line) => /^\s*[❯›>●→]/u.test(line));
      const labels = [input.model.id, input.model.displayName];
      if (highlighted && labels.some((label) => after.text.includes(label))) {
        const highlightedLabel = highlighted.replace(/^\s*[❯›>●→]\s*/u, "").trim().split(/\s{2,}|\s+←/)[0];
        const selected = labels.includes(highlightedLabel!);
        lastMenuRevision = after.revision;
        await input.assertCurrent();
        await input.write(selected ? (input.runtimeId === "cli:kimi" ? "\u001bs" : "\r") : "\u001b[B");
      }
    }
    if (input.runtimeId === "cli:deepseek" && !submittedCompletion && after.text.split(/\r?\n/).some((line) =>
      line.replace(/^\s*❯\s*/u, "").trim() === command && /^\s*❯/u.test(line))) {
      // Reasonix's first Enter completes a slash command; submit only the exact
      // requested command, never a different model suggested by autocomplete.
      submittedCompletion = true;
      await input.assertCurrent();
      await input.write("\r");
    }
    if (input.runtimeId === "cli:omp" && /╰─[^\n]*\/switch/i.test(after.text)) {
      await input.assertCurrent();
      await input.write("\r");
    }
  }
  throw new SpaceConflictError("The CLI has not confirmed the model change. Check its terminal for a selection or confirmation dialog.");
}


export async function switchNativeCliModel(input: Parameters<typeof applyNativeCliModel>[0]): Promise<void> {
  try { await applyNativeCliModel(input); }
  catch (error) { try { await cleanupNativeSettingsMenu(input); } catch {} throw error; }
}

export async function switchNativeCliReasoning(input: Parameters<typeof applyNativeCliReasoning>[0]): Promise<void> {
  try { await applyNativeCliReasoning(input); }
  catch (error) { try { await cleanupNativeSettingsMenu(input); } catch {} throw error; }
}
