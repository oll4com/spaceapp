import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
// tests/support/chrome-sandbox.ts stubs this module for every other test; this file tests the real one.
const { createChromeSandboxCheck, probeChromeSandbox } = await vi.importActual<typeof import("../src/browser-sandbox.js")>("../src/browser-sandbox.js");

// INT5-C-F3: Space's Chromes run with Chromium's own sandbox whenever this host can build it, and keep --no-sandbox
// (named in the Browser Host's health) only when the start-up check fails.
describe("Chrome sandbox check (INT5-C-F3)", () => {
  const dirs: string[] = [];
  afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
  async function fakeChrome(body: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "fake-chrome-"));
    dirs.push(dir);
    const path = join(dir, "chrome");
    await writeFile(path, `#!/bin/sh\n${body}\n`);
    await chmod(path, 0o755);
    return path;
  }

  it("drops --no-sandbox only after the check passed, and checks once", async () => {
    const probe = vi.fn(async () => ({ ok: true, detail: "" }));
    const check = createChromeSandboxCheck("/usr/bin/google-chrome", probe);
    expect(check.state().state).toBe("CHECKING");
    expect(await check.args()).toEqual([]);
    expect(await check.args()).toEqual([]);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(check.state()).toMatchObject({ state: "SANDBOXED" });
  });

  it("logs one line when the fallback is taken, none when the sandbox runs", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const failed = createChromeSandboxCheck("chrome", async () => ({ ok: false, detail: "No usable sandbox!" }));
      await failed.args();
      await failed.args();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/^Chrome sandbox unavailable \(No usable sandbox!\); browsers run with --no-sandbox/);
      await createChromeSandboxCheck("chrome", async () => ({ ok: true, detail: "" })).args();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps --no-sandbox and names why when the sandbox cannot start or the probe throws", async () => {
    const failed = createChromeSandboxCheck("chrome", async () => ({ ok: false, detail: "No usable sandbox!" }));
    expect(await failed.args()).toEqual(["--no-sandbox"]);
    expect(failed.state().state).toBe("NO_SANDBOX");
    expect(failed.state().reason).toContain("No usable sandbox!");
    const threw = createChromeSandboxCheck("chrome", async () => { throw new Error("spawn EACCES"); });
    expect(await threw.args()).toEqual(["--no-sandbox"]);
    expect(threw.state().reason).toContain("spawn EACCES");
  });

  it("the probe starts Chrome without --no-sandbox and passes only on a clean exit with the page", async () => {
    const sandboxed = await fakeChrome(`for a in "$@"; do [ "$a" = "--no-sandbox" ] && exit 9; done
case "$*" in *--dump-dom*space-chrome-sandbox-ok*) echo "<html><body><p>space-chrome-sandbox-ok</p></body></html>";; esac`);
    expect(await probeChromeSandbox(sandboxed)).toEqual({ ok: true, detail: "" });
    const noSandbox = await fakeChrome(`echo "[1:1:ERROR:zygote_host_impl_linux.cc:130] No usable sandbox! If this is a Debian system" >&2; exit 1`);
    expect(await probeChromeSandbox(noSandbox)).toMatchObject({ ok: false, detail: expect.stringContaining("No usable sandbox") });
    const silent = await fakeChrome("exit 0");
    expect((await probeChromeSandbox(silent)).ok).toBe(false);
    expect((await probeChromeSandbox(join(tmpdir(), "no-such-chrome"))).ok).toBe(false);
  });

  it("no Space Chrome spawn hard-codes --no-sandbox any more", async () => {
    for (const file of ["browser-sessions.ts", "browser-evidence.ts"]) {
      const source = await readFile(new URL(`../src/${file}`, import.meta.url), "utf8");
      expect(source, file).not.toContain('"--no-sandbox"');
      expect(source, file).toMatch(/chromeSandboxCheck\(/);
    }
  });

  const realChrome = ["/usr/bin/google-chrome", "/usr/bin/chromium"].find(path => existsSync(path));
  it.skipIf(!realChrome)("a real Chrome on this host answers the probe either way", async () => {
    const result = await probeChromeSandbox(realChrome!);
    expect(typeof result.ok).toBe("boolean");
    if (!result.ok) expect(result.detail).not.toBe("");
  }, 40_000);
});
