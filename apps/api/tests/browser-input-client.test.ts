import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Pane } from "@space/contracts";
import { createBrowserHostServer, type BrowserHostRequestHandler } from "@space/browser-host";
import { createBrowserHostProxy, type BrowserSessionManagerWithHostHealth } from "../src/browser-host-proxy.js";
import { withHostBoundBrowserInput } from "../src/browser-input-client.js";
import { getApiConfig } from "../src/config.js";

// Unix socket paths are limited to about 107 bytes.
const socketTmp = tmpdir().length > 40 ? "/tmp" : tmpdir();

describe("operator browser input on the host-bound client", () => {
  it("keeps every pane's input when one pane's input takes longer than 5 s", async () => {
    const root = await mkdtemp(join(socketTmp, "space-browser-input-"));
    const socketPath = join(root, "host.sock");
    const started = Date.now();
    const until = (ms: number) => new Promise(resolve => setTimeout(resolve, Math.max(0, started + ms - Date.now())));
    // Pane a is a background tab (its input answers after 5.5 s); pane b's input is in flight when a passes 5 s.
    const handler: BrowserHostRequestHandler = {
      async health() { throw new Error("unused"); },
      async request(_method, params) {
        await until((params.pane as Pane).id.startsWith("a") ? 5_500 : 5_300);
        return null;
      },
      async startFrameStream() { throw new Error("unused"); }
    };
    const server = await createBrowserHostServer({ socketPath, handler });
    const config = getApiConfig({ SPACE_BROWSER_HOST_TRANSPORT: "unix", SPACE_BROWSER_HOST_SOCKET: socketPath });
    const before = createBrowserHostProxy({ config });
    const after = withHostBoundBrowserInput({ async closeAll() {} } as unknown as BrowserSessionManagerWithHostHealth, config);
    const input = { type: "POINTER", leaseId: "lease:test", eventType: "mouseMoved", x: 1, y: 1 } as const;
    try {
      const slow = [before, after].map(manager => manager.dispatchInput!({ id: `a-${manager === after}` } as Pane, input, "trace"));
      await until(4_800);
      const other = [before, after].map(manager => manager.dispatchInput!({ id: `b-${manager === after}` } as Pane, input, "trace"));
      // The proxy's 5 s input client dropped its socket and failed the other pane too.
      await expect(slow[0]).rejects.toMatchObject({ errorCode: "BROWSER_HOST_UNAVAILABLE" });
      await expect(other[0]).rejects.toMatchObject({ errorCode: "BROWSER_HOST_UNAVAILABLE" });
      await expect(Promise.all([slow[1], other[1]])).resolves.toEqual([undefined, undefined]);
    } finally {
      await before.closeAll();
      await after.closeAll();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);
});
