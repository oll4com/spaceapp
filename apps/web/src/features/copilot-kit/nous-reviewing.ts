import { useEffect, useState } from "react";
import { api } from "../../api.js";

/**
 * Operator 2/11 15:08 BKK («να μην φτανει σε εμενα το aprove … αλλιως φυσικα να ζηταει απο εμενα aprove»): while Nous is on with "May send to
 * third parties", the copilots' reviews and Mail campaigns are Nous's to decide. A pane lists them as "Nous reviewing", read only, with no
 * badge, needs-you count or Approve. The server's one predicate decides (`GET /api/nous/approvals`); one read serves every open pane.
 */
const FRESH_MS = 30_000;
let cache = { value: false, at: 0 };
let inflight: Promise<boolean> | null = null;

function read(): Promise<boolean> {
  if (Date.now() - cache.at < FRESH_MS) return Promise.resolve(cache.value);
  inflight ??= Promise.resolve().then(() => api.nousApprovals()).then((answer) => answer.nousReviewing === true, () => cache.value)
    .then((value) => { cache = { value, at: Date.now() }; inflight = null; return value; });
  return inflight;
}

/** Tests start each case from a fresh read. */
export function resetNousReviewing(): void { cache = { value: false, at: 0 }; inflight = null; }

export function useNousReviewing(): boolean {
  const [value, setValue] = useState(cache.value);
  useEffect(() => {
    let live = true;
    const check = () => void read().then((next) => { if (live) setValue(next); });
    check();
    const timer = window.setInterval(check, FRESH_MS);
    return () => { live = false; window.clearInterval(timer); };
  }, []);
  return value;
}
