import { homedir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { isReportsSocket } from "./support/disposable-postgres.js";

it("takes only a run's own socket in the reports folder (EXT-C-F18)", () => {
  const root = join(homedir(), "agent-workspace", "reports");
  expect(isReportsSocket(`${root}/run-1/pg-socket`)).toBe(true);
  expect(isReportsSocket(`${root}/run-1/control-pg-socket`, "control-pg-socket")).toBe(true);
  for (const socket of [undefined, `${root}/pg-socket`, `${root}/a/b/pg-socket`, `${root}/run-1/pg-socket-2`, "/tmp/run-1/pg-socket"]) {
    expect(isReportsSocket(socket)).toBe(false);
  }
});
