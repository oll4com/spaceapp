import { describe, expect, it } from "vitest";
import { parseVaultOtp, vaultOtpStoredValue, vaultTotp } from "../src/index.js";

// RFC 6238 appendix B keys: "12345678901234567890" repeated to the hash's length, in base32.
const SHA1 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const SHA256 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA";
const SHA512 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNA";

describe("Vault authenticator keys", () => {
  it("computes the RFC 6238 vectors for every algorithm an otpauth URI names", async () => {
    for (const [key, algorithm, code] of [[SHA1, "SHA1", "94287082"], [SHA256, "SHA256", "46119246"], [SHA512, "SHA512", "90693936"]] as const) {
      const otp = parseVaultOtp(`otpauth://totp/x?secret=${key}&digits=8&algorithm=${algorithm}`)!;
      expect(await vaultTotp(otp.secret, new Date(59_000), otp)).toBe(code);
    }
  });

  it("reads Google Authenticator's Key URI format and a bare key", () => {
    expect(parseVaultOtp("otpauth://totp/ACME%20Co:john.doe@email.com?secret=HXDMVJECJJWSRB3HWIZR4IFUGFTMXBOZ&issuer=ACME%20Co&period=60"))
      .toMatchObject({ issuer: "ACME Co", account: "john.doe@email.com", digits: 6, periodSeconds: 60, algorithm: "SHA1" });
    expect(parseVaultOtp("otpauth://totp/GitHub:me?secret=JBSWY3DPEHPK3PXP")).toMatchObject({ issuer: "GitHub", account: "me" });
    expect(parseVaultOtp("jbsw y3dp ehpk 3pxp")).toMatchObject({ digits: 6, periodSeconds: 30, issuer: null });
    for (const bad of ["", "not a key!", "otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP&counter=1", "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&digits=9",
      "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&algorithm=MD5", "otpauth://totp/x?issuer=a"]) expect(parseVaultOtp(bad)).toBeNull();
  });

  it("keeps the bare key for default URIs and the URI only when it changes digits, period or algorithm", () => {
    expect(vaultOtpStoredValue("otpauth://totp/GitHub:me?secret=jbswy3dpehpk3pxp&issuer=GitHub")).toBe("JBSWY3DPEHPK3PXP");
    expect(vaultOtpStoredValue("jbsw y3dp ehpk 3pxp")).toBe("JBSWY3DPEHPK3PXP");
    const custom = "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&digits=8";
    expect(vaultOtpStoredValue(custom)).toBe(custom);
    expect(vaultOtpStoredValue("nope!")).toBeNull();
  });
});
