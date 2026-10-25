export const PANE_NAMES = [
  "Andy",
  "Bob",
  "Cody",
  "Dana",
  "Emma",
  "Finn",
  "Hugo",
  "Iris",
  "Jack",
  "Kate",
  "Leo",
  "Max",
  "Nik",
  "Oscar",
  "Paul",
  "Zoe"
] as const;

export type PaneName = (typeof PANE_NAMES)[number];

export const PANE_NAME_ALIASES: Record<string, PaneName> = {
  andy: "Andy",
  "άντι": "Andy",
  "αντι": "Andy",
  bob: "Bob",
  "μπομπ": "Bob",
  cody: "Cody",
  "κόντι": "Cody",
  "κοντι": "Cody",
  dana: "Dana",
  "ντάνα": "Dana",
  "ντανα": "Dana",
  emma: "Emma",
  "έμμα": "Emma",
  "εμμα": "Emma",
  finn: "Finn",
  "φιν": "Finn",
  hugo: "Hugo",
  "ούγκο": "Hugo",
  "ουγκο": "Hugo",
  iris: "Iris",
  "ίρις": "Iris",
  "ιρις": "Iris",
  jack: "Jack",
  "τζακ": "Jack",
  kate: "Kate",
  "κέιτ": "Kate",
  "κειτ": "Kate",
  leo: "Leo",
  "λίο": "Leo",
  "λιο": "Leo",
  max: "Max",
  "μαξ": "Max",
  nik: "Nik",
  "νικ": "Nik",
  oscar: "Oscar",
  "όσκαρ": "Oscar",
  "οσκαρ": "Oscar",
  paul: "Paul",
  "πολ": "Paul",
  zoe: "Zoe",
  "ζόι": "Zoe",
  "ζοι": "Zoe"
};

/**
 * Normalizes a name string (case-insensitive, Greek transliterations, accent-insensitive)
 * to its canonical Latin PaneName if matched, or null if unrecognized.
 */
export function normalizePaneName(input: string): PaneName | null {
  if (!input || typeof input !== "string") return null;
  const raw = input.trim().toLowerCase();
  if (PANE_NAME_ALIASES[raw]) return PANE_NAME_ALIASES[raw];
  const stripped = raw.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (PANE_NAME_ALIASES[stripped]) return PANE_NAME_ALIASES[stripped];
  for (const name of PANE_NAMES) {
    if (name.toLowerCase() === raw || name.toLowerCase() === stripped) {
      return name;
    }
  }
  return null;
}

/**
 * Returns the first available PaneName from the fixed sequence that is not present in usedNames.
 */
export function pickNextAvailablePaneName(usedNames: Iterable<string | null | undefined>): string {
  const used = new Set<string>();
  for (const name of usedNames) {
    if (!name) continue;
    const normalized = normalizePaneName(name) ?? name;
    used.add(normalized.toLowerCase());
  }
  for (const candidate of PANE_NAMES) {
    if (!used.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
  // Fallback if room capacity exceeds 16
  let counter = 17;
  while (used.has(`pane ${counter}`)) counter++;
  return `Pane ${counter}`;
}

/**
 * Resolves an open pane from a list of panes by its paneName (case/accent-insensitive).
 */
export function resolvePaneByName<T extends { id?: string; paneName?: string | null; isClosed?: boolean }>(
  panes: T[],
  targetName: string
): T | null {
  const canonical = normalizePaneName(targetName);
  const targetLower = targetName.trim().toLowerCase();
  for (const pane of panes) {
    if (pane.isClosed) continue;
    if (!pane.paneName) continue;
    if (canonical && pane.paneName === canonical) return pane;
    if (pane.paneName.toLowerCase() === targetLower) return pane;
  }
  return null;
}
