export const MAX_ROOMS = 6;
/** Highest room limit Settings offers: one per room name. */
export const MAX_ROOM_LIMIT = 16;

/** Agent Proof and CLI Recovery rooms are test rooms: listed apart and never counted against the room limit. */
export const isTestRoom = (room: { kind?: string | null }) => room.kind === "AGENT_PROOF" || room.kind === "CLI_RECOVERY";

/** True when the owner's own (non-test) rooms already fill their room limit (Settings → Workspace → Rooms). */
export const roomLimitReached = (rooms: readonly { kind?: string | null }[], limit: number) =>
  rooms.filter((room) => !isTestRoom(room)).length >= limit;

export const ROOM_NAMES = [
  "Alex",
  "Bruno",
  "Cleo",
  "Dino",
  "Eva",
  "Felix",
  "Gina",
  "Hector",
  "Ivan",
  "Luna",
  "Milo",
  "Nova",
  "Otto",
  "Rio",
  "Sam",
  "Tara"
] as const;

export type RoomName = (typeof ROOM_NAMES)[number];

export const ROOM_NAME_ALIASES: Record<string, RoomName> = {
  alex: "Alex",
  "άλεξ": "Alex",
  "αλεξ": "Alex",
  bruno: "Bruno",
  "μπρούνο": "Bruno",
  "μπρουνο": "Bruno",
  cleo: "Cleo",
  "κλέο": "Cleo",
  "κλεο": "Cleo",
  "κλειώ": "Cleo",
  "κλειω": "Cleo",
  dino: "Dino",
  "ντίνο": "Dino",
  "ντινο": "Dino",
  eva: "Eva",
  "εύα": "Eva",
  "ευα": "Eva",
  "έβα": "Eva",
  "εβα": "Eva",
  felix: "Felix",
  "φέλιξ": "Felix",
  "φελιξ": "Felix",
  gina: "Gina",
  "τζίνα": "Gina",
  "τζινα": "Gina",
  hector: "Hector",
  "έκτορ": "Hector",
  "εκτορ": "Hector",
  "έκτορας": "Hector",
  "εκτορας": "Hector",
  ivan: "Ivan",
  "ιβάν": "Ivan",
  "ιβαν": "Ivan",
  luna: "Luna",
  "λούνα": "Luna",
  "λουνα": "Luna",
  milo: "Milo",
  "μίλο": "Milo",
  "μιλο": "Milo",
  nova: "Nova",
  "νόβα": "Nova",
  "νοβα": "Nova",
  otto: "Otto",
  "όττο": "Otto",
  "οττο": "Otto",
  rio: "Rio",
  "ρίο": "Rio",
  "ριο": "Rio",
  sam: "Sam",
  "σαμ": "Sam",
  tara: "Tara",
  "τάρα": "Tara",
  "ταρα": "Tara"
};

/**
 * Normalizes a room name string (case-insensitive, Greek transliterations, accent-insensitive)
 * to its canonical Latin RoomName if matched, or null if unrecognized.
 */
export function normalizeRoomName(input: string): RoomName | null {
  if (!input || typeof input !== "string") return null;
  const raw = input.trim().toLowerCase();
  if (ROOM_NAME_ALIASES[raw]) return ROOM_NAME_ALIASES[raw];
  const stripped = raw.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (ROOM_NAME_ALIASES[stripped]) return ROOM_NAME_ALIASES[stripped];
  for (const name of ROOM_NAMES) {
    if (name.toLowerCase() === raw || name.toLowerCase() === stripped) {
      return name;
    }
  }
  return null;
}

/**
 * Returns the first available RoomName from the fixed sequence that is not present in usedNames.
 * If all predefined ROOM_NAMES are used, falls back to `Room ${counter}`.
 */
export function pickNextAvailableRoomName(usedNames: Iterable<string | null | undefined>): string {
  const used = new Set<string>();
  for (const name of usedNames) {
    if (!name) continue;
    const normalized = normalizeRoomName(name) ?? name;
    used.add(normalized.toLowerCase());
  }
  for (const candidate of ROOM_NAMES) {
    if (!used.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
  let counter = ROOM_NAMES.length + 1;
  while (used.has(`room ${counter}`)) counter++;
  return `Room ${counter}`;
}

/**
 * Resolves a room from a list of rooms by its name (case/accent-insensitive).
 */
export function resolveRoomByName<T extends { id?: string; name?: string | null }>(
  rooms: T[],
  targetName: string
): T | null {
  const canonical = normalizeRoomName(targetName);
  const targetLower = targetName.trim().toLowerCase();
  for (const room of rooms) {
    if (!room.name) continue;
    if (canonical && room.name === canonical) return room;
    if (room.name.toLowerCase() === targetLower) return room;
  }
  return null;
}
