import { describe, expect, it } from "vitest";
import {
  persistentOperatorSessionTtlSeconds,
  signPersistentOperatorSessionToken,
  signSessionTokenWithTtl
} from "../src/session-auth.js";

function decodeSessionToken(token: string): { exp: number } {
  const [body] = token.split(".");
  return JSON.parse(Buffer.from(body!, "base64url").toString("utf8")) as { exp: number };
}

describe("signed session boundaries", () => {
  it("keeps explicit proof sessions capped at twelve hours", () => {
    const user = { id: "user:operator-proof", email: "operator@space.test", role: "ADMIN" as const };
    const secret = "test-secret-with-enough-length";

    expect(() => signSessionTokenWithTtl(user, secret, 43_201, 0)).toThrow();
  });

  it("issues normal operator sessions for exactly 30 days", () => {
    const token = signPersistentOperatorSessionToken(
      { id: "user:operator", email: "operator@space.test", role: "ADMIN" },
      "test-secret-with-enough-length",
      0
    );

    expect(decodeSessionToken(token).exp).toBe(persistentOperatorSessionTtlSeconds);
    expect(persistentOperatorSessionTtlSeconds).toBe(30 * 24 * 60 * 60);
  });

  it("rejects persistent tokens for the proof operator identity", () => {
    expect(() =>
      signPersistentOperatorSessionToken(
        { id: "user:operator-proof", email: "operator@space.test", role: "ADMIN" },
        "test-secret-with-enough-length",
        0
      )
    ).toThrow("Proof operators cannot receive persistent sessions.");
  });
});
