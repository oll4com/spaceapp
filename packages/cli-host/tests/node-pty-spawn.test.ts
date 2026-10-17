import { beforeEach, describe, expect, it, vi } from "vitest";

const { platform, spawn } = vi.hoisted(() => ({ platform: vi.fn(), spawn: vi.fn() }));
vi.mock("node:os", () => ({ platform }));
vi.mock("node-pty", () => ({ spawn }));
import { spawnNodePty } from "../src/node-pty-spawn.js";

const spec = { command: "/private/cli", args: ["literal $HOME; no shell expansion"], cwd: "/private/workspace", env: { HOME: "/private/home" }, cols: 120, rows: 32 };
const options = { name: "xterm-256color", cols: spec.cols, rows: spec.rows, cwd: spec.cwd, env: spec.env };
beforeEach(() => { vi.resetAllMocks(); });

describe("native CLI PTY interrupt setup", () => {
  it("uses Darwin's absolute stty while preserving the pane cwd, environment and literal argv", () => {
    platform.mockReturnValue("darwin");
    const terminal = { pid: 123 }; spawn.mockReturnValue(terminal);
    expect(spawnNodePty(spec)).toBe(terminal);
    expect(spawn).toHaveBeenCalledExactlyOnceWith("/bin/sh", ["-c", '/bin/stty -isig; exec "$@"', "space-cli-host", spec.command, ...spec.args], options);
  });

  it("keeps the original Linux shell command and argument forwarding unchanged", () => {
    platform.mockReturnValue("linux");
    spawnNodePty(spec);
    expect(spawn).toHaveBeenCalledExactlyOnceWith("/bin/sh", ["-c", '/usr/bin/stty -isig; exec "$@"', "space-cli-host", spec.command, ...spec.args], options);
  });

  it("rejects the historical missing Darwin path in a virtualized boundary and accepts the real entry's selection", () => {
    platform.mockReturnValue("darwin");
    // Synthetic path availability, not an actual native-platform execution claim.
    spawn.mockImplementation((_command: string, args: string[]) => {
      if (!args[1].startsWith("/bin/stty ")) throw Object.assign(new Error("missing Darwin stty"), { code: "ENOENT" });
      return { pid: 456 };
    });
    expect(() => spawn("/bin/sh", ["-c", '/usr/bin/stty -isig; exec "$@"'], options)).toThrow("missing Darwin stty");
    expect(spawnNodePty(spec).pid).toBe(456);
  });

  it("propagates a real spawn boundary failure without a PATH or alternate-command retry", () => {
    platform.mockReturnValue("darwin");
    const error = Object.assign(new Error("probe spawn failed"), { code: "EACCES" }); spawn.mockImplementation(() => { throw error; });
    expect(() => spawnNodePty(spec)).toThrow(error);
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
