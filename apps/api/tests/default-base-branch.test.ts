import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultWorktreeBaseBranch } from "../src/worktrees/default-base-branch.js";

describe("default worktree base branch", () => {
  it("follows the merge queue's default target for the Space repository only", () => {
    const dir = mkdtempSync(join(tmpdir(), "space-default-base-"));
    const file = join(dir, "default-target");
    expect(defaultWorktreeBaseBranch("/opt/spaceapp", file)).toBe("main");
    writeFileSync(file, "dev\n");
    expect(defaultWorktreeBaseBranch("/opt/spaceapp", file)).toBe("dev");
    expect(defaultWorktreeBaseBranch("/opt/spaceapp/", file)).toBe("dev");
    expect(defaultWorktreeBaseBranch("/home/operator/project", file)).toBe("main");
    writeFileSync(file, "stable\n");
    expect(defaultWorktreeBaseBranch("/opt/spaceapp", file)).toBe("main");
  });
});
