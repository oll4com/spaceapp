import { afterEach, describe, expect, it, vi } from "vitest";
import { observeArcadePalette } from "../src/features/asteroids/theme.js";

const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

describe("arcade theme observation", () => {
  it("updates on ancestor theme changes, coalesces changes, and ignores gameplay attributes", async () => {
    const shell = document.createElement("section"), canvas = document.createElement("canvas");
    shell.append(canvas); document.body.append(shell);
    const style = vi.spyOn(window, "getComputedStyle").mockImplementation(() => ({ color: shell.dataset.colorMode === "light" ? "rgb(20, 20, 20)" : "rgb(240, 240, 240)" }) as CSSStyleDeclaration);
    const update = vi.fn(), stop = observeArcadePalette(canvas, update);
    expect(update).toHaveBeenCalledOnce();
    expect(update.mock.calls[0]![0].text).toBe("rgb(240, 240, 240)");
    expect(canvas.childElementCount).toBe(0);
    shell.dataset.colorMode = "light"; shell.dataset.roomTheme = "forest";
    await flush();
    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[1]![0].text).toBe("rgb(20, 20, 20)");
    const reads = style.mock.calls.length;
    canvas.dataset.phase = "playing"; canvas.dataset.paused = "true";
    await flush();
    expect(style).toHaveBeenCalledTimes(reads);
    stop();
  });

  it("refreshes after lazy stylesheet loading and cancels queued work on disposal", async () => {
    const canvas = document.createElement("canvas"), link = document.createElement("link");
    link.rel = "stylesheet"; document.body.append(canvas, link);
    const update = vi.fn(), stop = observeArcadePalette(canvas, update);
    link.dispatchEvent(new Event("load")); await flush();
    expect(update).toHaveBeenCalledTimes(2);
    link.dispatchEvent(new Event("load")); stop(); await flush();
    link.dispatchEvent(new Event("load")); document.body.classList.add("theme-changed"); await flush();
    expect(update).toHaveBeenCalledTimes(2);
    document.body.classList.remove("theme-changed");
  });
});
