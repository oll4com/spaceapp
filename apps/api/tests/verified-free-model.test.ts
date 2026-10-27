import { describe, expect, it } from "vitest";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readVerifiedFreeModel, verifiedFreeModelFromRecord } from "../src/verified-free-model.js";

// What OpenCode 2's first run (public deploy/docker/opencode-first-run.mjs) and First Setup's selection record.
const valid = {
  id: "opencode/big-pickle", name: "Big Pickle", verification: "tool-call", verifiedAt: "2026-10-08T04:00:00.000Z",
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } }, nativeSessionId: "ses_abc"
};

describe("verified first OpenCode model", () => {
  it("uses only a recent account-free proof that completed a real tool call", () => {
    const now = Date.parse("2026-10-08T04:30:00.000Z");
    expect(verifiedFreeModelFromRecord(valid, now)).toBe("opencode/big-pickle");
    expect(verifiedFreeModelFromRecord({ ...valid, cost: { input: 0, output: 0 } }, now)).toBe("opencode/big-pickle");
    // An OpenCode 1 proof only showed a text answer (operator rule 2026-10-11: working only after a real tool call).
    const { verification: _, ...textOnly } = valid;
    expect(verifiedFreeModelFromRecord({ ...textOnly, proofVersion: 1, completed: true, providerID: "opencode", status: "active" }, now)).toBeNull();
    expect(verifiedFreeModelFromRecord({ ...valid, verification: "text" }, now)).toBeNull();
    expect(verifiedFreeModelFromRecord({ ...valid, cost: { input: 0, output: 0, cache: { read: 0.1, write: 0 } } }, now)).toBeNull();
    expect(verifiedFreeModelFromRecord({ ...valid, cost: { input: 0, output: 0.01, cache: { read: 0, write: 0 } } }, Date.parse("2026-10-08T04:30:00.000Z"))).toBeNull();
    // Every price dimension counts; a null or non-object cache price is unknown, not zero (review 2026-10-21 #2).
    expect(verifiedFreeModelFromRecord({ ...valid, cost: { input: 0, output: 0, cache: { read: 0, write: 0 }, reasoning: 1 } }, now)).toBeNull();
    expect(verifiedFreeModelFromRecord({ ...valid, cost: { input: 0, output: 0, cache: { read: 0, write: 0, storage: 0.2 } } }, now)).toBeNull();
    expect(verifiedFreeModelFromRecord({ ...valid, cost: { input: 0, output: 0, cache: null } }, now)).toBeNull();
    expect(verifiedFreeModelFromRecord({ ...valid, cost: { input: 0, output: 0, cache: "none" } }, now)).toBeNull();
    expect(verifiedFreeModelFromRecord({ ...valid, verifiedAt: "2026-10-06T04:00:00.000Z" }, Date.parse("2026-10-08T04:30:00.000Z"))).toBeNull();
    expect(verifiedFreeModelFromRecord({ ...valid, id: "opencode/unknown`x" }, Date.parse("2026-10-08T04:30:00.000Z"))).toBeNull();
  });
  it("refuses a symlinked or oversized shared-memory record", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-free-model-"));
    try {
      const path = join(root, "installation-model.json");
      await writeFile(path, JSON.stringify({ ...valid, verifiedAt: new Date().toISOString() }));
      expect(await readVerifiedFreeModel(root)).toBe("opencode/big-pickle");
      await rm(path);
      await writeFile(join(root, "outside.json"), JSON.stringify(valid));
      await symlink(join(root, "outside.json"), path);
      expect(await readVerifiedFreeModel(root)).toBeNull();
      await rm(path);
      await writeFile(path, "x".repeat(4097));
      expect(await readVerifiedFreeModel(root)).toBeNull();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

});
