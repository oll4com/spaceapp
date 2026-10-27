import { VAULT_ITEM_BATCH_MAX, canonicalVaultOrigin, type VaultItemRecord, type VaultItemRecordInput } from "@space/contracts";
import { VAULT_AGENT_POLICY, decryptVaultItem, encryptVaultItem, type UnlockedVault } from "./vault-client.js";

// Import of a Google Chrome passwords export (operator request 2026-10-21, plan clipboard:SMcT__jALB6R). The CSV is read and
// parsed only here, in the operator's unlocked tab; every login is encrypted with the item crypto before it is saved, tagged
// with the Google account the operator says the export came from. Nothing in plain text leaves the tab or reaches any storage.

export type ChromeSkipReason = "ANDROID_APP" | "NO_SITE" | "NO_PASSWORD";
export interface ChromeLogin { label: string; origin: string; risky: boolean; username: string; password: string }
export interface ChromeExport {
  logins: ChromeLogin[];
  skipped: Record<ChromeSkipReason, number>;
  /** Rows replaced by a later row for the same site and username (the last one wins). */
  duplicates: number;
  /** Rows with a note: Vault items have no note field, so notes are not imported. */
  notes: number;
}
export class ChromeImportError extends Error {}

/** RFC 4180: quoted fields with "" escapes and line breaks inside, CRLF or LF rows, a leading BOM. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;
    if (quoted) {
      if (char !== "\"") field += char;
      else if (input[index + 1] === "\"") { field += "\""; index += 1; }
      else quoted = false;
    } else if (char === "\"") quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && input[index + 1] === "\n") index += 1;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += char;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((cells) => cells.some((cell) => cell !== ""));
}

const loginKey = (origin: string, username: string) => `${origin}\n${username.trim().toLowerCase()}`;

/** Chrome's Password Manager export: name,url,username,password and, in newer Chrome, note. */
export function parseChromePasswords(text: string): ChromeExport {
  const [header, ...rows] = parseCsv(text);
  const columns = (header ?? []).map((cell) => cell.trim().toLowerCase());
  const at = (name: string) => columns.indexOf(name);
  if (at("url") < 0 || at("username") < 0 || at("password") < 0) throw new ChromeImportError("This is not a Chrome passwords export (it needs the columns url, username and password).");
  const skipped: Record<ChromeSkipReason, number> = { ANDROID_APP: 0, NO_SITE: 0, NO_PASSWORD: 0 };
  const byKey = new Map<string, ChromeLogin>();
  let duplicates = 0;
  let notes = 0;
  for (const cells of rows) {
    const cell = (name: string) => at(name) < 0 ? "" : cells[at(name)] ?? "";
    const url = cell("url").trim();
    if (url.toLowerCase().startsWith("android://")) { skipped.ANDROID_APP += 1; continue; }
    const site = url ? canonicalVaultOrigin(url) : null;
    if (!site) { skipped.NO_SITE += 1; continue; }
    if (!cell("password")) { skipped.NO_PASSWORD += 1; continue; }
    if (cell("note").trim()) notes += 1;
    const username = cell("username").trim();
    const label = (cell("name").trim() || new URL(site.origin).hostname).slice(0, 80).trim();
    const key = loginKey(site.origin, username);
    if (byKey.delete(key)) duplicates += 1;
    byKey.set(key, { label, origin: site.origin, risky: site.warnings.length > 0, username, password: cell("password") });
  }
  return { logins: [...byKey.values()], skipped, duplicates, notes };
}

export interface ChromeImportPlan {
  account: string | null;
  add: ChromeLogin[];
  update: Array<{ login: ChromeLogin; previous: VaultItemRecord }>;
  unchanged: number;
}

/**
 * Compares the export with the account's logins: the key is account + site + username (case-insensitive). The same password
 * leaves a login unchanged; another one updates it.
 */
export async function planChromeImport(client: { vaultItemRecords(): Promise<{ items: VaultItemRecord[] }> }, unlocked: UnlockedVault, parsed: ChromeExport, account: string | null): Promise<ChromeImportPlan> {
  const sites = new Set(parsed.logins.map((login) => login.origin));
  const existing = new Map<string, { record: VaultItemRecord; password: string | undefined }>();
  // Every item in one request; only the chosen account's logins on the file's sites are decrypted.
  for (const record of (await client.vaultItemRecords()).items) {
    const { metadata } = record;
    if (metadata.status !== "ACTIVE" || (metadata.googleAccountId ?? null) !== account || !metadata.origins.some((origin) => sites.has(origin))) continue;
    const secrets = await decryptVaultItem(unlocked, record);
    for (const origin of metadata.origins) {
      const key = loginKey(origin, secrets.USERNAME ?? "");
      if (!existing.has(key)) existing.set(key, { record, password: secrets.PASSWORD });
    }
  }
  const plan: ChromeImportPlan = { account, add: [], update: [], unchanged: 0 };
  for (const login of parsed.logins) {
    const match = existing.get(loginKey(login.origin, login.username));
    if (!match) plan.add.push(login);
    else if (match.password === login.password) plan.unchanged += 1;
    else plan.update.push({ login, previous: match.record });
  }
  return plan;
}

/**
 * Saves the plan in batches: each batch is encrypted here at once and stored in one request and one transaction (an import of
 * hundreds of logins took minutes one request each). A changed password keeps the old one in the item's silent history.
 */
export async function runChromeImport(client: { vaultSaveItems(items: VaultItemRecordInput[]): Promise<{ saved: number }> }, unlocked: UnlockedVault, plan: ChromeImportPlan,
  onProgress: (done: number, total: number) => void = () => undefined): Promise<number> {
  const work: Array<() => Promise<VaultItemRecordInput>> = [
    ...plan.update.map(({ login, previous }) => async () => {
      const secrets = await decryptVaultItem(unlocked, previous);
      const { id: _id, fieldRoles: _roles, loginKey: _key, ...metadata } = previous.metadata;
      return encryptVaultItem(unlocked, { ...metadata, status: "ACTIVE", secrets: { ...secrets, PASSWORD: login.password } }, previous);
    }),
    // Sites the operator's own Chrome kept (http, an IP address, punycode) are accepted by importing them.
    ...plan.add.map((login) => () => encryptVaultItem(unlocked, { label: login.label, origins: [login.origin], status: "ACTIVE", googleAccountId: plan.account,
      secrets: { USERNAME: login.username || undefined, PASSWORD: login.password }, policy: { ...VAULT_AGENT_POLICY, acceptedOriginRisks: login.risky ? [login.origin] : [] } }))
  ];
  let done = 0;
  for (let start = 0; start < work.length; start += VAULT_ITEM_BATCH_MAX) {
    const batch = await Promise.all(work.slice(start, start + VAULT_ITEM_BATCH_MAX).map((encrypt) => encrypt()));
    done += (await client.vaultSaveItems(batch)).saved;
    onProgress(start + batch.length, work.length);
  }
  return done;
}
