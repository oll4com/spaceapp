import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Artifact, Room } from "@space/contracts";
import { AgentFilesDock, clearStoredAgentFilesCache } from "../src/features/agent-files/AgentFilesDock.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";
import { SPACE_ARTIFACT_MIME } from "../src/features/artifacts/artifact-drag.js";
import { DockActiveContext } from "../src/features/docks/dock-active-context.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const csrfHeaderName = "x-space-csrf-token";
const listUrl =
  "/api/artifacts?collection=AGENT_FILES&pageSize=100&sortOrder=desc";
const clearUrl = "/api/rooms/room%3Aagent-files/agent-files";

const room: Room = {
  id: "room:agent-files",
  name: "Deliverables",
  description: null,
  kind: "WORKSPACE",
  order: 0,
  paneLayoutColumns: null,
  paneLayoutHeight: 1,
  paneCap: 16,
  traceId: "trace:agent-files",
  archivedAt: null,
  createdAt: "2026-07-29T08:00:00.000Z",
  updatedAt: "2026-07-29T08:00:00.000Z"
};

function artifact(input: Partial<Artifact> & Pick<Artifact, "id" | "mimeType" | "storageUri">): Artifact {
  return {
    roomId: room.id,
    paneId: "pane:codex",
    turnId: null,
    workflowId: null,
    kind: "EXPORT",
    sha256: "a".repeat(64),
    byteSize: 4096,
    metadata: {
      source: "AGENT_OUTPUT",
      originalFilename: "final.txt",
      runtimeId: "cli:codex",
      cliSessionId: "cli_session:test",
      previewKind: "TEXT"
    },
    expiresAt: null,
    pinnedAt: null,
    deletedAt: null,
    createdAt: "2026-07-29T08:00:00.000Z",
    ...input
  };
}

function paginated(data: Artifact[]) {
  return {
    data,
    pagination: {
      page: 1,
      pageSize: 100,
      totalItems: data.length,
      totalPages: data.length ? 1 : 0
    }
  };
}

function summaryText(container: HTMLElement): string | null {
  return container.querySelector(".dock-kit-summary")?.textContent ?? null;
}

function openFilters() {
  fireEvent.click(screen.getByRole("button", { name: /^Filters/ }));
}

beforeEach(() => {
  clearStoredAgentFilesCache();
  localStorage.clear();
  installSpaceRuntime(liveRuntime);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, "showSaveFilePicker");
});

describe("AgentFilesDock", () => {
  it("filters filenames and file types locally and clears an empty search", async () => {
    const files = [
      artifact({ id: "artifact:pdf", mimeType: "application/pdf", storageUri: "space-artifact://agent-files/report.pdf", metadata: { source: "AGENT_OUTPUT", originalFilename: "Release Report.pdf" } }),
      artifact({ id: "artifact:image", mimeType: "image/png", storageUri: "space-artifact://agent-files/preview.png", metadata: { source: "AGENT_OUTPUT", originalFilename: "Preview.png" } })
    ];
    const list = vi.spyOn(liveRuntime.api, "artifacts").mockResolvedValue(paginated(files));
    const { container } = render(<AgentFilesDock activeRoom={room} />);
    expect(await screen.findByText("Release Report.pdf")).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search Agent Files" }), { target: { value: " REPORT " } });
    expect(screen.queryByText("Preview.png")).toBeNull();
    // The result count is shown once, in the toolbar summary.
    expect(summaryText(container)).toBe("1 of 2 files");
    expect(container.textContent?.match(/of 2 files/g)).toHaveLength(1);
    // Type and date filters live behind one Filters control.
    expect(screen.queryByRole("combobox", { name: "Filter Agent Files by type" })).toBeNull();
    openFilters();
    fireEvent.change(screen.getByRole("combobox", { name: "Filter Agent Files by type" }), { target: { value: "IMAGE" } });
    expect(screen.getByText("No files match your search.")).toBeTruthy();
    expect(summaryText(container)).toBe("0 of 2 files · Images");
    expect(container.textContent).not.toMatch(/\bIMAGE\b/);
    expect(screen.getByRole("button", { name: "Filters (1 active)" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show all files" }));
    expect(screen.getByText("Preview.png")).toBeTruthy();
    expect(screen.getByText("Release Report.pdf")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Filters" })).toBeTruthy();
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("lists Agent Files of every room, keeps them across a room switch and closes the preview", async () => {
    let resolveFirst!: (value: ReturnType<typeof paginated>) => void;
    const list = vi.spyOn(liveRuntime.api, "artifacts").mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }));
    const { container, rerender } = render(<AgentFilesDock activeRoom={room} />);
    // Loading is shown once, as the kit loading state.
    expect(screen.getAllByText(/Loading/)).toHaveLength(1);
    expect(screen.getByRole("status").textContent).toContain("Loading Agent Files…");
    await act(async () => resolveFirst(paginated([
      artifact({ id: "artifact:old", mimeType: "image/png", storageUri: "space-artifact://agent-files/old.png", metadata: { source: "AGENT_OUTPUT", originalFilename: "Old room.png" } }),
      artifact({ id: "artifact:elsewhere", roomId: "room:elsewhere", mimeType: "text/plain", storageUri: "space-artifact://agent-files/elsewhere.txt", metadata: { source: "AGENT_OUTPUT", originalFilename: "Other room.txt" } }),
      artifact({ id: "artifact:orphan", roomId: null, mimeType: "text/plain", storageUri: "space-artifact://agent-files/orphan.txt", metadata: { source: "AGENT_OUTPUT", originalFilename: "Deleted room.txt" } })
    ])));
    expect(list).toHaveBeenCalledWith({ collection: "AGENT_FILES", pageSize: 100, sortOrder: "desc" });
    expect(screen.getByText("Other room.txt")).toBeTruthy();
    expect(screen.getByText("Deleted room.txt")).toBeTruthy();
    expect(summaryText(container)).toBe("3 files in all rooms");
    fireEvent.click(screen.getByRole("button", { name: "Preview Old room.png" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    rerender(<AgentFilesDock activeRoom={{ ...room, id: "room:next", name: "Next" }} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("Old room.png")).toBeTruthy();
    expect(screen.getByText("Other room.txt")).toBeTruthy();
    expect(list).toHaveBeenCalledTimes(1);
    // Clear all deletes only the active room's files, so it stays off in a room without files of its own.
    expect((screen.getByRole("button", { name: "Clear all Agent Files" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps folders that were stored per room before Agent Files were shared", async () => {
    localStorage.setItem("space_agent_files_custom_folders_room:a", JSON.stringify(["Releases"]));
    localStorage.setItem("space_agent_files_custom_folders_room:b", JSON.stringify(["Docs", "Releases"]));
    localStorage.setItem("space_agent_files_folder_map_room:b", JSON.stringify({ "artifact:apk": "Releases" }));
    vi.spyOn(liveRuntime.api, "artifacts").mockResolvedValue(paginated([
      artifact({ id: "artifact:apk", mimeType: "application/octet-stream", storageUri: "space-artifact://agent-files/app.apk", metadata: { source: "AGENT_OUTPUT", originalFilename: "app.apk" } })
    ]));
    render(<AgentFilesDock activeRoom={room} />);
    expect(await screen.findByText("app.apk")).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Docs/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /Releases/ }));
    expect(screen.getByText("app.apk")).toBeTruthy();
  });

  it("shows a late upload after a room switch, because Agent Files are shared", async () => {
    let resolveUpload!: (value: Awaited<ReturnType<typeof liveRuntime.api.uploadAgentFiles>>) => void;
    vi.spyOn(liveRuntime.api, "artifacts").mockResolvedValue(paginated([]));
    vi.spyOn(liveRuntime.api, "uploadAgentFiles").mockImplementationOnce(() => new Promise((resolve) => { resolveUpload = resolve; }));
    const { container, rerender } = render(<AgentFilesDock activeRoom={room} />);
    await screen.findByRole("button", { name: "Upload files" });
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [new File(["hello"], "old.txt")] } });
    rerender(<AgentFilesDock activeRoom={{ ...room, id: "room:next" }} />);
    await act(async () => resolveUpload({ artifacts: [artifact({ id: "artifact:late", mimeType: "text/plain", storageUri: "space-artifact://agent-files/old.txt", metadata: { source: "AGENT_OUTPUT", originalFilename: "Late old file.txt" } })] }));
    expect(screen.getByText("Late old file.txt")).toBeTruthy();
  });

  it("shows a retry after a failed initial load instead of claiming the room is empty", async () => {
    vi.spyOn(liveRuntime.api, "artifacts").mockRejectedValueOnce(new Error("Network unavailable")).mockResolvedValueOnce(paginated([]));
    render(<AgentFilesDock activeRoom={room} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Files could not be loaded");
    expect(alert.textContent).toContain("Network unavailable");
    expect(alert.querySelector(".dock-kit-state-icon svg")).toBeTruthy();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.queryByText("Drop files here or use the upload button to add files.")).toBeNull();
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "Upload files" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows real filenames and provenance, previews text and DOCX safely, and adds new Agent Files of any room", async () => {
    const textFile = artifact({
      id: "artifact:text",
      mimeType: "text/plain",
      storageUri: "space-artifact://agent-files/room/pane/session/2026-07-29/final.txt"
    });
    const docxFile = artifact({
      id: "artifact:docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      storageUri: "space-artifact://agent-files/room/pane/session/2026-07-29/resume.docx",
      metadata: {
        source: "AGENT_OUTPUT",
        originalFilename: "Complete Space Resume.docx",
        runtimeId: "cli:claude",
        cliSessionId: "cli_session:docx",
        previewKind: "DOCX"
      },
      createdAt: "2026-07-29T09:00:00.000Z"
    });
    const mediaInput = artifact({
      id: "artifact:input",
      mimeType: "text/plain",
      storageUri: "space-artifact://cli-uploads/room/pane/session/2026-07-29/input.txt",
      metadata: { source: "USER_UPLOAD", originalFilename: "input.txt" }
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = init?.method ?? "GET";
        if (method === "GET" && url === listUrl) {
          return { ok: true, status: 200, json: async () => paginated([textFile, docxFile, mediaInput]) };
        }
        if (method === "GET" && url === "/api/artifacts/artifact%3Atext/preview") {
          return { ok: true, status: 200, text: async () => "<b>escaped text</b>" };
        }
        throw new Error(`Missing fixture for ${method} ${url}`);
      })
    );

    render(<AgentFilesDock activeRoom={room} />);

    expect(await screen.findByText("Complete Space Resume.docx")).toBeTruthy();
    expect(screen.getByText("final.txt")).toBeTruthy();
    expect(screen.getByText("Claude")).toBeTruthy();
    expect(screen.getByText("Codex")).toBeTruthy();
    expect(document.body.textContent).not.toContain("pane:codex");
    expect(screen.queryByText("input.txt")).toBeNull();
    expect(screen.getByRole("button", { name: "Download Complete Space Resume.docx" }).getAttribute("title"))
      .toBe("Download and verify Complete Space Resume.docx");

    fireEvent.click(screen.getByRole("button", { name: "Preview final.txt" }));
    expect(await screen.findByText("<b>escaped text</b>")).toBeTruthy();
    expect(screen.queryByText("escaped text")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close Agent File preview" }));

    fireEvent.click(screen.getByRole("button", { name: "Preview Complete Space Resume.docx" }));
    const iframe = await screen.findByTitle("Preview of Complete Space Resume.docx");
    expect(iframe.getAttribute("src")).toBe("/api/artifacts/artifact%3Adocx/preview");
    expect(iframe.getAttribute("sandbox")).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Close Agent File preview" }));

    const newFile = artifact({
      id: "artifact:new",
      mimeType: "application/pdf",
      storageUri: "space-artifact://agent-files/room/pane/session/2026-07-29/report.pdf",
      metadata: {
        source: "AGENT_OUTPUT",
        originalFilename: "report.pdf",
        runtimeId: "cli:codex",
        previewKind: "PDF"
      }
    });
    act(() => {
      window.dispatchEvent(new CustomEvent("space:artifacts-updated", {
        detail: { roomId: "room:other", artifacts: [{ ...newFile, roomId: "room:other" }] }
      }));
    });
    expect(await screen.findByText("report.pdf")).toBeTruthy();
  });

  it("starts a drag on Agent File cards with the artifact payload so they drop into CLI and chat panes", async () => {
    const textFile = artifact({
      id: "artifact:text",
      mimeType: "text/plain",
      storageUri: "space-artifact://agent-files/room/pane/session/2026-07-29/final.txt"
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = init?.method ?? "GET";
        if (method === "GET" && url === listUrl) {
          return { ok: true, status: 200, json: async () => paginated([textFile]) };
        }
        throw new Error(`Missing fixture for ${method} ${url}`);
      })
    );

    render(<AgentFilesDock activeRoom={room} />);

    const card = await screen.findByRole("listitem", { name: "Drag final.txt" });
    const setData = vi.fn();
    const dataTransfer = { setData, effectAllowed: "" } as unknown as DataTransfer;
    fireEvent.dragStart(card, { dataTransfer });
    expect(setData).toHaveBeenCalledWith(
      SPACE_ARTIFACT_MIME,
      JSON.stringify({ id: "artifact:text", name: "final.txt", mimeType: "text/plain" })
    );
    expect(setData).toHaveBeenCalledWith("text/uri-list", "/api/artifacts/artifact%3Atext/file");
    expect(dataTransfer.effectAllowed).toBe("copy");
  });

  it("verifies download size, type, and hash before using the Windows file picker", async () => {
    const body = new TextEncoder().encode("verified-docx-bytes");
    const expectedSha256 = "b".repeat(64);
    const docxFile = artifact({
      id: "artifact:verified-docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      storageUri: "space-artifact://agent-files/room/pane/session/2026-07-29/verified.docx",
      byteSize: body.byteLength,
      sha256: expectedSha256,
      metadata: {
        source: "AGENT_OUTPUT",
        originalFilename: "verified.docx",
        runtimeId: "cli:codex",
        cliSessionId: "cli_session:verified",
        previewKind: "DOCX"
      }
    });
    const write = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const createWritable = vi.fn(async () => ({ write, close }));
    const showSaveFilePicker = vi.fn(async () => ({ createWritable }));
    vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
    Object.defineProperty(window, "showSaveFilePicker", {
      configurable: true,
      value: showSaveFilePicker
    });
    vi.stubGlobal("crypto", {
      subtle: {
        digest: vi.fn(async () => Uint8Array.from(Buffer.from(expectedSha256, "hex")).buffer)
      }
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = init?.method ?? "GET";
        if (method === "GET" && url === listUrl) {
          return { ok: true, status: 200, json: async () => paginated([docxFile]) };
        }
        if (method === "GET" && url === "/api/artifacts/artifact%3Averified-docx/download") {
          return {
            ok: true,
            status: 200,
            headers: {
              get: (name: string) => {
                if (name.toLowerCase() === "content-length") return String(body.byteLength);
                if (name.toLowerCase() === "content-type") return docxFile.mimeType;
                return null;
              }
            },
            arrayBuffer: async () => body.buffer
          };
        }
        throw new Error(`Missing fixture for ${method} ${url}`);
      })
    );

    render(<AgentFilesDock activeRoom={room} />);
    fireEvent.click(await screen.findByRole("button", { name: "Download verified.docx" }));

    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(showSaveFilePicker).toHaveBeenCalledWith(expect.objectContaining({
      suggestedName: "verified.docx"
    }));
    expect(write).toHaveBeenCalledWith(expect.any(Blob));
    expect(screen.queryByText(/verification failed/i)).toBeNull();
  });

  it("supports individual deletion, room clear, refresh, and fullscreen", async () => {
    let files = [
      artifact({
        id: "artifact:first",
        mimeType: "text/plain",
        storageUri: "space-artifact://agent-files/room/pane/session/2026-07-29/first.txt",
        metadata: { source: "AGENT_OUTPUT", originalFilename: "first.txt", previewKind: "TEXT" }
      }),
      artifact({
        id: "artifact:second",
        mimeType: "application/pdf",
        storageUri: "space-artifact://agent-files/room/pane/session/2026-07-29/second.pdf",
        metadata: { source: "AGENT_OUTPUT", originalFilename: "second.pdf", previewKind: "PDF" }
      })
    ];
    const requests: string[] = [];
    const nativeConfirm = vi.fn(() => true);
    vi.stubGlobal("confirm", nativeConfirm);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = init?.method ?? "GET";
        requests.push(`${method} ${url}`);
        if (url === "/api/auth/csrf") {
          return { ok: true, status: 200, json: async () => ({ csrfToken: "csrf:test", headerName: csrfHeaderName }) };
        }
        if (method === "GET" && url === listUrl) {
          return { ok: true, status: 200, json: async () => paginated(files) };
        }
        if (method === "DELETE" && url === "/api/artifacts/artifact%3Afirst") {
          files = files.filter((file) => file.id !== "artifact:first");
          return { ok: true, status: 200, json: async () => ({ ok: true, artifactId: "artifact:first" }) };
        }
        if (method === "DELETE" && url === clearUrl) {
          const matchedCount = files.length;
          files = [];
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              roomId: room.id,
              matchedCount,
              deletedCount: matchedCount,
              failedCount: 0,
              failedArtifactIds: []
            })
          };
        }
        throw new Error(`Missing fixture for ${method} ${url}`);
      })
    );

    const { container } = render(<AgentFilesDock activeRoom={room} />);
    await waitFor(() => expect(summaryText(container)).toBe("2 files in all rooms"));
    expect(screen.queryByRole("heading", { name: "Agent Files" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open Agent Files fullscreen" }));
    expect(container.querySelector(".agent-files-dock-shell")?.classList.contains("is-fullscreen")).toBe(true);
    expect(screen.getByRole("heading", { name: "Agent Files" })).toBeTruthy();
    const exitFullscreen = screen.getByRole("button", { name: "Exit Agent Files fullscreen" });
    expect(exitFullscreen.classList.contains("dock-fullscreen-toggle")).toBe(true);
    expect(exitFullscreen.classList.contains("is-active")).toBe(true);
    fireEvent.click(exitFullscreen);

    fireEvent.click(screen.getByRole("button", { name: "Delete first.txt" }));
    const deleteDialog = screen.getByRole("alertdialog", { name: "Delete this file?" });
    fireEvent.click(within(deleteDialog).getByRole("button", { name: "Cancel" }));
    expect(requests).not.toContain("DELETE /api/artifacts/artifact%3Afirst");
    fireEvent.click(screen.getByRole("button", { name: "Delete first.txt" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(requests).toContain("DELETE /api/artifacts/artifact%3Afirst"));
    await waitFor(() => expect(screen.queryByText("first.txt")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Refresh Agent Files" }));
    await waitFor(() => expect(requests.filter((request) => request === `GET ${listUrl}`).length).toBeGreaterThan(1));

    await waitFor(() => expect((screen.getByRole("button", { name: "Clear all Agent Files" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Clear all Agent Files" }));
    const clearDialog = screen.getByRole("alertdialog", { name: "Clear all Agent Files?" });
    expect(clearDialog.textContent).toContain("the 1 Agent File from Deliverables");
    expect(clearDialog.textContent).toContain("Files from other rooms stay.");
    fireEvent.click(within(clearDialog).getByRole("button", { name: "Clear all" }));
    await waitFor(() => expect(requests).toContain(`DELETE ${clearUrl}`));
    expect(await screen.findByText("Drop files here or use the upload button to add files.")).toBeTruthy();
    expect(nativeConfirm).not.toHaveBeenCalled();
  });

  it("uploads operator files via the picker and drag-and-drop and surfaces failures", async () => {
    const uploadUrl = "/api/rooms/room%3Aagent-files/agent-files/uploads";
    const uploadedArtifact = artifact({
      id: "artifact:uploaded",
      paneId: null,
      mimeType: "text/plain",
      storageUri: "space-artifact://agent-files/room/user/browser/2026-08-21/uploaded.txt",
      metadata: {
        source: "USER_UPLOAD",
        originalFilename: "uploaded.txt",
        runtimeId: "user",
        previewKind: "TEXT"
      }
    });
    let uploadCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = init?.method ?? "GET";
        if (url === "/api/auth/csrf") {
          return { ok: true, status: 200, json: async () => ({ csrfToken: "csrf:test", headerName: csrfHeaderName }) };
        }
        if (method === "GET" && url === listUrl) {
          return { ok: true, status: 200, json: async () => paginated([]) };
        }
        if (method === "POST" && url === uploadUrl) {
          uploadCalls += 1;
          if (uploadCalls === 2) {
            return { ok: false, status: 422, json: async () => ({ error: { code: "EMPTY_UPLOAD", message: "Upload at least one Agent File." } }) };
          }
          return { ok: true, status: 200, json: async () => ({ artifacts: [uploadedArtifact] }) };
        }
        throw new Error(`Missing fixture for ${method} ${url}`);
      })
    );

    const { container } = render(<AgentFilesDock activeRoom={room} />);
    expect(await screen.findByText("Drop files here or use the upload button to add files.")).toBeTruthy();

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(fileInput).toBeTruthy();
    const firstFile = new File(["operator content"], "uploaded.txt", { type: "text/plain" });
    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [firstFile] } });
    });
    expect(await screen.findByText("uploaded.txt")).toBeTruthy();
    expect(screen.getByText("Uploaded by you")).toBeTruthy();
    expect(uploadCalls).toBe(1);

    const dockPanel = container.querySelector(".agent-files-dock") as HTMLElement;
    const secondFile = new File(["dropped content"], "dropped.txt", { type: "text/plain" });
    await act(async () => {
      fireEvent.drop(dockPanel, {
        dataTransfer: { files: [secondFile], types: ["Files"] }
      });
    });
    await waitFor(() => expect(uploadCalls).toBe(2));
    expect(await screen.findByText(/Upload at least one Agent File|upload failed/i)).toBeTruthy();
    expect(dockPanel.classList.contains("is-dragover")).toBe(false);
    // Errors are dismissible notices.
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Dismiss message" }));
    expect(screen.queryByText(/Upload at least one Agent File|upload failed/i)).toBeNull();
  });

  it("supports folder filtering, custom folders, and moving files between folders", async () => {
    const files = [
      artifact({
        id: "artifact:graphic1",
        mimeType: "image/png",
        storageUri: "space-artifact://agent-files/logo.png",
        metadata: { source: "AGENT_OUTPUT", originalFilename: "logo.png", previewKind: "IMAGE" }
      }),
      artifact({
        id: "artifact:doc1",
        mimeType: "application/pdf",
        storageUri: "space-artifact://agent-files/spec.pdf",
        metadata: { source: "AGENT_OUTPUT", originalFilename: "spec.pdf", previewKind: "PDF" }
      })
    ];
    vi.spyOn(liveRuntime.api, "artifacts").mockResolvedValue(paginated(files));
    render(<AgentFilesDock activeRoom={room} />);
    expect(await screen.findByText("logo.png")).toBeTruthy();
    expect(screen.getByText("spec.pdf")).toBeTruthy();

    // Click on Graphics folder tab
    const graphicsTab = screen.getByRole("tab", { name: /Graphics/i });
    fireEvent.click(graphicsTab);

    // Only logo.png is shown
    expect(screen.getByText("logo.png")).toBeTruthy();
    expect(screen.queryByText("spec.pdf")).toBeNull();

    // Click on All files tab
    const allTab = screen.getByRole("tab", { name: /All files/i });
    fireEvent.click(allTab);
    expect(screen.getByText("spec.pdf")).toBeTruthy();

    // Create a new folder
    fireEvent.click(screen.getByRole("button", { name: "Create new folder" }));
    const folderInput = screen.getByPlaceholderText(/Folder name/i);
    fireEvent.change(folderInput, { target: { value: "My Branding" } });
    fireEvent.click(screen.getByRole("button", { name: "Create folder" }));

    // Verify folder tab exists
    expect(await screen.findByRole("tab", { name: /My Branding/i })).toBeTruthy();

    // Switch to All files tab to view files
    fireEvent.click(screen.getByRole("tab", { name: /All files/i }));

    // Move logo.png to My Branding
    const moveBtn = screen.getByRole("button", { name: "Move logo.png to folder" });
    fireEvent.click(moveBtn);
    const brandingOption = screen.getByRole("button", { name: /My Branding/i });
    fireEvent.click(brandingOption);

    // Switch to My Branding tab
    fireEvent.click(screen.getByRole("tab", { name: /My Branding/i }));
    expect(screen.getByText("logo.png")).toBeTruthy();
    expect(screen.queryByText("spec.pdf")).toBeNull();
  });

  it("supports hierarchical subfolders across all folders, subfolder chips, breadcrumbs, and parent/child counts", async () => {
    const files = [
      artifact({
        id: "artifact:apk1",
        mimeType: "application/vnd.android.package-archive",
        storageUri: "space-artifact://agent-files/app.apk",
        metadata: { source: "AGENT_OUTPUT", originalFilename: "app.apk", folder: "App Versions/android" }
      }),
      artifact({
        id: "artifact:exe1",
        mimeType: "application/octet-stream",
        storageUri: "space-artifact://agent-files/setup.exe",
        metadata: { source: "AGENT_OUTPUT", originalFilename: "setup.exe", folder: "App Versions/windows" }
      }),
      artifact({
        id: "artifact:deb1",
        mimeType: "application/octet-stream",
        storageUri: "space-artifact://agent-files/app.deb",
        metadata: { source: "AGENT_OUTPUT", originalFilename: "app.deb", folder: "App Versions/linux" }
      }),
      artifact({
        id: "artifact:logo1",
        mimeType: "image/svg+xml",
        storageUri: "space-artifact://agent-files/logo.svg",
        metadata: { source: "AGENT_OUTPUT", originalFilename: "logo.svg", folder: "Logos" }
      })
    ];
    vi.spyOn(liveRuntime.api, "artifacts").mockResolvedValue(paginated(files));
    render(<AgentFilesDock activeRoom={room} />);

    // Verify top-level tabs: Logos and App Versions exist
    expect(await screen.findByRole("tab", { name: /Logos/i })).toBeTruthy();
    const appVersionsTab = screen.getByRole("tab", { name: /App Versions/i });
    expect(appVersionsTab).toBeTruthy();

    // App Versions total count aggregates all subfolders (1 + 1 + 1 = 3)
    expect(appVersionsTab.textContent).toContain("3");

    // Click into Logos
    fireEvent.click(screen.getByRole("tab", { name: /Logos/i }));
    expect(screen.getByText("logo.svg")).toBeTruthy();
    expect(screen.queryByText("app.apk")).toBeNull();

    // Click into App Versions
    fireEvent.click(screen.getByRole("tab", { name: /App Versions/i }));
    // All 3 release files are displayed under App Versions
    expect(screen.getByText("app.apk")).toBeTruthy();
    expect(screen.getByText("setup.exe")).toBeTruthy();
    expect(screen.getByText("app.deb")).toBeTruthy();
    expect(screen.queryByText("logo.svg")).toBeNull();

    // Subfolders bar shows: All in App Versions, android, windows, linux
    expect(screen.getByRole("tab", { name: /All in App Versions/i })).toBeTruthy();
    const androidSubTab = screen.getByRole("tab", { name: /android/i });
    expect(androidSubTab).toBeTruthy();

    // Click into android subfolder
    fireEvent.click(androidSubTab);
    expect(screen.getByText("app.apk")).toBeTruthy();
    expect(screen.queryByText("setup.exe")).toBeNull();
    expect(screen.queryByText("app.deb")).toBeNull();

    // Breadcrumbs show: All files > App Versions > android
    const breadcrumbNav = screen.getByRole("navigation", { name: "Folder navigation" });
    expect(breadcrumbNav).toBeTruthy();
    expect(breadcrumbNav.textContent).toContain("All files");
    expect(breadcrumbNav.textContent).toContain("App Versions");
    expect(breadcrumbNav.textContent).toContain("android");

    // Click "Up to App Versions"
    fireEvent.click(screen.getByRole("button", { name: /Up to App Versions/i }));
    expect(screen.getByText("setup.exe")).toBeTruthy();

    // Create a subfolder inside Logos with the one "New folder" entry
    fireEvent.click(screen.getByRole("tab", { name: /Logos/i }));
    expect(screen.queryByRole("button", { name: /Add subfolder/i })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Create new folder" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Create new folder" }));
    const parentSelect = screen.getByRole("combobox", { name: "Parent folder" });
    expect(parentSelect).toHaveProperty("value", "Logos");
    const subfolderInput = screen.getByPlaceholderText(/Subfolder name inside Logos/i);
    fireEvent.change(subfolderInput, { target: { value: "Vector" } });
    fireEvent.click(screen.getByRole("button", { name: "Create subfolder" }));

    // Verify subfolder Vector exists
    expect(await screen.findByRole("tab", { name: /Vector/i })).toBeTruthy();
  });

  it("supports toggling between icons grid view and list view and thumbnail previews", async () => {
    const files = [
      artifact({
        id: "artifact:graphic1",
        mimeType: "image/png",
        storageUri: "space-artifact://agent-files/logo.png",
        metadata: { source: "AGENT_OUTPUT", originalFilename: "logo.png", previewKind: "IMAGE" }
      })
    ];
    vi.spyOn(liveRuntime.api, "artifacts").mockResolvedValue(paginated(files));
    const { container } = render(<AgentFilesDock activeRoom={room} />);
    expect(await screen.findByText("logo.png")).toBeTruthy();

    // Starts in grid view by default
    expect(container.querySelector(".agent-files-items.is-grid")).toBeTruthy();
    const img = container.querySelector(".agent-files-item.is-grid .agent-files-item-thumb-img");
    expect(img).toBeTruthy();
    expect(img?.getAttribute("loading")).toBe("lazy");
    expect(img?.getAttribute("decoding")).toBe("async");

    // One view toggle with a clear list icon (not a filter icon)
    const viewSwitch = screen.getByRole("button", { name: "Switch to list view" });
    expect(viewSwitch.querySelector("svg")?.getAttribute("data-app-icon")).toBe("List");
    fireEvent.click(viewSwitch);
    expect(container.querySelector(".agent-files-items.is-grid")).toBeNull();
    expect(container.querySelector(".agent-files-item.is-list .agent-files-item-thumb-img")).toBeTruthy();
    const gridSwitch = screen.getByRole("button", { name: "Switch to grid view" });
    expect(gridSwitch.querySelector("svg")?.getAttribute("data-app-icon")).toBe("Grid2X2");
    expect(localStorage.getItem("space_agent_files_view_mode")).toBe("list");

    // Toggle previews off
    const previewsToggle = screen.getByRole("switch", { name: "Previews" });
    fireEvent.click(previewsToggle);
    expect(container.querySelector(".agent-files-item-thumb-img")).toBeNull();
    fireEvent.click(gridSwitch);
    expect(container.querySelector(".agent-files-items.is-grid")).toBeTruthy();
  });

  it("supports date filtering with presets, custom range, and active filter badge", async () => {
    const now = new Date("2026-10-04T12:00:00.000Z");
    vi.setSystemTime(now);

    const files = [
      artifact({
        id: "artifact:recent",
        mimeType: "text/plain",
        storageUri: "space-artifact://agent-files/recent.txt",
        metadata: { source: "AGENT_OUTPUT", originalFilename: "recent.txt" },
        createdAt: "2026-10-04T11:30:00.000Z"
      }),
      artifact({
        id: "artifact:today",
        mimeType: "text/plain",
        storageUri: "space-artifact://agent-files/today.txt",
        metadata: { source: "AGENT_OUTPUT", originalFilename: "today.txt" },
        createdAt: "2026-10-04T10:00:00.000Z"
      }),
      artifact({
        id: "artifact:yesterday",
        mimeType: "text/plain",
        storageUri: "space-artifact://agent-files/yesterday.txt",
        metadata: { source: "AGENT_OUTPUT", originalFilename: "yesterday.txt" },
        createdAt: "2026-10-03T10:00:00.000Z"
      }),
      artifact({
        id: "artifact:lastweek",
        mimeType: "text/plain",
        storageUri: "space-artifact://agent-files/lastweek.txt",
        metadata: { source: "AGENT_OUTPUT", originalFilename: "lastweek.txt" },
        createdAt: "2026-09-28T10:00:00.000Z"
      }),
      artifact({
        id: "artifact:old",
        mimeType: "text/plain",
        storageUri: "space-artifact://agent-files/old.txt",
        metadata: { source: "AGENT_OUTPUT", originalFilename: "old.txt" },
        createdAt: "2026-07-01T10:00:00.000Z"
      })
    ];
    vi.spyOn(liveRuntime.api, "artifacts").mockResolvedValue(paginated(files));

    const { container } = render(<AgentFilesDock activeRoom={room} />);
    expect(await screen.findByText("recent.txt")).toBeTruthy();
    expect(screen.getByText("today.txt")).toBeTruthy();
    expect(screen.getByText("yesterday.txt")).toBeTruthy();
    expect(screen.getByText("lastweek.txt")).toBeTruthy();
    expect(screen.getByText("old.txt")).toBeTruthy();

    openFilters();
    const dateSelect = screen.getByRole("combobox", { name: "Filter Agent Files by date" });
    expect(dateSelect).toBeTruthy();

    // Filter by PAST_1H (recent.txt only)
    fireEvent.change(dateSelect, { target: { value: "PAST_1H" } });
    expect(screen.getByText("recent.txt")).toBeTruthy();
    expect(screen.queryByText("today.txt")).toBeNull();
    expect(screen.queryByText("yesterday.txt")).toBeNull();
    expect(summaryText(container)).toBe("1 of 5 files · Past 1 hour");
    expect(screen.getByRole("button", { name: "Filters (1 active)" })).toBeTruthy();
    expect(container.querySelector(".agent-files-filter-count")?.textContent).toBe("1");

    // Filter by PAST_6H (recent.txt and today.txt)
    fireEvent.change(dateSelect, { target: { value: "PAST_6H" } });
    expect(screen.getByText("recent.txt")).toBeTruthy();
    expect(screen.getByText("today.txt")).toBeTruthy();
    expect(screen.queryByText("yesterday.txt")).toBeNull();
    expect(summaryText(container)).toBe("2 of 5 files · Past 6 hours");

    // Filter by TODAY
    fireEvent.change(dateSelect, { target: { value: "TODAY" } });
    expect(screen.getByText("recent.txt")).toBeTruthy();
    expect(screen.getByText("today.txt")).toBeTruthy();
    expect(screen.queryByText("yesterday.txt")).toBeNull();
    expect(screen.queryByText("lastweek.txt")).toBeNull();
    expect(screen.queryByText("old.txt")).toBeNull();

    // One "Clear filters" resets the type and date filters
    expect(summaryText(container)).toBe("2 of 5 files · Today");
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByRole("button", { name: "Filters" })).toBeTruthy();
    expect(screen.getByText("yesterday.txt")).toBeTruthy();
    expect(screen.getByText("old.txt")).toBeTruthy();

    // Filter by PAST_7D
    fireEvent.change(dateSelect, { target: { value: "PAST_7D" } });
    expect(screen.getByText("today.txt")).toBeTruthy();
    expect(screen.getByText("yesterday.txt")).toBeTruthy();
    expect(screen.getByText("lastweek.txt")).toBeTruthy();
    expect(screen.queryByText("old.txt")).toBeNull();

    // Select CUSTOM range
    fireEvent.change(dateSelect, { target: { value: "CUSTOM" } });
    const fromInput = screen.getByLabelText("Filter from date");
    const toInput = screen.getByLabelText("Filter to date");
    expect(fromInput).toBeTruthy();
    expect(toInput).toBeTruthy();

    // Pick 2026-10-02 to 2026-10-03
    fireEvent.change(fromInput, { target: { value: "2026-10-02" } });
    fireEvent.change(toInput, { target: { value: "2026-10-03" } });
    expect(screen.getByText("yesterday.txt")).toBeTruthy();
    expect(screen.queryByText("today.txt")).toBeNull();
    expect(screen.queryByText("lastweek.txt")).toBeNull();

    expect(summaryText(container)).toBe("1 of 5 files · 2026-10-02 – 2026-10-03");

    // Clear date range via button
    fireEvent.click(screen.getByRole("button", { name: "Clear date range" }));
    expect(fromInput).toHaveProperty("value", "");
    expect(toInput).toHaveProperty("value", "");

    vi.useRealTimers();
  });

  it("instantly hydrates from cache and reuses cached files within TTL", async () => {
    const files = [
      artifact({ id: "artifact:cached", mimeType: "image/png", storageUri: "space-artifact://agent-files/cached.png", metadata: { source: "AGENT_OUTPUT", originalFilename: "CachedImage.png" } })
    ];
    const listSpy = vi.spyOn(liveRuntime.api, "artifacts").mockResolvedValue(paginated(files));

    // First mount fetches from API
    const { unmount } = render(<AgentFilesDock activeRoom={room} />);
    expect(await screen.findByText("CachedImage.png")).toBeTruthy();
    expect(listSpy).toHaveBeenCalledTimes(1);

    // Unmount dock (simulating user switching to another dock/surface)
    unmount();

    // Re-mount dock immediately (simulating user opening Agent Files again)
    render(<AgentFilesDock activeRoom={room} />);
    // Files are immediately present on initial render without waiting for API
    expect(screen.getByText("CachedImage.png")).toBeTruthy();
    // No redundant API call within cache TTL
    expect(listSpy).toHaveBeenCalledTimes(1);

    // Clicking refresh forces a reload from the API
    fireEvent.click(screen.getByRole("button", { name: "Refresh Agent Files" }));
    await waitFor(() => expect(listSpy).toHaveBeenCalledTimes(2));
  });

  it("shows smart folder labels, never their ids, for subfolders of smart folders", async () => {
    const files = [
      artifact({ id: "artifact:logo", mimeType: "image/png", storageUri: "space-artifact://agent-files/logo.png", metadata: { source: "AGENT_OUTPUT", originalFilename: "logo.png", previewKind: "IMAGE" } })
    ];
    vi.spyOn(liveRuntime.api, "artifacts").mockResolvedValue(paginated(files));
    const { container } = render(<AgentFilesDock activeRoom={room} />);
    expect(await screen.findByText("logo.png")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: /Graphics/ }));
    fireEvent.click(screen.getByRole("button", { name: "Create new folder" }));
    expect(screen.getByRole("combobox", { name: "Parent folder" })).toHaveProperty("value", "GRAPHICS");
    fireEvent.change(screen.getByPlaceholderText(/Subfolder name inside Graphics/), { target: { value: "Icons" } });
    fireEvent.click(screen.getByRole("button", { name: "Create subfolder" }));

    const breadcrumbNav = screen.getByRole("navigation", { name: "Folder navigation" });
    expect(breadcrumbNav.textContent).toContain("Graphics");
    expect(breadcrumbNav.textContent).toContain("Icons");
    expect(breadcrumbNav.textContent).not.toContain("GRAPHICS");
    expect(within(breadcrumbNav).getByRole("button", { name: "Icons" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("tab", { name: /All in Graphics/ })).toBeTruthy();

    // The move dialog and folder pickers show readable paths too.
    fireEvent.click(screen.getByRole("tab", { name: /All files/ }));
    fireEvent.click(screen.getByRole("button", { name: "Move logo.png to folder" }));
    const dialog = screen.getByRole("dialog", { name: "Move logo.png to folder" });
    expect(dialog.textContent).toContain("Graphics / Icons");
    expect(dialog.textContent).not.toContain("GRAPHICS");
    fireEvent.click(within(dialog).getByRole("button", { name: /Icons/ }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(container.textContent).not.toContain("GRAPHICS");
  });

  it("names the producing pane by its title and never shows raw pane ids", async () => {
    const files = [
      artifact({ id: "artifact:known", mimeType: "text/plain", storageUri: "space-artifact://agent-files/known.txt", metadata: { source: "AGENT_OUTPUT", originalFilename: "known.txt", runtimeId: "cli:codex", previewKind: "TEXT" } }),
      artifact({ id: "artifact:unknown", paneId: "pane:gone", mimeType: "text/plain", storageUri: "space-artifact://agent-files/unknown.txt", metadata: { source: "AGENT_OUTPUT", originalFilename: "unknown.txt", runtimeId: "cli:gemini", previewKind: "TEXT" } }),
      artifact({ id: "artifact:room", paneId: null, mimeType: "text/plain", storageUri: "space-artifact://agent-files/room.txt", metadata: { source: "AGENT_OUTPUT", originalFilename: "room.txt", previewKind: "TEXT" } })
    ];
    vi.spyOn(liveRuntime.api, "artifacts").mockResolvedValue(paginated(files));
    const { container } = render(<AgentFilesDock activeRoom={room} paneTitles={{ "pane:codex": "Main CLI" }} />);
    expect(await screen.findByText("Codex · Main CLI")).toBeTruthy();
    expect(screen.getByText("Gemini")).toBeTruthy();
    expect(screen.getByText("Agent · Room deliverable")).toBeTruthy();
    expect(container.textContent).not.toMatch(/Pane pane:|pane:gone|pane:codex/);
  });

  it("confirms folder deletion inside the app and keeps the files", async () => {
    const nativeConfirm = vi.fn(() => true);
    vi.stubGlobal("confirm", nativeConfirm);
    const files = [
      artifact({ id: "artifact:apk", mimeType: "application/octet-stream", storageUri: "space-artifact://agent-files/app.apk", metadata: { source: "AGENT_OUTPUT", originalFilename: "app.apk" } })
    ];
    vi.spyOn(liveRuntime.api, "artifacts").mockResolvedValue(paginated(files));
    render(<AgentFilesDock activeRoom={room} />);
    expect(await screen.findByText("app.apk")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Create new folder" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Folder name" }), { target: { value: "Releases" } });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Folder name" }), { key: "Enter" });
    expect(screen.getByRole("tab", { name: /Releases/ }).getAttribute("aria-selected")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Delete Releases folder" }));
    const dialog = screen.getByRole("alertdialog", { name: "Delete this folder?" });
    expect(dialog.textContent).toContain("stay in Agent Files");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("tab", { name: /Releases/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Delete Releases folder" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete folder" }));
    await waitFor(() => expect(screen.queryByRole("tab", { name: /Releases/ })).toBeNull());
    expect(screen.getByRole("tab", { name: /All files/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("app.apk")).toBeTruthy();
    expect(nativeConfirm).not.toHaveBeenCalled();
  });

  it("closes dialogs before fullscreen on Escape and stops listening while the dock is hidden", async () => {
    const files = [
      artifact({ id: "artifact:pdf", mimeType: "application/pdf", storageUri: "space-artifact://agent-files/spec.pdf", metadata: { source: "AGENT_OUTPUT", originalFilename: "spec.pdf", previewKind: "PDF" } })
    ];
    vi.spyOn(liveRuntime.api, "artifacts").mockResolvedValue(paginated(files));
    const view = (active: boolean) => (
      <DockActiveContext.Provider value={active}>
        <AgentFilesDock activeRoom={room} />
      </DockActiveContext.Provider>
    );
    const { container, rerender } = render(view(true));
    expect(await screen.findByText("spec.pdf")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Open Agent Files fullscreen" }));
    fireEvent.click(screen.getByRole("button", { name: "Preview spec.pdf" }));
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Preview spec.pdf" }), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(container.querySelector(".agent-files-dock-shell.is-fullscreen")).toBeTruthy();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(container.querySelector(".agent-files-dock-shell.is-fullscreen")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Move spec.pdf to folder" }));
    expect(screen.getByRole("dialog", { name: "Move spec.pdf to folder" })).toBeTruthy();
    rerender(view(false));
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Move spec.pdf to folder" })).toBeTruthy();
    rerender(view(true));
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows a file's details: what a design shows, who made it and the metadata inside the file", async () => {
    const files = [
      artifact({ id: "artifact:design", mimeType: "image/png", storageUri: "space-artifact://agent-files/design-linkedin.png",
        metadata: { source: "USER_UPLOAD", originalFilename: "design-linkedin.png", folder: "GRAPHICS/Design", previewKind: "IMAGE" } })
    ];
    vi.spyOn(liveRuntime.api, "artifacts").mockResolvedValue(paginated(files));
    const metadata = vi.spyOn(liveRuntime.api, "artifactMetadata").mockResolvedValue({
      artifact: { id: "artifact:design", filename: "design-linkedin.png", mimeType: "image/png", byteSize: 206184, sha256: "c".repeat(64), createdAt: "2026-10-19T05:02:21.000Z",
        roomId: room.id, metadata: { source: "USER_UPLOAD", folder: "GRAPHICS/Design" } },
      image: { width: 1200, height: 627 },
      embedded: { Description: "6 AI models played chess. Zero checkmates.", Software: "SpaceApp Design", "spaceapp:design": "{}" },
      design: { formatId: "linkedin", description: "6 AI models played chess. Zero checkmates.", madeBy: { by: "AGENT", runtimeId: "cli:claude", model: "claude-opus-5-5" }, engine: "UPLOAD" }
    });
    const { container } = render(<DockActiveContext.Provider value><AgentFilesDock activeRoom={room} /></DockActiveContext.Provider>);
    expect(await screen.findByText("design-linkedin.png")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open Agent Files fullscreen" }));
    fireEvent.click(screen.getByRole("button", { name: "Details of design-linkedin.png" }));
    const dialog = await screen.findByRole("dialog", { name: "Details of design-linkedin.png" });
    expect(metadata).toHaveBeenCalledWith("artifact:design");
    expect(await within(dialog).findByText("6 AI models played chess. Zero checkmates.")).toBeTruthy();
    expect(within(dialog).getByText("claude-opus-5-5 · cli:claude")).toBeTruthy();
    expect(within(dialog).getByText(/1200 × 627 px · LinkedIn post \(matches the format\)/)).toBeTruthy();
    expect(within(dialog).getByText("Description, Software, spaceapp:design")).toBeTruthy();
    expect(within(dialog).getByText("USER_UPLOAD · GRAPHICS/Design")).toBeTruthy();
    // Escape closes the dialog first; fullscreen waits for the next Escape.
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(container.querySelector(".agent-files-dock-shell.is-fullscreen")).toBeTruthy();
  });

  it("leaves fullscreen when the dock is hidden", async () => {
    vi.spyOn(liveRuntime.api, "artifacts").mockResolvedValue(paginated([]));
    const view = (active: boolean) => (
      <DockActiveContext.Provider value={active}>
        <AgentFilesDock activeRoom={room} />
      </DockActiveContext.Provider>
    );
    const { container, rerender } = render(view(true));
    await screen.findByRole("button", { name: "Upload files" });
    fireEvent.click(screen.getByRole("button", { name: "Open Agent Files fullscreen" }));
    expect(container.querySelector(".agent-files-dock-shell.is-fullscreen")).toBeTruthy();
    rerender(view(false));
    expect(container.querySelector(".agent-files-dock-shell.is-fullscreen")).toBeNull();
  });

  it("keeps a Load more fallback at the end of long lists", async () => {
    const files = Array.from({ length: 45 }, (_, index) => artifact({
      id: `artifact:bulk-${String(index).padStart(2, "0")}`,
      mimeType: "text/plain",
      storageUri: `space-artifact://agent-files/bulk-${index}.txt`,
      metadata: { source: "AGENT_OUTPUT", originalFilename: `bulk-${index}.txt`, previewKind: "TEXT" }
    }));
    vi.spyOn(liveRuntime.api, "artifacts").mockResolvedValue(paginated(files));
    render(<AgentFilesDock activeRoom={room} />);
    await screen.findByText("bulk-44.txt");
    expect(screen.getAllByRole("listitem")).toHaveLength(40);
    expect(screen.queryByText("bulk-0.txt")).toBeNull();
    const more = screen.getByRole("button", { name: "Load more files (5 remaining)" });
    expect(more.classList.contains("dock-kit-button")).toBe(true);
    fireEvent.click(more);
    expect(screen.getAllByRole("listitem")).toHaveLength(45);
    expect(screen.getByText("bulk-0.txt")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Load more files/ })).toBeNull();
  });

  it("has responsive scoped CSS and no important overrides", () => {
    const agentFilesCss = readFileSync(resolve(__dirname, "../src/features/agent-files/agent-files-dock.css"), "utf8");
    const source = readFileSync(resolve(__dirname, "../src/features/agent-files/AgentFilesDock.tsx"), "utf8");

    expect(source).toContain('import "./agent-files-dock.css";');
    expect(source).not.toContain("window.confirm");
    expect(agentFilesCss).toContain("@media (max-width: 520px)");
    // File cards follow the dock's width, not the window's: a narrow dock on a wide screen squeezed names to "correc…".
    expect(agentFilesCss).toContain("container: agent-files / inline-size;");
    expect(agentFilesCss).toContain("@container agent-files (max-width: 32rem)");
    expect(agentFilesCss).toContain(".agent-files-modal-body");
    expect(agentFilesCss).not.toContain("!important");
  });
});

