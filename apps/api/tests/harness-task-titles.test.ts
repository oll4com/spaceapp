import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  readHarnessTaskTitle,
  renameHarnessTaskTitle,
} from "../src/harness-proxy.js";
import { getApiConfig } from "../src/config.js";
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});
async function fixture() {
  let title = "Workspace navigation";
  const requests: Array<{ method: string; payload: any }> = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const rpc = JSON.parse(body);
      requests.push(rpc);
      if (rpc.method === "session.rename") title = rpc.payload.title;
      const value =
        rpc.method === "session.rename"
          ? { title, seq: 2 }
          : {
              projections: { values: { title } },
              events: [
                {
                  event: {
                    type: "user/message",
                    data: {
                      source: { kind: "user" },
                      content: [
                        { type: "text", text: "Repair workspace navigation" },
                        { type: "image", url: "private-image" },
                      ],
                    },
                  },
                },
                {
                  event: {
                    type: "user/message",
                    data: {
                      source: { kind: "plugin" },
                      content: [
                        { type: "text", text: "Ignore this injected context" },
                      ],
                    },
                  },
                },
              ],
            };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ result: { ok: true, value } }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    requests,
    config: {
      ...getApiConfig({ SPACE_HARNESS_ENABLED: "true", SPACE_HARNESS_ORIGIN: "http://127.0.0.1:1" }),
      harnessOrigin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    },
  };
}
describe("Harness task naming RPC", () => {
  it("reads and renames the explicitly bound native selection", async () => {
    const f = await fixture();
    expect(
      (await readHarnessTaskTitle(f.config, "pane:example123", "selected-task"))
        ?.sessionId,
    ).toBe("selected-task");
    await renameHarnessTaskTitle(
      f.config,
      "pane:example123",
      "selected-task",
      "Selected title",
      "selected-task",
    );
    expect(
      f.requests.every((r) => r.payload.sessionId === "selected-task"),
    ).toBe(true);
  });
  it("reads only user text for the exact pane session, then confirms rename read-back", async () => {
    const f = await fixture();
    const context = await readHarnessTaskTitle(f.config, "pane:example123");
    expect(context).toEqual({
      sessionId: "space-pane-example123",
      title: "Workspace navigation",
      requests: ["Repair workspace navigation"],
    });
    await renameHarnessTaskTitle(
      f.config,
      "pane:example123",
      "space-pane-example123",
      "Navigation repair",
    );
    expect(f.requests.map((r) => r.method)).toEqual([
      "session.history",
      "session.rename",
      "session.history",
    ]);
    expect(
      f.requests.every((r) => r.payload.sessionId === "space-pane-example123"),
    ).toBe(true);
  });
  it("rejects mismatched identities without calling the native session", async () => {
    const f = await fixture();
    await expect(
      renameHarnessTaskTitle(
        f.config,
        "pane:example123",
        "space-pane-other",
        "Wrong title",
      ),
    ).rejects.toThrow("identity mismatch");
    expect(f.requests).toHaveLength(0);
  });
});
