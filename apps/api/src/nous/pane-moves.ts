/**
 * The operator's pane moves and closes reach Nous as ONE inbox line per minute (R10-2, 28/10: at 08:18 UTC the operator moved five
 * Bruno panes into Alex, they took new names, Nous's world stayed stale and a helper asked for "Bruno/Dana" was given Alex/Dana).
 */
export interface OperatorPaneChange {
  owner: string;
  paneId: string;
  fromRoomId: string;
  fromName: string;
  /** Absent: the pane was closed. */
  toRoomId?: string;
  toName?: string;
}

export function createOperatorPaneChanges(deps: {
  notice(owner: string, key: string, line: string): Promise<unknown> | unknown;
  roomName(roomId: string): Promise<string>;
  delayMs?: number;
}) {
  const pending = new Map<string, OperatorPaneChange[]>();
  async function flush(owner: string) {
    const changes = pending.get(owner) ?? [];
    pending.delete(owner);
    if (!changes.length) return;
    const names = new Map<string, Promise<string>>();
    const room = (id: string) => names.get(id) ?? names.set(id, deps.roomName(id).catch(() => id)).get(id)!;
    const parts = await Promise.all(changes.map(async (change) => change.toRoomId
      ? `${change.paneId} ${await room(change.fromRoomId)}/${change.fromName} → ${await room(change.toRoomId)}/${change.toName ?? change.fromName}`
      : `${change.paneId} ${await room(change.fromRoomId)}/${change.fromName} closed`));
    await deps.notice(owner, `operator-panes:${changes[0]!.paneId}:${Date.now()}`,
      `The operator moved or closed panes: ${parts.join("; ")}. Name them by id from now on: an old name may now belong to another pane.`);
  }
  return {
    note(change: OperatorPaneChange) {
      const list = pending.get(change.owner);
      if (list) { list.push(change); return; }
      pending.set(change.owner, [change]);
      setTimeout(() => { void flush(change.owner).catch(() => undefined); }, deps.delayMs ?? 60_000).unref?.();
    }
  };
}
