import { describe, expect, it } from "vitest";
import { vaultDelegationOrigins } from "../src/vault-login-affiliates.js";

describe("reviewed Vault login affiliates", () => {
  it("adds only GSIS's exact login origin, without mutating or duplicating stored origins", () => {
    const stored = ["https://www1.gsis.gr"];
    expect(vaultDelegationOrigins(stored)).toEqual([...stored, "https://login.gsis.gr"]);
    expect(stored).toEqual(["https://www1.gsis.gr"]);
    expect(vaultDelegationOrigins([...stored, "https://login.gsis.gr"])).toEqual([...stored, "https://login.gsis.gr"]);
  });

  it.each(["https://login.gsis.gr", "https://www.aade.gr", "https://www1.aade.gr", "https://gsis.gr", "https://other.gsis.gr",
    "https://www1.gsis.gr.evil.test", "https://sub.www1.gsis.gr", "http://www1.gsis.gr", "https://www1.gsis.gr:444"])("never infers affiliation for %s", origin => {
    expect(vaultDelegationOrigins([origin])).toEqual([origin]);
  });
});
