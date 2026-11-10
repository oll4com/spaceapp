import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { nousGoalsSettingsSchema, nousLowSpendSettingsSchema, nousModelsSettingsSchema, nousPaneBoardSettingsSchema, nousStandingOrdersSettingsSchema, type Artifact, type NousState } from "@space/contracts";
import { NousDock } from "../src/features/nous/NousDock.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";

// Shared (operator request 31/10 00:31 BKK, plan clipboard:RQSrp1EczBbV): the Agent Files Nous shared for a while, in their own dock tab with
// a count; a click opens the Agent Files preview, Remove ends only the share (DELETE /api/nous/shared-files/:id, never the artifact).
const state: NousState = { status: "IDLE", settings: { enabled: true, maxTurnsPerHour: 20, lowTokenAutomatic: true, lowSpend: nousLowSpendSettingsSchema.parse({}), mayPromote: false,
  mayApproveWarm: false, maySecurityHotfix: false, askOwnHostChanges: false, maySend: false, mayDeleteOwn: false, mayPublish: false, mayRestartHosts: false, neverRefuse: false, shell: false, alwaysApprove: [],
  paneBoard: nousPaneBoardSettingsSchema.parse({}), standingOrders: nousStandingOrdersSettingsSchema.parse({}), models: nousModelsSettingsSchema.parse({}), fallbackModel: "none",
  telegramInbound: false, copilotQuestionsNousFirst: true, goals: nousGoalsSettingsSchema.parse({}) }, model: "claude-fable-5-1", effort: "max", running: null, turnsThisHour: 0,
  lastError: null, openDecisions: 0, inbox: 0 };
const icons: Artifact = { id: "artifact:icons0001", roomId: "room:main0001", paneId: null, turnId: null, workflowId: null, kind: "EXPORT", mimeType: "text/markdown",
  storageUri: "space-artifact://agent-files/room:main0001/icon-options.md", sha256: "a".repeat(64), byteSize: 11,
  metadata: { source: "AGENT_OUTPUT", originalFilename: "icon-options.md", runtimeId: "nous", previewKind: "TEXT", folder: "GRAPHICS/Icons" },
  expiresAt: null, pinnedAt: null, deletedAt: null, createdAt: "2026-10-31T00:00:00.000Z" };
const share = { shareId: "nous_share:abc000000001", artifactId: icons.id, name: "icon-options.md", folder: "GRAPHICS/Icons", mime: "text/markdown", size: 11,
  note: "Pick one of the three icons", sharedAt: "2026-10-31T00:30:00.000Z", expiresAt: "2026-11-03T00:30:00.000Z" };

function serve() {
  const calls: Array<{ url: string; method: string }> = [];
  let shares = [share];
  vi.spyOn(liveRuntime.api, "artifacts").mockResolvedValue({ data: [icons], pagination: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 } });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    if (url === "/api/auth/csrf") return Response.json({ csrfToken: "csrf:nous", headerName: "x-space-csrf-token" });
    if (url === "/api/nous") return Response.json({ state });
    if (url === "/api/nous/messages") return Response.json({ messages: [], waiting: [], attachments: {} });
    if (url === "/api/nous/decisions") return Response.json({ decisions: [] });
    if (url === "/api/nous/shared-files") return Response.json(shares);
    if (url === `/api/nous/shared-files/${encodeURIComponent(share.shareId)}` && method === "DELETE") { shares = []; return Response.json({ removed: true }); }
    if (url.startsWith(`/api/artifacts/${encodeURIComponent(icons.id)}/preview`)) return new Response("three icons", { headers: { "content-type": "text/markdown" } });
    if (url.startsWith("/api/notifications")) return Response.json({ notifications: [], total: 0, bySource: {}, byRoom: {}, byPane: {}, latest: [] });
    return Response.json({});
  }));
  return calls;
}

beforeEach(() => installSpaceRuntime(liveRuntime));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("lists the shared files with their count, opens one in the Agent Files preview and removes only the share", async () => {
  const calls = serve();
  render(<NousDock canRun />);
  const tab = await within(screen.getByRole("group", { name: "Nous views" })).findByRole("button", { name: /^Shared\s*1$/ });
  fireEvent.click(tab);
  const entry = await screen.findByRole("article", { name: "icon-options.md" });
  expect(within(entry).getByText("Pick one of the three icons")).toBeTruthy();
  expect(within(entry).getByText(/Shared until/)).toBeTruthy();
  fireEvent.click(within(entry).getByRole("button", { name: "icon-options.md" }));
  expect(await screen.findByRole("dialog", { name: "Preview icon-options.md" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Close Agent File preview" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.click(within(entry).getByRole("button", { name: "Remove the share of icon-options.md" }));
  expect(await screen.findByText("Nothing shared")).toBeTruthy();
  expect(calls.filter((call) => call.method === "DELETE").map((call) => call.url)).toEqual([`/api/nous/shared-files/${encodeURIComponent(share.shareId)}`]);
  expect(within(screen.getByRole("group", { name: "Nous views" })).getByRole("button", { name: "Shared" })).toBeTruthy();
});
