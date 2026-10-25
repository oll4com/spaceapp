import type { CliAccountIdentity, CliAccountProfile } from "@space/contracts";
import type { CliAccountRuntimeId } from "./cli-account-availability.js";
import { normalizeAccountEmail } from "./cli-account-identities.js";

export const CLI_ACCOUNT_RUNTIME_IDS: readonly CliAccountRuntimeId[] = ["cli:gemini", "cli:claude", "cli:copilot", "cli:cursor", "cli:kimi"];

export const CLI_ACCOUNT_RUNTIME_LABELS: Record<CliAccountRuntimeId, string> = {
  "cli:gemini": "Gemini",
  "cli:claude": "Claude Code",
  "cli:copilot": "GitHub Copilot",
  "cli:cursor": "Cursor",
  "cli:kimi": "Kimi Code",
};

export interface CliAccountSuggestion {
  key: string;
  displayName: string;
  email: string | null;
  // Profiles in other CLIs that already use this account.
  sources: CliAccountIdentity[];
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

export function sameAccountName(left: string, right: string): boolean {
  return normalizeName(left) === normalizeName(right);
}

// Profiles in other CLIs signed in with the same email: the same person, linked automatically.
export function linkedProfiles(identities: CliAccountIdentity[], runtimeId: CliAccountRuntimeId, profileId: string): CliAccountIdentity[] {
  const self = identities.find((identity) => identity.runtimeId === runtimeId && identity.profileId === profileId);
  const email = normalizeAccountEmail(self?.email);
  if (!email) return [];
  return identities.filter((identity) => identity.runtimeId !== runtimeId && normalizeAccountEmail(identity.email) === email);
}

// Another profile of the same CLI signed in with the same email is a duplicate sign-in.
export function duplicateProfiles(identities: CliAccountIdentity[], runtimeId: CliAccountRuntimeId, profileId: string): CliAccountIdentity[] {
  const self = identities.find((identity) => identity.runtimeId === runtimeId && identity.profileId === profileId);
  const email = normalizeAccountEmail(self?.email);
  if (!email) return [];
  return identities.filter((identity) =>
    identity.runtimeId === runtimeId && identity.profileId !== profileId && normalizeAccountEmail(identity.email) === email);
}

// Accounts signed in with an email in other CLIs but missing here, so they can be added with
// one click instead of typing them again. An account counts as present when this CLI has a
// profile with the same email or the same name. Main profiles exist in every CLI already.
export function accountSuggestions(
  identities: CliAccountIdentity[],
  runtimeId: CliAccountRuntimeId,
  profiles: CliAccountProfile[],
): CliAccountSuggestion[] {
  const here = identities.filter((identity) => identity.runtimeId === runtimeId);
  const emailsHere = new Set(here.map((identity) => normalizeAccountEmail(identity.email)).filter((email): email is string => Boolean(email)));
  const namesHere = new Set([...profiles.map((profile) => profile.displayName), ...here.map((identity) => identity.displayName)].map(normalizeName));
  const groups = new Map<string, CliAccountSuggestion>();
  for (const identity of identities) {
    if (identity.runtimeId === runtimeId || identity.profileId === "main") continue;
    const email = normalizeAccountEmail(identity.email);
    const key = email ? `email:${email}` : `name:${normalizeName(identity.displayName)}`;
    const group = groups.get(key);
    if (group) {
      group.sources.push(identity);
    } else {
      groups.set(key, { key, displayName: identity.displayName, email: identity.email ?? null, sources: [identity] });
    }
  }
  // A profile known only by name joins the email account of the same name, when there is one.
  for (const [key, group] of [...groups]) {
    if (!key.startsWith("name:")) continue;
    const match = [...groups.values()].find((candidate) => candidate.email && candidate.sources.some((source) => sameAccountName(source.displayName, group.displayName)));
    if (!match) continue;
    match.sources.push(...group.sources);
    groups.delete(key);
  }
  return [...groups.values()]
    .filter((group) => {
      const email = normalizeAccountEmail(group.email);
      if (!email || emailsHere.has(email)) return false;
      return !group.sources.some((source) => namesHere.has(normalizeName(source.displayName)));
    })
    .sort((left, right) => right.sources.length - left.sources.length
      || left.displayName.localeCompare(right.displayName));
}

export function slugifyAccountProfileId(displayName: string): string {
  return displayName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

export function uniqueAccountProfileId(displayName: string, existingIds: Iterable<string>): string {
  const taken = new Set(existingIds);
  const base = slugifyAccountProfileId(displayName) || "account";
  let profileId = base;
  for (let suffix = 2; taken.has(profileId); suffix += 1) {
    profileId = `${base.slice(0, Math.max(1, 63 - String(suffix).length))}-${suffix}`;
  }
  return profileId;
}
