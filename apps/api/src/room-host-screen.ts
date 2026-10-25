import type { CliHostIdentity } from "@space/cli-host";
import type { CliHostGateway } from "./cli-terminal.js";
import { projectRoomTerminalScreen } from "./room-terminal-screen.js";

/** Replay tail used when the bounded host ring has trimmed the session start. */
const REPLAY_TAIL_EVENTS = 200;

/** Read the existing host replay; never spawn, resize, type or replace its main attachment. */
export async function readRoomHostScreen(host: Pick<CliHostGateway, "attach" | "detach" | "inspect">,
  identity: CliHostIdentity, cols: number, rows: number, unwrap = false, expectedGenerationId?: string): Promise<string> {
  return (await readRoomHostScreenSnapshot(host, identity, cols, rows, unwrap, expectedGenerationId)).text;
}

export async function readRoomHostScreenSnapshot(host: Pick<CliHostGateway, "attach" | "detach" | "inspect">,
  identity: CliHostIdentity, cols: number, rows: number, unwrap = false, expectedGenerationId?: string) {
  try {
    return await snapshotFromReplay(host, identity, cols, rows, unwrap, expectedGenerationId, -1);
  } catch (error) {
    // Long-lived sessions trim the ring start, so a full replay is unavailable.
    // Fall back to the recent tail: a repainted TUI frame still scrapes.
    if (!isReplayGapError(error)) throw error;
    const summary = await host.inspect(identity).catch(() => null);
    if (!summary || summary.status !== "RUNNING") throw error;
    return await snapshotFromReplay(host, identity, cols, rows, unwrap,
      expectedGenerationId, Math.max(0, summary.nextOutputSequence - 1 - REPLAY_TAIL_EVENTS));
  }
}

function isReplayGapError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: unknown }).code === "CLI_HOST_REPLAY_GAP";
}

async function snapshotFromReplay(host: Pick<CliHostGateway, "attach" | "detach">,
  identity: CliHostIdentity, cols: number, rows: number, unwrap: boolean,
  expectedGenerationId: string | undefined, afterSequence: number) {
  const observer = await host.attach({ identity, afterSequence });
  try {
    if (expectedGenerationId && observer.session.generationId !== expectedGenerationId) throw new Error("Room terminal geometry belongs to a different host generation.");
    return { text: await projectRoomTerminalScreen(observer.replay.map(event => event.data), cols, rows, unwrap),
      revision: observer.session.nextOutputSequence };
  } finally { await host.detach(identity, observer.attachmentId); }
}
