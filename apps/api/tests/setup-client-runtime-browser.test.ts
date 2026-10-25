import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { describe, expect, it, vi } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { createBrowserSessionManager, browserProfilePathFor } from "../src/browser-sessions.js";
import { getApiConfig } from "../src/config.js";

describe("client runtime function in real Chrome", () => {
  it("executes the actual Asteroids engine/canvas and OSK input functions in an owned empty document", async () => {
    vi.stubEnv("TMPDIR", "/tmp");
    const root = await mkdtemp(join(tmpdir(), "setup-client-browser-"));
    const bundle = await build({ stdin: { resolveDir: resolve("../web"), loader: "ts", contents: `
      import { runSetupClientRuntimeCheck } from './src/features/setup-connections/setup-client-runtime-check.ts';
      (async () => {
        try {
          const signal = new AbortController().signal;
          const game = await runSetupClientRuntimeCheck('utility:asteroids', 'SpaceApp-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', signal);
          const osk = await runSetupClientRuntimeCheck('utility:osk', 'SpaceApp-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', signal);
          document.body.textContent = JSON.stringify({ game, osk });
        } catch { document.body.textContent = 'CHECK_FAILED'; }
      })();
    ` }, bundle: true, write: false, outfile: join(root, "check.js"), format: "iife", platform: "browser", target: "chrome140" });
    const script = bundle.outputFiles.find(file => file.text.includes("CHECK_FAILED"))!.text;
    const server = createServer((request, response) => {
      if (request.url === "/check.js") { response.writeHead(200, { "content-type": "text/javascript" }); response.end(script); }
      else { response.writeHead(200, { "content-type": "text/html" }); response.end('<html lang="en"><body>CHECK_PENDING<script src="/check.js"></script></body></html>'); }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("No fixture port.");
    const origin = `http://127.0.0.1:${address.port}`;
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Agent Proof client runtimes", initialPaneCount: 0, kind: "AGENT_PROOF" });
    const pane = store.createPane({ roomId: room.id, title: "Client function proof", mode: "BROWSER" });
    const manager = createBrowserSessionManager({ store, config: getApiConfig({ SPACE_BROWSER_SESSIONS_ENABLED: "true",
      SPACE_BROWSER_EVIDENCE_TARGET_ORIGIN: origin, SPACE_BROWSER_SESSIONS_PROFILE_ROOT: root, SPACE_BROWSER_SESSIONS_AUDIO_ENABLED: "false" }) });
    try {
      await manager.startOrRestore({ pane, targetUrl: origin, traceId: "client-functions", includeInitialFrame: false });
      let text: string | null | undefined;
      const deadline = Date.now() + 5000;
      do {
        text = (await manager.action(pane, { type: "extract_text" }, "client-functions")).text;
        if (text !== "CHECK_PENDING") break;
        await new Promise(resolve => setTimeout(resolve, 50));
      } while (Date.now() < deadline);
      const observed = JSON.parse(text!);
      expect(observed.game).toMatchObject({ featureId: "utility:asteroids", ticks: 30, painted: true });
      expect(observed.game.elapsed).toBeCloseTo(0.5); expect(observed.game.shotsFired).toBeGreaterThan(0);
      expect(observed.osk).toEqual({ featureId: "utility:osk", text: "SpaceApp-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", terminalData: "SpaceApp-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
    } finally {
      await manager.stopPane(pane.id); store.deleteRoom(room.id);
      await rm(browserProfilePathFor(root, room.id, pane.id), { recursive: true, force: true });
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs();
    }
  }, 30_000);
});
