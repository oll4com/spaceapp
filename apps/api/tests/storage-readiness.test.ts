import { beforeEach, describe, expect, it, vi } from "vitest";

const devices = new Map<string, number>();
vi.mock("node:fs/promises", () => ({
  stat: async (path: string) => ({ dev: devices.get(path) }),
  statfs: async () => ({ blocks: 100 * 1024 ** 2, bsize: 1024, bavail: 60 * 1024 ** 2 })
}));
const { collectStorageReadiness } = await import("../src/storage-readiness.js");

describe("collectStorageReadiness", () => {
  beforeEach(() => devices.clear());

  it("verifies an app whose data (/opt/spaceapp/var) sits on its own disk while the app itself is on /", async () => {
    devices.set("/", 1).set("/opt/spaceapp/var", 2);
    const result = await collectStorageReadiness();
    expect(result).toMatchObject({ status: "VERIFIED", dedicatedAppVolume: true, app: { path: "/opt/spaceapp/var" } });
  });

  it("blocks when /opt/spaceapp/var shares the root device", async () => {
    devices.set("/", 1).set("/opt/spaceapp/var", 1);
    const result = await collectStorageReadiness();
    expect(result.status).toBe("BLOCKED");
    expect(result.statusReason).toContain("Dedicated /opt/spaceapp/var volume is not detected");
  });
});
