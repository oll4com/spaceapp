import { useCallback, useEffect, useState } from "react";
import type { PromptVariable } from "@space/contracts";
import { getSpaceRuntime } from "../../runtime/SpaceRuntime.js";
import { saveUserSettingDebounced } from "../user-settings/user-settings-save-queue.js";

export const PROMPT_VARIABLES_STORAGE_KEY = "space.promptVariables.v1";
export const PROMPT_VARIABLES_SETTINGS_STORAGE_KEY = "space.promptVariables.settings.v1";
export const PROMPT_VARIABLES_UPDATED_EVENT = "space:prompt-variables-updated";

export interface PromptVariablesSettings {
  /** Master toggle to enable or disable # prompt variables autocomplete and expansion. */
  enabled: boolean;
  /** Automatically expand any recognized #variable tokens upon submitting prompt. */
  autoExpandOnSubmit: boolean;
}

export const defaultPromptVariablesSettings: PromptVariablesSettings = {
  enabled: true,
  autoExpandOnSubmit: true
};

export interface PromptVariableToken {
  /** The search query string following '#', e.g. "pc_th" */
  query: string;
  /** The full token string, e.g. "#pc_th" */
  token: string;
  /** Start index of the '#' in the source string */
  startIndex: number;
  /** End index of the token in the source string */
  endIndex: number;
}

function getStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return getSpaceRuntime().platform.localStorage;
  } catch {
    return window.localStorage;
  }
}

export const DEFAULT_PROMPT_VARIABLES: PromptVariable[] = [];

export const PROMPT_VARIABLE_NAME_PATTERN = /^[a-zA-Z0-9_\-\u0370-\u03ff]+$/;
export type PromptVariableInput = Omit<PromptVariable, "id" | "createdAt" | "updatedAt">;

export function cleanPromptVariableName(name: string): string {
  return name.trim().replace(/^#+/, "");
}

// Names are unique case-insensitively, because expansion matches them that way.
export function promptVariableNameError(
  name: string,
  variables: readonly PromptVariable[],
  excludeId: string | null = null
): string | null {
  const clean = cleanPromptVariableName(name);
  if (!clean) return "Variable name is required.";
  if (!PROMPT_VARIABLE_NAME_PATTERN.test(clean)) {
    return "Variable name can only contain letters, numbers, underscores, and hyphens.";
  }
  if (variables.some((variable) => variable.id !== excludeId && variable.name.toLowerCase() === clean.toLowerCase())) {
    return `A variable named #${clean} already exists.`;
  }
  return null;
}

export interface PromptVariablesImport {
  variables: PromptVariableInput[];
  skipped: number;
}

// Reads an export file; entries without a valid name or a value are counted as skipped, never guessed.
export function parsePromptVariablesImport(text: string): PromptVariablesImport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("The file is not valid JSON.");
  }
  if (!Array.isArray(parsed)) throw new Error("The file must contain a list of variables.");
  const byName = new Map<string, PromptVariableInput>();
  let skipped = 0;
  const optional = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
  for (const item of parsed) {
    const record = item && typeof item === "object" ? item as Record<string, unknown> : null;
    const name = typeof record?.name === "string" ? cleanPromptVariableName(record.name) : "";
    const value = typeof record?.value === "string" ? record.value : "";
    if (!record || !PROMPT_VARIABLE_NAME_PATTERN.test(name) || !value.trim()) {
      skipped += 1;
      continue;
    }
    byName.set(name.toLowerCase(), {
      name,
      value,
      label: optional(record.label),
      category: optional(record.category),
      description: optional(record.description)
    });
  }
  if (!byName.size) throw new Error("The file has no valid variables (each needs a name and a value).");
  return { variables: [...byName.values()], skipped };
}

export function readStoredPromptVariables(): PromptVariable[] {
  const storage = getStorage();
  if (!storage) return [];
  try {
    const raw = storage.getItem(PROMPT_VARIABLES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function readStoredPromptVariablesSettings(): PromptVariablesSettings {
  const storage = getStorage();
  if (!storage) return defaultPromptVariablesSettings;
  try {
    const raw = storage.getItem(PROMPT_VARIABLES_SETTINGS_STORAGE_KEY);
    if (!raw) return defaultPromptVariablesSettings;
    const parsed = JSON.parse(raw) as Partial<PromptVariablesSettings>;
    return {
      enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : defaultPromptVariablesSettings.enabled,
      autoExpandOnSubmit:
        typeof parsed.autoExpandOnSubmit === "boolean"
          ? parsed.autoExpandOnSubmit
          : defaultPromptVariablesSettings.autoExpandOnSubmit
    };
  } catch {
    return defaultPromptVariablesSettings;
  }
}

export function writePromptVariables(variables: PromptVariable[]): void {
  const storage = getStorage();
  if (storage) {
    try {
      storage.setItem(PROMPT_VARIABLES_STORAGE_KEY, JSON.stringify(variables));
    } catch {
      // Ignore quota errors
    }
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(PROMPT_VARIABLES_UPDATED_EVENT, { detail: { variables } }));
  }
  saveUserSettingDebounced("promptVariables", variables);
}

export function writePromptVariablesSettings(updates: Partial<PromptVariablesSettings>): void {
  const current = readStoredPromptVariablesSettings();
  const next: PromptVariablesSettings = {
    ...current,
    ...updates
  };
  const storage = getStorage();
  if (storage) {
    try {
      storage.setItem(PROMPT_VARIABLES_SETTINGS_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Ignore quota errors
    }
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(PROMPT_VARIABLES_UPDATED_EVENT, { detail: { settings: next } }));
  }
  if (updates.enabled !== undefined) {
    saveUserSettingDebounced("promptVariablesEnabled", next.enabled);
  }
  if (updates.autoExpandOnSubmit !== undefined) {
    saveUserSettingDebounced("promptVariablesAutoExpandOnSubmit", next.autoExpandOnSubmit);
  }
}

export function applyServerPromptVariablesSettings(payload: {
  variables?: PromptVariable[];
  enabled?: boolean;
  autoExpandOnSubmit?: boolean;
}): void {
  const storage = getStorage();
  let changed = false;

  if (Array.isArray(payload.variables) && storage) {
    storage.setItem(PROMPT_VARIABLES_STORAGE_KEY, JSON.stringify(payload.variables));
    changed = true;
  }

  if ((typeof payload.enabled === "boolean" || typeof payload.autoExpandOnSubmit === "boolean") && storage) {
    const current = readStoredPromptVariablesSettings();
    const next: PromptVariablesSettings = {
      enabled: typeof payload.enabled === "boolean" ? payload.enabled : current.enabled,
      autoExpandOnSubmit:
        typeof payload.autoExpandOnSubmit === "boolean" ? payload.autoExpandOnSubmit : current.autoExpandOnSubmit
    };
    storage.setItem(PROMPT_VARIABLES_SETTINGS_STORAGE_KEY, JSON.stringify(next));
    changed = true;
  }

  if (changed && typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(PROMPT_VARIABLES_UPDATED_EVENT));
  }
}

/**
 * Detects if the text immediately preceding the cursor ends in an active '#' variable token.
 * Example matches:
 *  "#" -> { query: "", token: "#", startIndex: 0, endIndex: 1 }
 *  "connect to #pc_th" -> { query: "pc_th", token: "#pc_th", startIndex: 11, endIndex: 17 }
 *  "escaped \\#pc_th" -> null (escaped)
 *  "page#anchor" -> null (a token starts a word, so URLs and words with '#' are left alone)
 */
export function findActiveVariableToken(textBeforeCursor: string): PromptVariableToken | null {
  if (!textBeforeCursor) return null;

  // '#' must start a word: line start, whitespace or an opening bracket/quote (never '\\#', 'page#anchor').
  const match = /(?:^|[\s([{"'«])(#([a-zA-Z0-9_\-\u0370-\u03ff]*))$/.exec(textBeforeCursor);
  if (!match || match[1] === undefined) return null;

  const fullToken = match[1];
  const query = match[2] ?? "";
  const startIndex = textBeforeCursor.length - fullToken.length;
  const endIndex = textBeforeCursor.length;

  return {
    query,
    token: fullToken,
    startIndex,
    endIndex
  };
}

/**
 * Filters and ranks prompt variables matching a search query.
 */
export function filterPromptVariables(variables: readonly PromptVariable[], query: string): PromptVariable[] {
  if (!variables.length) return [];
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) {
    // Return all sorted alphabetically by name
    return [...variables].sort((a, b) => a.name.localeCompare(b.name));
  }

  const results: { variable: PromptVariable; score: number }[] = [];

  for (const item of variables) {
    const nameLower = item.name.toLowerCase();
    const labelLower = (item.label ?? "").toLowerCase();
    const descLower = (item.description ?? "").toLowerCase();
    const categoryLower = (item.category ?? "").toLowerCase();

    if (nameLower === trimmed) {
      results.push({ variable: item, score: 100 });
    } else if (nameLower.startsWith(trimmed)) {
      results.push({ variable: item, score: 80 });
    } else if (nameLower.includes(trimmed)) {
      results.push({ variable: item, score: 60 });
    } else if (labelLower.startsWith(trimmed)) {
      results.push({ variable: item, score: 50 });
    } else if (labelLower.includes(trimmed) || descLower.includes(trimmed) || categoryLower.includes(trimmed)) {
      results.push({ variable: item, score: 30 });
    }
  }

  return results
    .sort((a, b) => b.score - a.score || a.variable.name.localeCompare(b.variable.name))
    .map((r) => r.variable);
}

/**
 * Expands all recognized '#variable_name' tokens into their replacement values.
 * Escaped tokens ('\#name') are preserved as '#name' without replacement.
 */
export function expandPromptVariables(
  text: string,
  variables: readonly PromptVariable[],
  options?: { autoUnescape?: boolean }
): string {
  if (!text || !variables.length) {
    if (options?.autoUnescape) {
      return text.replace(/\\#/g, "#");
    }
    return text;
  }

  const varMap = new Map<string, string>();
  for (const v of variables) {
    varMap.set(v.name.toLowerCase(), v.value);
  }

  // Replace unescaped #variable_name
  const expanded = text.replace(/(^|[\s([{"'«])#([a-zA-Z0-9_\-\u0370-\u03ff]+)/g, (match, prefix, varName) => {
    const val = varMap.get(varName.toLowerCase());
    if (val !== undefined) {
      return `${prefix}${val}`;
    }
    return match;
  });

  if (options?.autoUnescape) {
    return expanded.replace(/\\#/g, "#");
  }
  return expanded;
}

// A room mounts several CLI panes, each with two prompt-variable consumers, at once. Share one
// server sync per burst instead of fetching /api/user-settings on every mount; the result reaches
// every hook through PROMPT_VARIABLES_UPDATED_EVENT.
const SERVER_SYNC_WINDOW_MS = 10_000;
let lastServerSyncAt: number | null = null;

export function syncPromptVariablesFromServer(now = Date.now()): void {
  if (lastServerSyncAt !== null && now - lastServerSyncAt < SERVER_SYNC_WINDOW_MS) return;
  try {
    const runtime = getSpaceRuntime();
    if (!runtime?.api?.userSettings) return;
    lastServerSyncAt = now;
    runtime.api.userSettings().then((serverSettings: any) => {
      if (serverSettings && Array.isArray(serverSettings.promptVariables)) {
        applyServerPromptVariablesSettings({
          variables: serverSettings.promptVariables,
          enabled: serverSettings.promptVariablesEnabled,
          autoExpandOnSubmit: serverSettings.promptVariablesAutoExpandOnSubmit
        });
      }
    }).catch(() => {
      lastServerSyncAt = null;
    });
  } catch {
    // Ignore if runtime is not ready
  }
}

export function resetPromptVariablesServerSyncForTests(): void {
  lastServerSyncAt = null;
}

/**
 * React hook to access and manage prompt variables and settings.
 */
export function usePromptVariables() {
  const [variables, setVariables] = useState<PromptVariable[]>(() => readStoredPromptVariables());
  const [settings, setSettings] = useState<PromptVariablesSettings>(() => readStoredPromptVariablesSettings());

  useEffect(() => {
    const handler = () => {
      setVariables(readStoredPromptVariables());
      setSettings(readStoredPromptVariablesSettings());
    };
    window.addEventListener(PROMPT_VARIABLES_UPDATED_EVENT, handler);
    return () => window.removeEventListener(PROMPT_VARIABLES_UPDATED_EVENT, handler);
  }, []);

  useEffect(() => {
    syncPromptVariablesFromServer();
  }, []);

  const addVariable = useCallback((input: Omit<PromptVariable, "id" | "createdAt" | "updatedAt">) => {
    const id = `pv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const now = new Date().toISOString();
    const newVar: PromptVariable = {
      ...input,
      id,
      name: input.name.trim().replace(/^#+/, ""),
      createdAt: now,
      updatedAt: now
    };
    const next = [...readStoredPromptVariables().filter((v) => v.name.toLowerCase() !== newVar.name.toLowerCase()), newVar];
    writePromptVariables(next);
    return newVar;
  }, []);

  const updateVariable = useCallback((id: string, updates: Partial<Omit<PromptVariable, "id" | "createdAt">>) => {
    const current = readStoredPromptVariables();
    const index = current.findIndex((v) => v.id === id);
    if (index === -1) return null;
    const existing = current[index]!;
    const updated: PromptVariable = {
      ...existing,
      ...updates,
      name: updates.name ? updates.name.trim().replace(/^#+/, "") : existing.name,
      updatedAt: new Date().toISOString()
    };
    const next = [...current];
    next[index] = updated;
    writePromptVariables(next);
    return updated;
  }, []);

  const deleteVariable = useCallback((id: string) => {
    const current = readStoredPromptVariables();
    const next = current.filter((v) => v.id !== id);
    writePromptVariables(next);
  }, []);

  // Puts back a deleted variable exactly as it was (Undo).
  const restoreVariable = useCallback((variable: PromptVariable) => {
    const current = readStoredPromptVariables().filter((v) =>
      v.id !== variable.id && v.name.toLowerCase() !== variable.name.toLowerCase());
    writePromptVariables([...current, variable]);
  }, []);

  // merge: imported names update or add, others stay. replace: the import becomes the whole list.
  const importVariables = useCallback((entries: readonly PromptVariableInput[], mode: "merge" | "replace") => {
    const now = new Date().toISOString();
    const current = mode === "merge" ? readStoredPromptVariables() : [];
    const next = [...current];
    for (const entry of entries) {
      const index = next.findIndex((v) => v.name.toLowerCase() === entry.name.toLowerCase());
      if (index >= 0) {
        next[index] = { ...next[index]!, ...entry, updatedAt: now };
      } else {
        next.push({ ...entry, id: `pv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, createdAt: now, updatedAt: now });
      }
    }
    writePromptVariables(next);
  }, []);

  const updateSettings = useCallback((updates: Partial<PromptVariablesSettings>) => {
    writePromptVariablesSettings(updates);
  }, []);

  return {
    variables,
    settings,
    addVariable,
    updateVariable,
    deleteVariable,
    restoreVariable,
    importVariables,
    updateSettings
  };
}
