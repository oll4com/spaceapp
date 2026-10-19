import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import type { Pane } from "@space/contracts";
import type { SpaceStore } from "@space/runtime";
import type { SpaceApiConfig } from "./config.js";
import { createPublicCredentialHost } from "./cli-auth-transfer.js";
import { createCliRuntimeRegistryCache } from "./cli-runtimes.js";

// Multi-user step 4 (plan clipboard:evAaFYqrgDfd, operator-approved 2026-10-17): the launcher runs one CLI container
// per user and writes {"<userId>": "<pane host socket>"} to SPACE_CLI_HOST_SOCKETS_FILE. A pane runs in its owner's
// container; a user missing from the map (the operator, stable, dev) keeps the default host.
const userHostSocketsSchema = z.record(
  z.string().regex(/^user:[A-Za-z0-9_-]{1,80}$/),
  z.string().min(1).max(512).refine(isAbsolute, "The socket path must be absolute.")
);

/**
 * The per-user pane host sockets; null without the file (single-user: nothing changes). With the file, even an empty
 * one, a USER without an own host gets no CLI. An unreadable or invalid file stops the API (fail closed).
 */
export function readCliUserHostSockets(path: string | null): Record<string, string> | null {
  if (!path) return null;
  return userHostSocketsSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

/**
 * One runtime registry per user with an own CLI container: its sign-in states come from that container's credential
 * agent (credentials.sock next to the user's pane host socket), so a user sees their own keys and logins.
 */
export function createUserRuntimeRegistries(config: SpaceApiConfig, sockets: Readonly<Record<string, string>> | null) {
  const registries = new Map<string, ReturnType<typeof createCliRuntimeRegistryCache>>();
  return (userId: string): ReturnType<typeof createCliRuntimeRegistryCache> | null => {
    const socket = sockets?.[userId];
    if (!socket) return null;
    let registry = registries.get(userId);
    if (!registry) {
      const credentials = createPublicCredentialHost({ ...config, cliHostSocketPath: socket });
      registry = createCliRuntimeRegistryCache(config, { probeCredentialStatus: credentials?.status });
      registries.set(userId, registry);
    }
    return registry;
  };
}

/**
 * The core's side of per-user CLI containers: the host map, who a pane's CLI belongs to (who opened it, else the
 * room's owner), which users may use the default host (ADMIN, OPERATOR), and the per-user runtime registries.
 */
export function createCliUserHosting(options: {
  store: Pick<SpaceStore, "getPaneOwner" | "getRoom" | "getControlActor">;
  config: SpaceApiConfig;
  paneById: (paneId: string) => Promise<Pane>;
}) {
  const { store, config, paneById } = options;
  const sockets = readCliUserHostSockets(config.cliHostSocketsFile);
  const paneHostUser = async (paneId: string): Promise<string | null> =>
    (await store.getPaneOwner?.(paneId)) ?? (await store.getRoom((await paneById(paneId)).roomId)).ownerUserId ?? null;
  const defaultHostAllowed = async (userId: string) => ["ADMIN", "OPERATOR"].includes((await store.getControlActor(userId))?.role ?? "");
  // Core model runs (task summaries, Room Agent chat) use the owner's accounts, so never for a USER (MU-002).
  const ownerModelsAllowed = async (userId: string | null) => !userId || await defaultHostAllowed(userId);
  return {
    terminal: { userHostSockets: sockets, paneHostUser, defaultHostAllowed },
    ownerModels: {
      pane: async (paneId: string) => ownerModelsAllowed(await paneHostUser(paneId)),
      room: async (roomId: string) => ownerModelsAllowed((await store.getRoom(roomId)).ownerUserId ?? null)
    },
    /**
     * MU-009: a CLI control token acts as the room's grant actor (the ADMIN who allowed CLI control), so only in a pane
     * whose CLI is theirs or the operator side's; never a pane a USER opened (a member in a shared room) or a USER's room.
     */
    controlActorAllowed: async (paneId: string, actorId: string) => {
      const opener = await paneHostUser(paneId);
      return !opener || opener === actorId || await defaultHostAllowed(opener);
    },
    onUserCliHost: async (paneId: string) => Boolean(sockets?.[(await paneHostUser(paneId)) ?? ""]),
    userRegistry: createUserRuntimeRegistries(config, sockets)
  };
}
