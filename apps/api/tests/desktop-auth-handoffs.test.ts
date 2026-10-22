import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createDesktopAuthHandoffStore,
  decodeDesktopAuthHandoffCookie,
  desktopAuthHandoffRedirect,
  DESKTOP_AUTH_HANDOFF_TTL_MS,
  encodeDesktopAuthHandoffCookie,
  isValidDesktopAuthHandoffId,
  parseDesktopAuthHandoffBinding
} from "../src/desktop-auth-handoffs.js";

const verifier = "v".repeat(43);
const challenge = createHash("sha256").update(verifier).digest("base64url");
const code = "c".repeat(43);
const entry = { token: "session-token", user: { id: "user:a", email: "a@space.local", role: "USER" }, code, codeChallenge: challenge };
const validId = "0123456789abcdef0123456789abcdef";

describe("desktop auth handoffs", () => {
  it("accepts only opaque ids of a bounded length and charset", () => {
    expect(isValidDesktopAuthHandoffId(validId)).toBe(true);
    expect(isValidDesktopAuthHandoffId("short")).toBe(false);
    expect(isValidDesktopAuthHandoffId("has spaces and ; separators")).toBe(false);
    expect(isValidDesktopAuthHandoffId("x".repeat(129))).toBe(false);
    expect(isValidDesktopAuthHandoffId(undefined)).toBe(false);
    expect(isValidDesktopAuthHandoffId(42)).toBe(false);
  });

  it("binds a handoff to a loopback port and a PKCE challenge, and refuses an unbound one", () => {
    expect(parseDesktopAuthHandoffBinding({ handoffId: validId, port: "49152", codeChallenge: challenge }))
      .toEqual({ handoffId: validId, port: 49152, codeChallenge: challenge });
    expect(parseDesktopAuthHandoffBinding({ handoffId: validId })).toBeNull();
    expect(parseDesktopAuthHandoffBinding({ handoffId: validId, port: "49152" })).toBeNull();
    expect(parseDesktopAuthHandoffBinding({ handoffId: validId, codeChallenge: challenge })).toBeNull();
    for (const port of ["80", "1023", "65536", "4.5", "49152x", ""]) {
      expect(parseDesktopAuthHandoffBinding({ handoffId: validId, port, codeChallenge: challenge }), port).toBeNull();
    }
    for (const bad of ["short", `${challenge}=`, challenge.replace(/.$/, "+")]) {
      expect(parseDesktopAuthHandoffBinding({ handoffId: validId, port: "49152", codeChallenge: bad }), bad).toBeNull();
    }
  });

  it("round-trips the binding through its cookie and rejects tampered cookies", () => {
    const binding = { handoffId: validId, port: 49152, codeChallenge: challenge };
    expect(decodeDesktopAuthHandoffCookie(encodeDesktopAuthHandoffCookie(binding))).toEqual(binding);
    expect(decodeDesktopAuthHandoffCookie(validId)).toBeNull();
    expect(decodeDesktopAuthHandoffCookie(`${validId}.80.${challenge}`)).toBeNull();
    expect(decodeDesktopAuthHandoffCookie(undefined)).toBeNull();
  });

  it("delivers the one-time code only to the desktop app's loopback listener", () => {
    const url = new URL(desktopAuthHandoffRedirect({ handoffId: validId, port: 49152, codeChallenge: challenge }, code));
    expect(url.origin).toBe("http://127.0.0.1:49152");
    expect(url.pathname).toBe("/space-desktop-auth");
    expect(url.searchParams.get("handoff")).toBe(validId);
    expect(url.searchParams.get("code")).toBe(code);
  });

  it("hands the session out once, only for the matching code and code verifier", () => {
    const store = createDesktopAuthHandoffStore({ now: () => 1_000 });
    store.store(validId, entry);
    expect(store.redeem(validId, code, verifier)?.token).toBe("session-token");
    expect(store.redeem(validId, code, verifier)).toBeNull();
  });

  it("burns the handoff on a wrong code or a wrong verifier", () => {
    const store = createDesktopAuthHandoffStore({ now: () => 1_000 });
    store.store(validId, entry);
    expect(store.redeem(validId, "x".repeat(43), verifier)).toBeNull();
    expect(store.redeem(validId, code, verifier)).toBeNull();
    store.store(validId, entry);
    expect(store.redeem(validId, code, "w".repeat(43))).toBeNull();
    expect(store.redeem(validId, code, verifier)).toBeNull();
  });

  it("expires unclaimed sign-ins after the handoff window", () => {
    let clock = 1_000;
    const store = createDesktopAuthHandoffStore({ now: () => clock });
    store.store(validId, entry);
    clock += DESKTOP_AUTH_HANDOFF_TTL_MS + 1;
    expect(store.redeem(validId, code, verifier)).toBeNull();
    expect(store.size).toBe(0);
  });

  it("stays bounded by evicting the oldest entry", () => {
    let clock = 1_000;
    const store = createDesktopAuthHandoffStore({ now: () => clock++, maxEntries: 2 });
    store.store(`${validId}1`, entry);
    store.store(`${validId}2`, entry);
    store.store(`${validId}3`, entry);
    expect(store.size).toBe(2);
    expect(store.redeem(`${validId}1`, code, verifier)).toBeNull();
    expect(store.redeem(`${validId}3`, code, verifier)).not.toBeNull();
  });

  it("rejects malformed ids at storage time", () => {
    const store = createDesktopAuthHandoffStore();
    expect(() => store.store("bad id", entry)).toThrow();
  });
});
