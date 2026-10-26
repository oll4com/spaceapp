// 龙娘 · 2026-10-26: development room defaults are explicit and never alter stable defaults.
import { describe, expect, it } from "vitest";
import { defaultRoomProjectPath } from "../src/index.js";

describe("room project defaults", () => {
  it("uses only an explicitly configured absolute workspace on dev", () => {
    expect(defaultRoomProjectPath({ SPACE_INSTANCE: "dev", SPACE_CLI_WORKSPACE_ROOT: "/checkout/.dev-stack/workspaces" })).toBe("/checkout/.dev-stack/workspaces");
    expect(defaultRoomProjectPath({ SPACE_INSTANCE: "dev" })).toBe("/opt/spaceapp");
    expect(defaultRoomProjectPath({ SPACE_INSTANCE: "dev", SPACE_CLI_WORKSPACE_ROOT: "relative" })).toBe("/opt/spaceapp");
  });

  it("preserves stable defaults even when a CLI workspace is configured", () => {
    expect(defaultRoomProjectPath({})).toBe("/opt/spaceapp");
    expect(defaultRoomProjectPath({ SPACE_INSTANCE: "stable", SPACE_CLI_WORKSPACE_ROOT: "/chosen/workspace" })).toBe("/opt/spaceapp");
  });
});
