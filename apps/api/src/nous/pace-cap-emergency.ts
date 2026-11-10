import type { NousRepository } from "@space/db";

/**
 * Space Gateway pace cap emergency (operator 6/11 11:31 BKK, nous_msg:1d470cc93b194f03ae7f7706; plan clipboard:DotwYXVD2N3n): Nous opens
 * the cap for some panes, or for all background work, for up to a week (operator 7/11 19:24 BKK, nous_msg:1819f500: whatever he asks runs
 * at once; nothing it covers is held with PACE_CAP). One note per owner; the Space API sends it to the gateway with the panes of open operator requests (wiring.ts
 * pushPriorityPanes). It never touches the weekly limit (100%) or the Claude API key, which Claude Code never reaches.
 */
export const PACE_CAP_EMERGENCY_NOTE = "pace-cap-emergency";
export const PACE_CAP_EMERGENCY_DEFAULT_HOURS = 12;
export const PACE_CAP_EMERGENCY_MAX_HOURS = 168;

export interface PaceCapEmergency {
  /** Every background request (any x-space-project, untagged included), not only `panes`. */
  all: boolean;
  panes: string[];
  reason: string;
  setAt: string;
  until: string;
}

export function parsePaceCapEmergency(text: string | null | undefined): PaceCapEmergency | null {
  if (!text) return null;
  try {
    const entry = JSON.parse(text) as Partial<PaceCapEmergency>;
    return typeof entry.until === "string" && typeof entry.reason === "string" && Array.isArray(entry.panes) && Number.isFinite(Date.parse(entry.until))
      ? { all: entry.all === true, panes: entry.panes.filter((pane): pane is string => typeof pane === "string"), reason: entry.reason, setAt: String(entry.setAt ?? ""), until: entry.until }
      : null;
  } catch {
    return null;
  }
}

/** The emergency in force at `now`, else null (an expired one counts as off). */
export const activePaceCapEmergency = (entry: PaceCapEmergency | null, now: number) => (entry && Date.parse(entry.until) > now ? entry : null);

/**
 * A turn the gateway held is typed again at once when an emergency in force covers its pane and was set after the hold. Under the emergency the
 * gateway holds a turn only when no account with week room is left (plan clipboard:DotwYXVD2N3n), so typing it again at once would loop (every
 * 30 s): it waits for its resumesAt. An undated (older) emergency releases as before.
 */
export const emergencyReleases = (entries: readonly PaceCapEmergency[], paneId: string, heldAt: string) =>
  entries.some((entry) => (entry.all || entry.panes.includes(paneId)) && !(Date.parse(heldAt) >= Date.parse(entry.setAt)));

/** "PACE CAP EMERGENCY ON until 23:30 Asia/Bangkok — find a server — panes: all background work" (the Tokens line and space_token_state). */
export function paceCapEmergencyText(entry: PaceCapEmergency, zone: string): string {
  const until = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(entry.until));
  return `PACE CAP EMERGENCY ON until ${until} ${zone} — ${entry.reason} — panes: ${entry.all ? "all background work" : entry.panes.join(", ")}`;
}

export function createPaceCapEmergency(deps: {
  notes: Pick<NousRepository, "listNotes" | "setNote">;
  /** Sends the gateway the exemption list at once (else it goes with the next minute's send). */
  push(): Promise<void>;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const read = async (owner: string) => parsePaceCapEmergency((await deps.notes.listNotes(owner)).find((note) => note.key === PACE_CAP_EMERGENCY_NOTE)?.text);
  return {
    /** The owner's emergency in force now, or null. */
    async active(owner: string): Promise<PaceCapEmergency | null> {
      return activePaceCapEmergency(await read(owner), now());
    },
    async on(owner: string, input: { panes: string[] | "all"; reason: string; hours?: number }): Promise<PaceCapEmergency> {
      const hours = Math.min(PACE_CAP_EMERGENCY_MAX_HOURS, Math.max(1, input.hours ?? PACE_CAP_EMERGENCY_DEFAULT_HOURS));
      const at = now();
      const entry: PaceCapEmergency = { all: input.panes === "all", panes: input.panes === "all" ? [] : [...new Set(input.panes)], reason: input.reason.trim(),
        setAt: new Date(at).toISOString(), until: new Date(at + hours * 3_600_000).toISOString() };
      await deps.notes.setNote(owner, PACE_CAP_EMERGENCY_NOTE, JSON.stringify(entry));
      await deps.push();
      return entry;
    },
    async off(owner: string): Promise<PaceCapEmergency | null> {
      const was = activePaceCapEmergency(await read(owner), now());
      await deps.notes.setNote(owner, PACE_CAP_EMERGENCY_NOTE, null);
      await deps.push();
      return was;
    }
  };
}
