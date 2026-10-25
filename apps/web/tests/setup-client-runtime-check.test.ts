import { afterEach, describe, expect, it, vi } from "vitest";
import { runSetupClientRuntimeCheck, verifySelectedSetupClientRuntimes } from "../src/features/setup-connections/setup-client-runtime-check.js";
import { loadYouTubeIframeApi } from "../src/features/vibe-music/youtubePlaylistPlayer.js";

vi.mock("../src/features/vibe-music/youtubePlaylistPlayer.js", () => ({ loadYouTubeIframeApi: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); });
const challenge = `SpaceApp-${"a".repeat(32)}`;

describe("actual selected browser functions", () => {
  it("round-trips synthetic text through the existing OSK input function without touching focused content", async () => {
    const input = document.createElement("input"); input.value = "Existing content"; document.body.append(input); input.focus();
    const result = await runSetupClientRuntimeCheck("utility:osk", challenge, new AbortController().signal);
    expect(result).toEqual({ featureId: "utility:osk", text: challenge, terminalData: challenge });
    expect(input.value).toBe("Existing content"); expect(document.activeElement).toBe(input);
  });

  it("refuses Asteroids when the actual host cannot provide a drawing context", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    await expect(runSetupClientRuntimeCheck("utility:asteroids", challenge, new AbortController().signal)).rejects.toThrow("canvas");
  });

  it("waits for the supported YouTube embed readiness callback and destroys its owned player", async () => {
    class Player {
      constructor(element: HTMLElement, options: { events: { onReady: () => void }; videoId?: string; playerVars: { autoplay: number } }) {
        expect(options.videoId).toBeUndefined(); expect(options.playerVars.autoplay).toBe(0);
        const iframe = document.createElement("iframe"); iframe.src = "https://www.youtube.com/embed/"; element.append(iframe);
        queueMicrotask(() => options.events.onReady());
      }
      pauseVideo() {} setVolume() {} getCurrentTime() { return 0; }
      destroy() { document.querySelector("iframe")?.remove(); }
    }
    vi.mocked(loadYouTubeIframeApi).mockResolvedValue({ Player } as never);
    await expect(runSetupClientRuntimeCheck("pane:youtube", challenge, new AbortController().signal)).resolves.toEqual({
      featureId: "pane:youtube", ready: true, position: 0, embedHost: "www.youtube.com"
    });
    expect(document.querySelector("iframe")).toBeNull(); expect(document.body.children.length).toBe(0);
  });

  it("aborts a late embed load without constructing a player or leaving a container", async () => {
    let loaded!: (value: Awaited<ReturnType<typeof loadYouTubeIframeApi>>) => void;
    vi.mocked(loadYouTubeIframeApi).mockImplementation(() => new Promise(resolve => { loaded = resolve; }));
    const controller = new AbortController();
    const checking = runSetupClientRuntimeCheck("pane:youtube", challenge, controller.signal);
    const rejected = expect(checking).rejects.toThrow();
    await vi.waitFor(() => expect(loaded).toBeDefined()); controller.abort(); await rejected;
    loaded({ Player: class { constructor() { throw new Error("No player may be constructed after cancel."); } } } as never);
    await Promise.resolve(); expect(document.body.children.length).toBe(0);
  });

  it("does nothing for unselected runtimes and cancels an OSK check if the server refuses its receipt", async () => {
    await expect(verifySelectedSetupClientRuntimes({}, ["agent:opencode"], 3, new AbortController().signal)).resolves.toBeUndefined();
    const cancelled: string[] = [];
    const client = {
      beginSetupClientRuntimeCheck: async () => ({ checkId: "b7111bdb-a9d8-4f6b-b237-2e9b1c815ea0", challenge, featureId: "utility:osk" as const }),
      completeSetupClientRuntimeCheck: async () => ({ verified: false }),
      cancelSetupClientRuntimeCheck: async (id: string) => { cancelled.push(id); }
    };
    await expect(verifySelectedSetupClientRuntimes(client, ["utility:osk"], 3, new AbortController().signal)).rejects.toThrow();
    expect(cancelled).toEqual(["b7111bdb-a9d8-4f6b-b237-2e9b1c815ea0"]);
  });
});
