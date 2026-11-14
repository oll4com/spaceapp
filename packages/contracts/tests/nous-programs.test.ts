// The programs registry's pages (Affiliate: operator 14/11 00:07 BKK, nous_msg:de448bc711204fdb832cf926): the old oll4-funding page still
// reads as startup, affiliate is its own page, and an affiliate approval's sign-in is only ever a Vault handle.
import { expect, it } from "vitest";
import { nousProgramInputSchema, nousProgramPageSchema } from "../src/nous-programs.js";

it("reads the pages and keeps an affiliate approval's facts, its sign-in a Vault handle only", () => {
  expect(nousProgramPageSchema.parse(" Affiliate ")).toBe("affiliate");
  expect(nousProgramPageSchema.parse("oll4-funding")).toBe("startup");
  expect(nousProgramPageSchema.safeParse("coupons").success).toBe(false);
  const entry = { id: "admitad", page: "affiliate", affiliate: { network: "Admitad", publisherId: "2606420", cookieDays: 30, signIn: "vault_item:cLQ_AnzHIAbLTfAAMqlsxw" } };
  expect(nousProgramInputSchema.parse(entry).affiliate).toEqual({ network: "Admitad", publisherId: "2606420", commission: null, cookieDays: 30, trackingLink: null,
    couponFeed: null, payout: null, signIn: "vault_item:cLQ_AnzHIAbLTfAAMqlsxw" });
  for (const signIn of ["hunter2", "user@example.com:pass", "vault_item:"]) {
    expect(nousProgramInputSchema.safeParse({ ...entry, affiliate: { signIn } }).success).toBe(false);
  }
  expect(nousProgramInputSchema.parse({ ...entry, affiliate: null }).affiliate).toBeNull();
});
