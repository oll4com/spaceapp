import { expect, it, vi } from "vitest";
import { measureCommand } from "../scripts/temporal-measurement.mjs";

it("reports a successful subprocess and a nonnegative duration", () => {
  const result = measureCommand(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  expect(result.exitCode).toBe(0);
  expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  expect(result.signal).toBeNull();
});
it("preserves a failing child exit code instead of reporting timing as success", () => {
  const result = measureCommand(process.execPath, ["-e", "process.exit(7)"], { stdio: "ignore" });
  expect(result.exitCode).toBe(7);
});
it("does not use an adjustable wall clock for elapsed measurement", () => {
  const wallClock = vi.spyOn(Date, "now").mockReturnValueOnce(10_000_000).mockReturnValueOnce(-10_000_000);
  try {
    const result = measureCommand(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(wallClock).not.toHaveBeenCalled();
  } finally { wallClock.mockRestore(); }
});
