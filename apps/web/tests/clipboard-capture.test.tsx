import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createClipboardItem: vi.fn() }));
vi.mock("../src/api.js", () => ({ api: mocks }));

import {
  SPACE_CLIPBOARD_NOTICE_EVENT,
  captureClipboardText,
  setClipboardCapturePaused,
  useSpaceClipboardCapture,
  writeClipboardText
} from "../src/features/clipboard-dock/clipboard-events.js";
import { createDemoRuntime } from "../src/demo/demo-runtime.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";

function CaptureHarness() {
  useSpaceClipboardCapture(true);
  return (
    <div>
      <section data-space-pane-id="pane:one" data-space-room-id="room:one" data-space-pane-title="Drafts">
        <textarea aria-label="Composer" defaultValue="selected copy" />
      </section>
      <input aria-label="Password" type="password" />
      <textarea aria-label="Opted out" data-space-clipboard-capture="off" />
      <div className="login-shell"><textarea aria-label="Login field" /></div>
    </div>
  );
}

function clipboardData(text: string) {
  return { getData: (type: string) => (type === "text/plain" ? text : "") };
}

describe("Space clipboard capture", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    installSpaceRuntime(liveRuntime);
    mocks.createClipboardItem.mockResolvedValue({ id: "clipboard:captured" });
  });

  it("captures exact copy and paste text with pane metadata", async () => {
    render(<CaptureHarness />);
    const composer = screen.getByRole("textbox", { name: "Composer" });

    fireEvent.copy(composer, { clipboardData: clipboardData("  exact copy  ") });
    fireEvent.paste(composer, { clipboardData: clipboardData("exact paste") });

    await waitFor(() => expect(mocks.createClipboardItem).toHaveBeenCalledTimes(2));
    expect(mocks.createClipboardItem).toHaveBeenNthCalledWith(1, {
      text: "  exact copy  ",
      source: "COPY",
      roomId: "room:one",
      paneId: "pane:one",
      paneTitle: "Drafts"
    });
    expect(mocks.createClipboardItem).toHaveBeenNthCalledWith(2, {
      text: "exact paste",
      source: "PASTE",
      roomId: "room:one",
      paneId: "pane:one",
      paneTitle: "Drafts"
    });
  });

  it("honors pause plus password, login, and explicit opt-out exclusions", async () => {
    render(<CaptureHarness />);
    fireEvent.paste(screen.getByLabelText("Password"), { clipboardData: clipboardData("password-secret") });
    fireEvent.paste(screen.getByLabelText("Opted out"), { clipboardData: clipboardData("opted-out") });
    fireEvent.paste(screen.getByLabelText("Login field"), { clipboardData: clipboardData("login-secret") });
    setClipboardCapturePaused(true);
    fireEvent.paste(screen.getByRole("textbox", { name: "Composer" }), { clipboardData: clipboardData("paused") });

    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(mocks.createClipboardItem).not.toHaveBeenCalled();
  });

  it("ignores whitespace and reports oversized text without blocking the clipboard operation", async () => {
    const notices: string[] = [];
    window.addEventListener(SPACE_CLIPBOARD_NOTICE_EVENT, ((event: CustomEvent<{ message: string }>) => {
      notices.push(event.detail.message);
    }) as EventListener, { once: true });

    expect(await captureClipboardText({ text: " \n\t ", source: "PASTE" })).toBe("IGNORED");
    expect(await captureClipboardText({ text: "x".repeat(100_001), source: "COPY" })).toBe("TOO_LARGE");
    expect(mocks.createClipboardItem).not.toHaveBeenCalled();
    expect(notices).toEqual(["Text was copied or pasted, but it was too large to add to Clipboard history."]);
  });

  it("falls back to a temporary textarea when async clipboard writes fail", async () => {
    const writeText = vi.fn(async () => {
      throw new Error("Clipboard permission denied");
    });
    const execCommand = vi.fn(() => true);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });

    await writeClipboardText("Chat transcript");

    expect(writeText).toHaveBeenCalledWith("Chat transcript");
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(document.querySelector("textarea[readonly]")).toBeNull();
  });

  it("keeps demo clipboard writes local without the native or legacy fallback", async () => {
    const nativeWriteText = vi.fn(async () => {
      throw new Error("Native clipboard must stay unused in demo mode.");
    });
    const execCommand = vi.fn(() => true);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: nativeWriteText } });
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    const { runtime } = createDemoRuntime();
    installSpaceRuntime(runtime);

    await writeClipboardText("Local demo transcript");

    expect(await runtime.platform.clipboard?.readText()).toBe("Local demo transcript");
    expect(nativeWriteText).not.toHaveBeenCalled();
    expect(execCommand).not.toHaveBeenCalled();
  });
});
