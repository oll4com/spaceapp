/**
 * Pair a phone across the Google step-up (7/11: after Google the page came back at / and Pair a phone had to be found and pressed again).
 * Mobile app marks the pairing before it leaves for Google; a confirmed step-up (?mobileStepUp=ok) opens Settings > Account, where Mobile
 * app finds the mark and pairs at once. The mark lives in this tab only and for the step-up's 5 minutes.
 */
const KEY = "space:mobile-pair-after-step-up";
const TTL_MS = 5 * 60_000;

interface Mark { at: number; confirmed?: number }

function read(): Mark | null {
  try {
    const mark = JSON.parse(window.sessionStorage.getItem(KEY) ?? "null") as Mark | null;
    return mark && typeof mark.at === "number" && Date.now() - mark.at < TTL_MS * 2 ? mark : null;
  } catch { return null; }
}
function write(mark: Mark | null) {
  try {
    if (mark) window.sessionStorage.setItem(KEY, JSON.stringify(mark));
    else window.sessionStorage.removeItem(KEY);
  } catch { /* storage off: the person presses Pair a phone */ }
}

/** Before leaving for Google's step-up from Mobile app. */
export function markPairAfterStepUp(): void { write({ at: Date.now() }); }

/** The step-up came back: confirmed keeps the mark for Mobile app, a refusal drops it. Answers whether a pairing waits. */
export function settlePairAfterStepUp(confirmed: boolean): boolean {
  const mark = read();
  if (!mark || !confirmed) { write(null); return false; }
  write({ ...mark, confirmed: Date.now() });
  return true;
}

/** Mobile app mounted: true once when a confirmed step-up still covers the pairing. */
export function takePairAfterStepUp(): boolean {
  const mark = read();
  if (!mark?.confirmed) return false;
  write(null);
  return Date.now() - mark.confirmed < TTL_MS;
}
