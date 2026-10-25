import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Artifact, Room } from "@space/contracts";
import { MediaDock, clearMediaRoomCache } from "../src/features/media-dock/MediaDock.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";
import { SPACE_ARTIFACT_MIME } from "../src/features/artifacts/artifact-drag.js";
import {
  applyServerDateTimeSettings,
  defaultDateTimeSettings
} from "../src/features/date-time-settings/date-time-settings.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const csrfHeaderName = "x-space-csrf-token";
const mediaListUrl = "/api/artifacts?roomId=room%3Amedia&collection=ROOM_MEDIA&pageSize=100&sortOrder=desc";
const mediaPage2Url = "/api/artifacts?roomId=room%3Amedia&collection=ROOM_MEDIA&page=2&pageSize=100&sortOrder=desc";
const clearRoomMediaUrl = "/api/rooms/room%3Amedia/media";

const room: Room = {
  id: "room:media",
  name: "Media Room",
  description: null,
  kind: "WORKSPACE",
  order: 0,
  paneLayoutColumns: null,
  paneLayoutHeight: 1,
  paneCap: 16,
  traceId: "trace:media",
  archivedAt: null,
  createdAt: "2026-07-07T00:00:00.000Z",
  updatedAt: "2026-07-07T00:00:00.000Z"
};

function artifact(input: Partial<Artifact> & Pick<Artifact, "id" | "kind" | "mimeType" | "storageUri">): Artifact {
  return {
    roomId: room.id,
    paneId: null,
    turnId: null,
    workflowId: null,
    sha256: "a".repeat(64),
    byteSize: 2048,
    metadata: {},
    expiresAt: null,
    pinnedAt: null,
    deletedAt: null,
    createdAt: "2026-07-07T00:00:00.000Z",
    ...input
  };
}

function paginated(data: Artifact[], pagination: Partial<{ page: number; pageSize: number; totalItems: number; totalPages: number }> = {}) {
  return {
    data,
    pagination: { page: 1, pageSize: 100, totalItems: data.length, totalPages: data.length ? 1 : 0, ...pagination }
  };
}

const pastedImage = () => artifact({
  id: "artifact:image",
  kind: "IMAGE",
  mimeType: "image/png",
  storageUri: "space-artifact://user-uploads/room%3Amedia/2026-07-07/upload_1.png",
  metadata: { source: "CLIPBOARD", originalFilename: "image.png" },
  createdAt: "2026-07-07T00:00:00.000Z"
});

const uploadedVideo = () => artifact({
  id: "artifact:video",
  kind: "VIDEO",
  mimeType: "video/mp4",
  storageUri: "space-artifact://user-uploads/room%3Amedia/2026-07-07/capture.mp4",
  metadata: { source: "USER_UPLOAD", originalFilename: "capture.mp4" },
  createdAt: "2026-07-07T01:00:00.000Z"
});

const uploadedNote = () => artifact({
  id: "artifact:file",
  kind: "EXPORT",
  mimeType: "text/plain",
  storageUri: "space-artifact://cli-uploads/room%3Amedia/pane%3Aterminal/session%3A1/2026-07-07/note.txt",
  metadata: { source: "USER_UPLOAD", originalFilename: "note.txt" },
  createdAt: "2026-07-07T00:30:00.000Z"
});

const PASTED_TITLE = "Pasted image · 07/07/2026 00:00";

function stubMediaFetch(handler: (method: string, url: string) => unknown) {
  const requests: Array<{ method: string; url: string }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      requests.push({ method, url });
      if (url === "/api/auth/csrf") {
        return { ok: true, status: 200, json: async () => ({ csrfToken: "csrf:test", headerName: csrfHeaderName }) };
      }
      const result = handler(method, url);
      if (result === undefined) throw new Error(`Missing fixture for ${method} ${url}`);
      return result;
    })
  );
  return requests;
}

function okJson(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

beforeEach(() => {
  clearMediaRoomCache();
  installSpaceRuntime(liveRuntime);
});

afterEach(() => {
  applyServerDateTimeSettings(defaultDateTimeSettings);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("MediaDock", () => {
  it("requests only room media and shows newest first with stable, readable titles", async () => {
    const media = [
      pastedImage(),
      uploadedNote(),
      uploadedVideo(),
      artifact({
        id: "artifact:dom",
        kind: "DOM_SNAPSHOT",
        mimeType: "application/json",
        storageUri: "space-artifact://browser-evidence/capture/dom.json",
        metadata: { source: "SCREEN_CAPTURE", artifactFile: "dom.json" }
      }),
      artifact({
        id: "artifact:agent-file",
        kind: "IMAGE",
        mimeType: "image/png",
        storageUri: "space-artifact://agent-files/room%3Amedia/pane/session/2026-07-07/final.png",
        metadata: { source: "AGENT_OUTPUT", originalFilename: "final.png" }
      })
    ];
    const requests = stubMediaFetch((method, url) => (method === "GET" && url === mediaListUrl ? okJson(paginated(media)) : undefined));

    const { container } = render(<MediaDock activeRoom={room} />);

    const openButtons = await screen.findAllByRole("button", { name: /^Open (?!media fullscreen)/ });
    expect(openButtons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Open capture.mp4",
      "Open note.txt",
      `Open ${PASTED_TITLE}`
    ]);
    // Readable kinds, never raw enum values.
    const badges = Array.from(container.querySelectorAll(".media-dock-card .dock-kit-badge")).map((badge) => badge.textContent);
    expect(badges).toEqual(["Video", "File", "Pasted image"]);
    expect(container.textContent).not.toMatch(/\b(VIDEO|EXPORT|IMAGE|SCREENSHOT|DOM_SNAPSHOT)\b/);
    expect(screen.getAllByText("07/07/2026 01:00 · 2 KB")).toHaveLength(1);
    expect(screen.queryByText("dom.json")).toBeNull();
    expect(screen.queryByText("final.png")).toBeNull();
    expect((screen.getByAltText(PASTED_TITLE) as HTMLImageElement).getAttribute("src")).toBe("/api/artifacts/artifact%3Aimage/file");
    expect((screen.getByLabelText("capture.mp4") as HTMLVideoElement).getAttribute("src")).toBe("/api/artifacts/artifact%3Avideo/file");
    expect(container.querySelector(".dock-kit-summary")?.textContent).toBe("3 media items in this room");
    expect(requests.filter((request) => request.method === "GET").map((request) => request.url)).toEqual([mediaListUrl]);
  });

  it("keeps titles stable when newer media arrive", async () => {
    stubMediaFetch((method, url) => (method === "GET" && url === mediaListUrl ? okJson(paginated([uploadedNote()])) : undefined));
    render(<MediaDock activeRoom={room} />);
    expect(await screen.findByRole("button", { name: "Open note.txt" })).toBeTruthy();

    act(() => {
      window.dispatchEvent(new CustomEvent("space:artifacts-updated", {
        detail: {
          roomId: room.id,
          artifacts: [artifact({ ...uploadedNote(), id: "artifact:newer", metadata: { source: "USER_UPLOAD", originalFilename: "newer.txt" }, createdAt: "2026-07-08T00:00:00.000Z" })]
        }
      }));
    });

    expect(await screen.findByRole("button", { name: "Open newer.txt" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open note.txt" })).toBeTruthy();
  });

  it("formats times with the app date and time settings and follows changes", async () => {
    stubMediaFetch((method, url) => (method === "GET" && url === mediaListUrl ? okJson(paginated([uploadedNote()])) : undefined));
    render(<MediaDock activeRoom={room} />);
    expect(await screen.findByText("07/07/2026 00:30 · 2 KB")).toBeTruthy();

    act(() => {
      applyServerDateTimeSettings({ timeZone: "UTC", timeFormat: "24h", dateFormat: "YYYY-MM-DD" });
    });

    expect(await screen.findByText("2026-07-07 00:30 · 2 KB")).toBeTruthy();
  });

  it("shows a loading state on first load instead of the empty message", async () => {
    let resolveList!: (value: unknown) => void;
    stubMediaFetch((method, url) => (method === "GET" && url === mediaListUrl
      ? new Promise((resolve) => { resolveList = resolve; })
      : undefined));
    render(<MediaDock activeRoom={room} />);

    expect(screen.getByText("Loading media…")).toBeTruthy();
    expect(screen.queryByText("No media has been sent in this room yet.")).toBeNull();

    await act(async () => resolveList(okJson(paginated([]))));
    expect(await screen.findByText("No media has been sent in this room yet.")).toBeTruthy();
    expect(screen.queryByText("Loading media…")).toBeNull();
  });

  it("offers a retry when the first load fails and keeps items when a refresh fails", async () => {
    let calls = 0;
    stubMediaFetch((method, url) => {
      if (method !== "GET" || url !== mediaListUrl) return undefined;
      calls += 1;
      if (calls === 1 || calls === 3) return { ok: false, status: 503, json: async () => ({ error: { code: "UNAVAILABLE", message: "Media service unavailable" } }) };
      return okJson(paginated([uploadedNote()]));
    });
    render(<MediaDock activeRoom={room} />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Media could not be loaded");
    expect(alert.textContent).toContain("Media service unavailable");
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "Open note.txt" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Refresh media" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Media service unavailable");
    expect(screen.getByRole("button", { name: "Open note.txt" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss message" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not show the previous room's media while the next room loads", async () => {
    let resolveNext!: (value: unknown) => void;
    stubMediaFetch((method, url) => {
      if (method !== "GET") return undefined;
      if (url === mediaListUrl) return okJson(paginated([uploadedNote()]));
      if (url.startsWith("/api/artifacts?roomId=room%3Anext")) return new Promise((resolve) => { resolveNext = resolve; });
      return undefined;
    });
    const { rerender } = render(<MediaDock activeRoom={room} />);
    expect(await screen.findByRole("button", { name: "Open note.txt" })).toBeTruthy();

    rerender(<MediaDock activeRoom={{ ...room, id: "room:next", name: "Next" }} />);
    expect(screen.queryByRole("button", { name: "Open note.txt" })).toBeNull();
    expect(screen.getByText("Loading media…")).toBeTruthy();
    await act(async () => resolveNext(okJson(paginated([]))));
    expect(await screen.findByText("No media has been sent in this room yet.")).toBeTruthy();
  });

  it("starts a drag on media cards with the artifact payload so they drop into CLI and chat panes", async () => {
    stubMediaFetch((method, url) => (method === "GET" && url === mediaListUrl
      ? okJson(paginated([
        pastedImage(),
        artifact({
          id: "artifact:dom",
          kind: "SCREENSHOT",
          mimeType: "image/png",
          storageUri: "space-artifact://browser-evidence/capture/shot.png",
          metadata: { source: "SCREEN_CAPTURE" },
          createdAt: "2026-07-07T00:00:00.000Z"
        })
      ]))
      : undefined));

    render(<MediaDock activeRoom={room} />);

    const imageCard = await screen.findByRole("listitem", { name: `Drag ${PASTED_TITLE}` });
    const setData = vi.fn();
    const dataTransfer = { setData, effectAllowed: "" } as unknown as DataTransfer;
    fireEvent.dragStart(imageCard, { dataTransfer });
    expect(setData).toHaveBeenCalledWith(
      SPACE_ARTIFACT_MIME,
      JSON.stringify({ id: "artifact:image", name: "image.png", mimeType: "image/png" })
    );
    expect(setData).toHaveBeenCalledWith("text/uri-list", "/api/artifacts/artifact%3Aimage/file");
    expect(dataTransfer.effectAllowed).toBe("copy");

    const screenshotCard = await screen.findByRole("listitem", { name: "Drag Screenshot · 07/07/2026 00:00" });
    const setDataFallback = vi.fn();
    fireEvent.dragStart(screenshotCard, { dataTransfer: { setData: setDataFallback, effectAllowed: "" } as unknown as DataTransfer });
    expect(setDataFallback).toHaveBeenCalledWith(
      SPACE_ARTIFACT_MIME,
      JSON.stringify({ id: "artifact:dom", name: "space-artifact-artifact:dom.png", mimeType: "image/png" })
    );
  });

  it("routes non-previewable media through the platform gateway and marks them as external", async () => {
    const nativeOpen = vi.spyOn(window, "open").mockReturnValue(null);
    const openLink = vi.fn(() => null);
    installSpaceRuntime({
      ...liveRuntime,
      platform: { ...liveRuntime.platform, openLink }
    });
    stubMediaFetch((method, url) => (method === "GET" && url === mediaListUrl ? okJson(paginated([uploadedNote(), pastedImage()])) : undefined));

    const { container } = render(<MediaDock activeRoom={room} />);
    const openFile = await screen.findByRole("button", { name: "Open note.txt" });
    // The open chip must not reuse the fullscreen icon.
    expect(openFile.querySelector(".media-dock-chip.is-end svg")?.getAttribute("data-app-icon")).toBe("ExternalLink");
    expect(screen.getByRole("button", { name: `Open ${PASTED_TITLE}` }).querySelector(".media-dock-chip.is-end svg")?.getAttribute("data-app-icon")).toBe("ZoomIn");
    expect(container.querySelector(".media-dock-card svg[data-app-icon='Maximize2']")).toBeNull();

    fireEvent.click(openFile);
    expect(openLink).toHaveBeenCalledWith("/api/artifacts/artifact%3Afile/file", "_blank", "noopener,noreferrer");
    expect(nativeOpen).not.toHaveBeenCalled();
  });

  it("loads media from every room-media page", async () => {
    const newest = artifact({
      id: "artifact:newest",
      kind: "IMAGE",
      mimeType: "image/png",
      storageUri: "space-artifact://user-uploads/room%3Amedia/2026-07-17/newest.png",
      createdAt: "2026-07-17T12:00:00.000Z"
    });
    const oldest = artifact({
      id: "artifact:oldest",
      kind: "IMAGE",
      mimeType: "image/png",
      storageUri: "space-artifact://user-uploads/room%3Amedia/2026-07-01/oldest.png",
      createdAt: "2026-07-01T12:00:00.000Z"
    });
    stubMediaFetch((method, url) => {
      if (method === "GET" && url === mediaListUrl) return okJson(paginated([newest], { totalItems: 101, totalPages: 2 }));
      if (method === "GET" && url === mediaPage2Url) return okJson(paginated([oldest], { page: 2, totalItems: 101, totalPages: 2 }));
      return undefined;
    });

    const { container } = render(<MediaDock activeRoom={room} />);

    await waitFor(() => expect(container.querySelector(".dock-kit-summary")?.textContent).toBe("2 media items in this room"));
    expect(screen.getAllByRole("button", { name: /^Open Image · / })).toHaveLength(2);
  });

  it("filters media by name and type as you type", async () => {
    stubMediaFetch((method, url) => (method === "GET" && url === mediaListUrl ? okJson(paginated([pastedImage(), uploadedNote(), uploadedVideo()])) : undefined));
    const { container } = render(<MediaDock activeRoom={room} />);
    await screen.findByRole("button", { name: "Open note.txt" });

    const search = screen.getByRole("searchbox", { name: "Search media" });
    fireEvent.change(search, { target: { value: "video" } });
    expect(screen.getByRole("button", { name: "Open capture.mp4" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open note.txt" })).toBeNull();
    expect(container.querySelector(".dock-kit-summary")?.textContent).toBe("1 of 3 media items");

    fireEvent.change(search, { target: { value: "NOTE" } });
    expect(screen.getByRole("button", { name: "Open note.txt" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open capture.mp4" })).toBeNull();

    fireEvent.change(search, { target: { value: "nothing-like-this" } });
    expect(screen.getByText("No media matches your search.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });

  it("deletes one item after an in-app confirmation and keeps the room cache in step", async () => {
    const nativeConfirm = vi.fn(() => true);
    vi.stubGlobal("confirm", nativeConfirm);
    let media = [uploadedNote(), uploadedVideo()];
    let resolveSecondMount: ((value: unknown) => void) | null = null;
    let listCalls = 0;
    stubMediaFetch((method, url) => {
      if (method === "GET" && url === mediaListUrl) {
        listCalls += 1;
        if (listCalls === 1) return okJson(paginated(media));
        return new Promise((resolve) => { resolveSecondMount = resolve; });
      }
      if (method === "DELETE" && url === "/api/artifacts/artifact%3Afile") {
        media = media.filter((item) => item.id !== "artifact:file");
        return okJson({ ok: true, artifactId: "artifact:file" });
      }
      return undefined;
    });

    const { unmount } = render(<MediaDock activeRoom={room} />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete note.txt" }));
    const dialog = screen.getByRole("alertdialog", { name: "Delete this media item?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Open note.txt" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Delete note.txt" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Open note.txt" })).toBeNull());
    expect(nativeConfirm).not.toHaveBeenCalled();

    unmount();
    // The remount renders from the cache while the reload is still pending.
    render(<MediaDock activeRoom={room} />);
    expect(screen.getByRole("button", { name: "Open capture.mp4" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open note.txt" })).toBeNull();
    await act(async () => resolveSecondMount?.(okJson(paginated(media))));
  });

  it("clears all room media with one room-wide request after an in-app confirmation", async () => {
    const nativeConfirm = vi.fn(() => true);
    vi.stubGlobal("confirm", nativeConfirm);
    const clearRequests: string[] = [];
    let media = [pastedImage(), uploadedNote(), uploadedVideo(), artifact({
      id: "artifact:dom",
      kind: "DOM_SNAPSHOT",
      mimeType: "application/json",
      storageUri: "space-artifact://browser-evidence/capture/dom.json",
      metadata: { source: "SCREEN_CAPTURE", artifactFile: "dom.json" }
    })];
    stubMediaFetch((method, url) => {
      if (method === "GET" && url === mediaListUrl) return okJson(paginated(media));
      if (method === "DELETE" && url === clearRoomMediaUrl) {
        clearRequests.push(url);
        media = media.filter((item) => item.kind === "DOM_SNAPSHOT");
        return okJson({ ok: true, roomId: room.id, matchedCount: 3, deletedCount: 3, failedCount: 0, failedArtifactIds: [] });
      }
      return undefined;
    });

    render(<MediaDock activeRoom={room} />);

    await screen.findByRole("button", { name: "Open note.txt" });
    fireEvent.click(screen.getByRole("button", { name: "Clear all media" }));
    const dialog = screen.getByRole("alertdialog", { name: "Clear all media?" });
    expect(dialog.textContent).toContain("including older media");
    fireEvent.click(within(dialog).getByRole("button", { name: "Clear all" }));

    await waitFor(() => expect(clearRequests).toEqual([clearRoomMediaUrl]));
    expect(await screen.findByText("No media has been sent in this room yet.")).toBeTruthy();
    expect(nativeConfirm).not.toHaveBeenCalled();
  });

  it("reloads and reports media that a room-wide clear could not delete", async () => {
    let clearRequestCount = 0;
    const remaining = artifact({
      id: "artifact:remaining",
      kind: "IMAGE",
      mimeType: "image/png",
      storageUri: "space-artifact://user-uploads/room%3Amedia/2026-07-17/remaining.png",
      metadata: { source: "USER_UPLOAD", originalFilename: "remaining.png" }
    });
    stubMediaFetch((method, url) => {
      if (method === "GET" && url === mediaListUrl) return okJson(paginated([remaining]));
      if (method === "DELETE" && url === clearRoomMediaUrl) {
        clearRequestCount += 1;
        return okJson({ ok: false, roomId: room.id, matchedCount: 1, deletedCount: 0, failedCount: 1, failedArtifactIds: [remaining.id] });
      }
      return undefined;
    });

    render(<MediaDock activeRoom={room} />);

    await screen.findByRole("button", { name: "Open remaining.png" });
    fireEvent.click(screen.getByRole("button", { name: "Clear all media" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Clear all" }));
    const notice = await screen.findByRole("alert");
    expect(notice.textContent).toContain("1 media item could not be deleted.");
    expect(clearRequestCount).toBe(1);
    expect(screen.getByRole("button", { name: "Open remaining.png" })).toBeTruthy();
    fireEvent.click(within(notice).getByRole("button", { name: "Dismiss message" }));
    expect(screen.queryByText("1 media item could not be deleted.")).toBeNull();
  });

  it("shows fresh uploads immediately for the active room", async () => {
    stubMediaFetch((method, url) => (method === "GET" && url === mediaListUrl ? okJson(paginated([])) : undefined));
    const { container } = render(<MediaDock activeRoom={room} />);

    expect(await screen.findByText("No media has been sent in this room yet.")).toBeTruthy();

    const uploaded = artifact({
      id: "artifact:new-image",
      kind: "IMAGE",
      mimeType: "image/png",
      storageUri: "space-artifact://user-uploads/room%3Amedia/2026-07-07/upload_2.png",
      metadata: { source: "USER_UPLOAD", originalFilename: "upload_2.png" }
    });
    act(() => {
      window.dispatchEvent(new CustomEvent("space:artifacts-updated", { detail: { roomId: "room:other", artifacts: [uploaded] } }));
    });
    expect(screen.queryByRole("button", { name: "Open upload_2.png" })).toBeNull();
    act(() => {
      window.dispatchEvent(new CustomEvent("space:artifacts-updated", { detail: { roomId: room.id, artifacts: [uploaded] } }));
    });

    expect(await screen.findByRole("button", { name: "Open upload_2.png" })).toBeTruthy();
    expect(container.querySelector(".dock-kit-summary")?.textContent).toBe("1 media item in this room");
  });

  it("toggles the media dock into a fullscreen gallery and back out", async () => {
    stubMediaFetch((method, url) => (method === "GET" && url === mediaListUrl ? okJson(paginated([pastedImage()])) : undefined));

    render(<MediaDock activeRoom={room} />);

    expect((await screen.findByRole("list", { name: "Room media" })).getAttribute("data-layout")).toBe("list");
    expect(screen.queryByRole("heading", { name: "Media" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open media fullscreen" }));
    expect(document.querySelector(".media-dock-shell.is-fullscreen")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Media" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Exit media fullscreen" })).toBeTruthy();
    expect(screen.getByRole("list", { name: "Room media" }).getAttribute("data-layout")).toBe("gallery");

    // Escape closes the viewer first and leaves fullscreen on the next press.
    fireEvent.click(screen.getByRole("button", { name: `Open ${PASTED_TITLE}` }));
    const viewer = screen.getByRole("dialog", { name: `${PASTED_TITLE} full resolution` });
    fireEvent.keyDown(viewer, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector(".media-dock-shell.is-fullscreen")).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(document.querySelector(".media-dock-shell.is-fullscreen")).toBeNull());
  });

  it("defines list-layout media cards with contained previews for the side dock", () => {
    const css = readFileSync(resolve(__dirname, "../src/features/media-dock/media-dock.css"), "utf8");
    const rule = (selector: string) => {
      const start = css.indexOf(`${selector} {`);
      return start < 0 ? "" : css.slice(start, css.indexOf("}", start) + 1);
    };
    const source = readFileSync(resolve(__dirname, "../src/features/media-dock/MediaDock.tsx"), "utf8");

    expect(source).toContain('import "./media-dock.css";');
    expect(rule(".media-dock-list.is-list")).toContain("grid-template-columns: minmax(0, 1fr);");
    expect(rule(".media-dock-card")).toContain("align-self: start;");
    const previewRule = rule(".media-dock-preview");
    expect(previewRule).toContain("flex: 0 0 auto;");
    expect(previewRule).toContain("aspect-ratio: 16 / 10;");
    expect(previewRule).toContain("height: auto;");
    expect(css).toContain("object-fit: contain;");
    expect(css).not.toContain("!important");
  });

  it("opens image media in a full resolution viewer", async () => {
    stubMediaFetch((method, url) => (method === "GET" && url === mediaListUrl ? okJson(paginated([pastedImage()])) : undefined));

    render(<MediaDock activeRoom={room} />);

    fireEvent.click(await screen.findByRole("button", { name: `Open ${PASTED_TITLE}` }));
    const viewer = await screen.findByRole("dialog", { name: `${PASTED_TITLE} full resolution` });
    expect((screen.getByAltText(`${PASTED_TITLE} full resolution`) as HTMLImageElement).getAttribute("src")).toBe("/api/artifacts/artifact%3Aimage/file");
    expect(viewer.textContent).toContain("Pasted image · 07/07/2026 00:00 · 2 KB");
    fireEvent.click(within(viewer).getByRole("button", { name: "Close media viewer" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens video media in a playable viewer", async () => {
    stubMediaFetch((method, url) => (method === "GET" && url === mediaListUrl ? okJson(paginated([uploadedVideo()])) : undefined));

    render(<MediaDock activeRoom={room} />);

    fireEvent.click(await screen.findByRole("button", { name: "Open capture.mp4" }));
    const dialog = await screen.findByRole("dialog", { name: "capture.mp4 full resolution" });
    expect((within(dialog).getByLabelText("capture.mp4 full resolution") as HTMLVideoElement).getAttribute("src")).toBe("/api/artifacts/artifact%3Avideo/file");
  });
});
