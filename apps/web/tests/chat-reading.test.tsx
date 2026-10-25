import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatCopyButton, ChatMarkdown } from "../src/features/agent-pane/ChatMarkdown.js";
import { useTranscriptScroll } from "../src/features/agent-pane/useTranscriptScroll.js";
import { writeClipboardText } from "../src/features/clipboard-dock/clipboard-events.js";

vi.mock("../src/features/clipboard-dock/clipboard-events.js", () => ({ writeClipboardText: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

describe("Chat rich reading", () => {
  it("renders semantic Markdown and copies the complete code without its fences", async () => {
    const code = "const greeting = 'Καλημέρα';\nconsole.log(greeting);\n";
    render(<ChatMarkdown content={"## Result\n\n**Ready** with `code`.\n\n- One\n- Two\n\n| Name | State |\n| --- | --- |\n| Pane | Ready |\n\n```js\n" + code + "```"} />);
    expect(screen.getByRole("heading", { name: "Result" })).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByRole("columnheader", { name: "State" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    await waitFor(() => expect(writeClipboardText).toHaveBeenCalledWith(code));
    expect(await screen.findByText("Copied to clipboard")).toBeTruthy();
  });

  it("blocks executable links, raw HTML, and remote image loads, preserving safe links", () => {
    const { container } = render(<ChatMarkdown content={[
      '<script>alert(1)</script>', '<img src="https://remote.invalid/pixel" onerror="alert(1)">',
      '[Unsafe](javascript:alert%281%29)', '[Data](data:text/html,evil)', '[Protocol relative](//remote.invalid)',
      '[Backslash](\\\\remote.invalid)', '[Internal mutation](/api/admin/reset)',
      '[Source](https://example.com/reference)', '[File](/api/artifacts/artifact%3Aabc/download)',
      '![Screenshot](https://example.com/image.png)'
    ].join("\n\n")} />);
    expect(container.querySelector("script, img, iframe")).toBeNull();
    expect(screen.queryByRole("link", { name: "Unsafe" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Data" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Protocol relative" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Internal mutation" })).toBeNull();
    expect(screen.getByRole("link", { name: "Source" }).getAttribute("rel")).toBe("noopener noreferrer");
    expect(screen.getByRole("link", { name: "File" }).getAttribute("href")).toBe("/api/artifacts/artifact%3Aabc/download");
    expect(screen.getByRole("link", { name: "Screenshot" })).toBeTruthy();
  });

  it("keeps an unfinished streaming code fence readable", () => {
    const { rerender } = render(<ChatMarkdown content={"```ts\nconst x = 1"} />);
    expect(screen.getByLabelText("Code block").textContent).toBe("const x = 1\n");
    rerender(<ChatMarkdown content={"```ts\nconst x = 12;\n```"} />);
    expect(screen.getByLabelText("Code block").textContent).toBe("const x = 12;\n");
  });

  it("reports clipboard failure rather than claiming success", async () => {
    vi.mocked(writeClipboardText).mockRejectedValueOnce(new Error("Denied"));
    render(<ChatCopyButton text="Answer" label="Copy response" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy response" }));
    expect(await screen.findByText("Copy failed. Select the text and copy it manually.")).toBeTruthy();
    expect(screen.queryByText("Copied to clipboard")).toBeNull();
  });
});

describe("Chat scroll ownership", () => {
  function Harness({ content = false, version = 1, conversationId = "chat:a", visible = true }) {
    const scroll = useTranscriptScroll({ hasContent: content, contentVersion: version, conversationId, isVisible: visible });
    return <><div ref={scroll.transcriptRef} data-testid="scroll" onScroll={scroll.handleTranscriptScroll}><main /></div>
      {scroll.showJumpToLatest ? <button onClick={scroll.jumpToLatest}>Jump to latest</button> : null}</>;
  }
  function geometry() {
    const element = screen.getByTestId("scroll");
    Object.defineProperties(element, { scrollHeight: { configurable: true, value: 1500 }, clientHeight: { configurable: true, value: 300 } });
    return element;
  }
  it("opens an empty pane at the top, then follows arriving and streaming messages", () => {
    const { rerender } = render(<Harness />);
    const element = geometry();
    element.scrollTop = 120;
    rerender(<Harness version={2} />);
    expect(element.scrollTop).toBe(0);
    rerender(<Harness content version={3} />);
    expect(element.scrollTop).toBe(1500);
    Object.defineProperty(element, "scrollHeight", { value: 1800 });
    rerender(<Harness content version={4} />);
    expect(element.scrollTop).toBe(1800);
  });
  it("preserves reading position across refreshes and jumps only on request or a new conversation", () => {
    const { rerender } = render(<Harness content />);
    const element = geometry();
    element.scrollTop = 200;
    fireEvent.scroll(element);
    rerender(<Harness content version={2} />);
    expect(element.scrollTop).toBe(200);
    fireEvent.click(screen.getByRole("button", { name: "Jump to latest" }));
    expect(element.scrollTop).toBe(1500);
    expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull();
    element.scrollTop = 50;
    fireEvent.scroll(element);
    rerender(<Harness content conversationId="chat:b" />);
    expect(element.scrollTop).toBe(1500);
  });
  it("follows resized content, disconnects observers when hidden, and retains manual reading position", () => {
    let resized: ResizeObserverCallback = () => {};
    const disconnect = vi.fn();
    vi.stubGlobal("ResizeObserver", class { constructor(fn: ResizeObserverCallback) { resized = fn; } observe() {} disconnect = disconnect; });
    try {
      const { rerender } = render(<Harness content />);
      const element = geometry();
      act(() => resized([], {} as ResizeObserver));
      expect(element.scrollTop).toBe(1500);
      element.scrollTop = 80;
      fireEvent.scroll(element);
      act(() => resized([], {} as ResizeObserver));
      expect(element.scrollTop).toBe(80);
      rerender(<Harness content visible={false} />);
      expect(disconnect).toHaveBeenCalled();
      rerender(<Harness content visible />);
      expect(element.scrollTop).toBe(80);
    } finally { vi.unstubAllGlobals(); }
  });
});
