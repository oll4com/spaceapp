import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { RoomShareListResponse, RoomSharePermission } from "@space/contracts";
import { api } from "../../api.js";
import { DockButton } from "../dock-kit/DockKit.js";
import { Share2, Trash2 } from "../ui-theme/app-icons.js";

type Share = RoomShareListResponse["shares"][number];

/** The room owner's share list (multi-user); renders nothing when the API does not answer (flag off, not the owner). */
export function RoomSharing({ roomId }: { roomId: string }) {
  const [shares, setShares] = useState<Share[] | null>(null);
  const [email, setEmail] = useState("");
  const [permission, setPermission] = useState<RoomSharePermission>("VIEW");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setShares((await api.roomShares(roomId)).shares);
    } catch {
      setShares(null);
    }
  }, [roomId]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The share could not be changed.");
    } finally {
      setBusy(false);
    }
  };

  if (!shares) return null;
  return (
    <section className="room-dock-sharing" aria-label="Room sharing">
      <form
        className="room-dock-sharing-form"
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          void run(async () => {
            await api.addRoomShare(roomId, email.trim(), permission);
            setEmail("");
          });
        }}
      >
        <input type="email" required placeholder="Team member email" aria-label="Share with email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <select aria-label="Share permission" value={permission} onChange={(e) => setPermission(e.target.value as RoomSharePermission)}>
          <option value="VIEW">View</option>
          <option value="COLLABORATE">Collaborate</option>
        </select>
        <DockButton type="submit" icon={Share2} busy={busy} disabled={busy}>Share</DockButton>
      </form>
      {error ? <p className="room-dock-sharing-error" role="alert">{error}</p> : null}
      {shares.length > 0 ? (
        <ul className="room-dock-sharing-list">
          {shares.map((share) => (
            <li key={share.userId}>
              <span>{share.email}</span>
              <select
                aria-label={`Permission for ${share.email}`}
                value={share.permission}
                disabled={busy}
                onChange={(e) => void run(() => api.setRoomShare(roomId, share.userId, e.target.value as RoomSharePermission))}
              >
                <option value="VIEW">View</option>
                <option value="COLLABORATE">Collaborate</option>
              </select>
              <DockButton tone="ghost" icon={Trash2} disabled={busy} aria-label={`Stop sharing with ${share.email}`}
                onClick={() => void run(() => api.removeRoomShare(roomId, share.userId))}>
                Remove
              </DockButton>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
