import { describe, expect, it } from "vitest";
import { cliAgentFilesApiBaseUrl } from "../src/cli-agent-files.js";
import { cliBrowserBridgeApiBaseUrl } from "../src/cli-browser-bridge.js";

// run-spaceapp 1.2.0 (operator 5/11, plan clipboard:NtXOwLkXVN1x): a public install's panes run in the CLI container, so the
// pane tokens' endpoints name SPACE_CLI_API_BASE_URL; this server sets no such URL and keeps its local origin.
describe("where a pane reaches the API", () => {
  const local = { host: "127.0.0.1", port: 4910, browserEvidenceTargetOrigin: "http://127.0.0.1:4911/" };
  it("uses the CLI container's API URL on a public install", () => {
    const pub = { ...local, cliApiBaseUrl: "http://spaceapp-core:4911/" };
    expect(cliBrowserBridgeApiBaseUrl(pub)).toBe("http://spaceapp-core:4911");
    expect(cliAgentFilesApiBaseUrl(pub)).toBe("http://spaceapp-core:4911");
  });
  it("keeps the local origin when no CLI API URL is set", () => {
    for (const config of [local, { ...local, cliApiBaseUrl: null }]) {
      expect(cliBrowserBridgeApiBaseUrl(config)).toBe("http://127.0.0.1:4911");
      expect(cliAgentFilesApiBaseUrl(config)).toBe("http://127.0.0.1:4911");
    }
  });
});
