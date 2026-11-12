import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NeedsYouFiles } from "../src/features/needs-you/NeedsYouFiles.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";

// nous_msg:0cb8d563 («θελω να βλεπω κατευθείαν το αρχειο και να μπορώ να το ανοίξω από εδώ!!»): a decision's refs.files open from the card.
const at = "2026-11-06T08:00:00.000Z";
const agentFile = (id: string, name: string) => ({ id, roomId: "room:work000001", paneId: null, turnId: null, workflowId: null, kind: "EXPORT", mimeType: "text/markdown",
  storageUri: `space-artifact://agent-files/${id}`, sha256: "a".repeat(64), byteSize: 64, expiresAt: null, pinnedAt: null, deletedAt: null, createdAt: at,
  metadata: { source: "AGENT_OUTPUT", originalFilename: name, folder: "Documents", previewKind: "TEXT" } });
const pitch = agentFile("artifact:Pitch0000001", "pitch.md");
const filed = agentFile("artifact:Filed0000001", "step8-outreach-emails.md");

let posted: unknown[] = [];
beforeEach(() => {
  installSpaceRuntime(liveRuntime);
  posted = [];
  vi.spyOn(liveRuntime.api, "artifacts").mockResolvedValue({ data: [pitch], pagination: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 } } as never);
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/auth/csrf") return Response.json({ csrfToken: "csrf:files", headerName: "x-space-csrf-token" });
    if (url === "/api/nous/files/agent-file") {
      const { path } = JSON.parse(String(init?.body)) as { path: string };
      posted.push(path);
      return path.includes("secrets/")
        ? Response.json({ error: { message: "That path looks like a secret (keys, tokens, cookies, .env, .config, secrets/): it is never read." } }, { status: 400 })
        : Response.json({ artifact: filed });
    }
    return Response.json({});
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("NeedsYouFiles refs (a decision's files)", () => {
  it("an Agent File ref opens its preview under its name", async () => {
    render(<NeedsYouFiles refs={[pitch.id]} />);
    fireEvent.click(await screen.findByRole("button", { name: /pitch\.md/ }));
    expect(await screen.findByRole("dialog", { name: "Preview pitch.md" })).toBeTruthy();
  });

  it("a workspace path is filed through the server (read from the agent workspace) and opens the preview", async () => {
    render(<NeedsYouFiles refs={["reports/olla/step8-outreach-emails.md"]} />);
    fireEvent.click(screen.getByRole("button", { name: /step8-outreach-emails\.md/ }));
    expect(await screen.findByRole("dialog", { name: "Preview step8-outreach-emails.md" })).toBeTruthy();
    expect(posted).toEqual(["~/agent-workspace/reports/olla/step8-outreach-emails.md"]);
  });

  it("a refused file (secret-looking or private) says why instead of opening", async () => {
    render(<NeedsYouFiles refs={["secrets/key.txt"]} />);
    fireEvent.click(screen.getByRole("button", { name: /key\.txt/ }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/looks like a secret/);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a room's Media item (no Agent File) opens by its /file route in a new tab (/download serves only Agent Files)", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    render(<NeedsYouFiles refs={["artifact:Media0000001"]} />);
    fireEvent.click(screen.getByRole("button", { name: /artifact:Media0000001/ }));
    await waitFor(() => expect(open).toHaveBeenCalledWith("/api/artifacts/artifact%3AMedia0000001/file", "_blank", "noopener"));
  });
});
