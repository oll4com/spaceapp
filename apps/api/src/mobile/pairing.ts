import { randomBytes } from "node:crypto";
import type { MobileScope } from "@space/contracts";

// Pairing offers (plan clipboard:kTV3y2lwO-99 phase 1b, ADR-013 §3, design §2.1): a 128-bit single-use code that lives 120 s in this
// process's memory only (the server derives the psk from it, so a stored hash would be as sensitive). 3 live offers per owner; 5 failed
// handshakes in 15 minutes lock new offers; the handshake claims an offer synchronously, so two parallel ones cannot both use it.

export interface MobilePairingOffer {
  offerId: Uint8Array;
  owner: string;
  code: Uint8Array;
  scopes: MobileScope[];
  /** The QR's instance label, which Paired repeats. */
  label: string;
  /** A RELAY offer's 256-bit rendezvous id (design §2.1): the relay client listens on it, and the paired phone keeps it; null: direct only. */
  rid: Uint8Array | null;
  expiresAt: number;
  /** Demo mode's standing offer (SPACE_MOBILE_DEMO): public, accepted by every phone until its day ends. */
  standing?: boolean;
}

export const MOBILE_OFFER_TTL_MS = 120_000;
export const MOBILE_OFFERS_LIVE_MAX = 3;
export const MOBILE_PAIRING_FAILURES_MAX = 5;
const FAILURE_WINDOW_MS = 15 * 60_000;
const DAY_MS = 24 * 3600_000;
const key = (offerId: Uint8Array) => Buffer.from(offerId).toString("base64url");

export function createMobileOffers(now: () => number = Date.now) {
  const offers = new Map<string, MobilePairingOffer>();
  const failures = new Map<string, number[]>();
  const recentFailures = (owner: string) => (failures.get(owner) ?? []).filter((at) => at > now() - FAILURE_WINDOW_MS);
  const sweep = () => { for (const [id, offer] of offers) if (offer.expiresAt <= now()) offers.delete(id); };
  return {
    /** A new offer, or why not: too many live offers, or locked after failed attempts. */
    create(owner: string, scopes: MobileScope[], label = "SpaceApp", relay = false): MobilePairingOffer | { refused: "LIVE_OFFERS" | "LOCKED" } {
      sweep();
      if (recentFailures(owner).length >= MOBILE_PAIRING_FAILURES_MAX) return { refused: "LOCKED" };
      if ([...offers.values()].filter((offer) => offer.owner === owner && !offer.standing).length >= MOBILE_OFFERS_LIVE_MAX) return { refused: "LIVE_OFFERS" };
      const offer = { offerId: randomBytes(8), owner, code: randomBytes(16), scopes, label, rid: relay ? randomBytes(32) : null, expiresAt: now() + MOBILE_OFFER_TTL_MS };
      offers.set(key(offer.offerId), offer);
      return offer;
    },
    /**
     * Demo mode's offer for today (UTC), made at the day's first request; it stays accepted one offer lifetime past midnight, so a phone that
     * fetched it at 23:59 still pairs. Direct only, and in this process's memory like every offer (a restart makes a new one).
     */
    demo(owner: string, label: string): MobilePairingOffer {
      sweep();
      const expiresAt = (Math.floor(now() / DAY_MS) + 1) * DAY_MS + MOBILE_OFFER_TTL_MS;
      const today = [...offers.values()].find((offer) => offer.standing && offer.owner === owner && offer.expiresAt === expiresAt);
      if (today) return today;
      // Read only (operator 13/11, plan step 18): a store reviewer sees Northwind Labs but starts no paid model turn and answers nothing.
      const offer: MobilePairingOffer = { offerId: randomBytes(8), owner, code: randomBytes(16), scopes: ["read"], label, rid: null, expiresAt, standing: true };
      offers.set(key(offer.offerId), offer);
      return offer;
    },
    /** Every live offer (the relay client's rids). */
    live(): MobilePairingOffer[] { sweep(); return [...offers.values()]; },
    /** The live offer a pairing socket names, left in place: message 3 claims it. */
    peek(offerId: Uint8Array): MobilePairingOffer | null {
      const offer = offers.get(key(offerId));
      return offer && offer.expiresAt > now() ? offer : null;
    },
    /** The handshake's claim: synchronous, single use (a standing demo offer stays); an expired or unknown offer is null (security review P2-2). */
    claim(offerId: Uint8Array): MobilePairingOffer | null {
      const offer = offers.get(key(offerId)) ?? null;
      if (!offer?.standing) offers.delete(key(offerId));
      return offer && offer.expiresAt > now() ? offer : null;
    },
    cancel(owner: string, offerId: string): boolean {
      const offer = offers.get(offerId);
      if (!offer || offer.owner !== owner) return false;
      return offers.delete(offerId);
    },
    /** A handshake that failed after its claim (a wrong code). */
    failed(owner: string) { failures.set(owner, [...recentFailures(owner), now()]); }
  };
}
export type MobileOffers = ReturnType<typeof createMobileOffers>;
