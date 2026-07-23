import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createOwnerSetupBootstrap,
  loadOwnerSetupBootstrap
} from "../src/owner-setup.js";

describe("owner setup bootstrap", () => {
  it("loads a bounded file secret and returns only its hash with a 15-minute expiry", async () => {
    const root = await mkdtemp(join(tmpdir(), "spaceapp-owner-setup-"));
    const tokenFile = join(root, "setup-token");
    const token = "setup-token-value-with-at-least-thirty-two-characters";
    await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });

    const setup = await loadOwnerSetupBootstrap(
      { SPACE_SETUP_TOKEN_FILE: tokenFile },
      new Date("2026-07-23T12:00:00.000Z")
    );

    expect(setup).toEqual(createOwnerSetupBootstrap(
      token,
      "2026-07-23T12:15:00.000Z"
    ));
    expect(JSON.stringify(setup)).not.toContain(token);
  });

  it("does not enable setup without an explicit token file", async () => {
    await expect(loadOwnerSetupBootstrap({})).resolves.toBeNull();
  });
});
