import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../..");

describe("gitleaks configuration (#211)", () => {
  it("extends default rules and allowlists synthetic test fixture paths and public client identifiers", () => {
    const config = readFileSync(resolve(repoRoot, ".gitleaks.toml"), "utf8");
    expect(config).toContain("useDefault = true");
    expect(config).toContain("apps/[^/]+/tests/.*");
    expect(config).toContain("packages/[^/]+/tests/.*");
    expect(config).toContain("docs/quality/.*");

    const telemetrySrc = readFileSync(
      resolve(repoRoot, "agent-skills/space-hyperframes/media-use/scripts/lib/telemetry.mjs"),
      "utf8"
    );
    expect(telemetrySrc).toContain("gitleaks:allow");

    const claudeOauthSrc = readFileSync(
      resolve(repoRoot, "packages/gateway/src/providers/claude/oauth.ts"),
      "utf8"
    );
    expect(claudeOauthSrc).toContain("gitleaks:allow");
  });
});
