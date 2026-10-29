import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Terminal, type ILink, type ILinkProvider } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Artifact } from "@space/contracts";
import { ChatMarkdown } from "../src/features/agent-pane/ChatMarkdown.js";
import {
  AgentFileLinkLayer,
  AgentFileLinkStore,
  AgentFileMentions,
  findAgentFileNames,
  indexAgentFiles,
  lineAgentFiles
} from "../src/features/terminal-pane/AgentFileLinks.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";

function agentFile(id: string, name: string, input: Partial<Artifact> = {}): Artifact {
  return {
    id,
    roomId: "room:links",
    paneId: "pane:codex",
    turnId: null,
    workflowId: null,
    kind: "EXPORT",
    mimeType: "text/markdown",
    storageUri: `space-artifact://agent-files/${id}`,
    sha256: "a".repeat(64),
    byteSize: 64,
    metadata: { source: "AGENT_OUTPUT", originalFilename: name, runtimeId: "cli:claude", previewKind: "TEXT" },
    expiresAt: null,
    pinnedAt: null,
    deletedAt: null,
    createdAt: "2026-10-21T08:00:00.000Z",
    ...input
  };
}

function write(terminal: Terminal, text: string) {
  return new Promise<void>((resolve) => terminal.write(text, resolve));
}

const emails = agentFile("artifact:emails", "13A-first-5-design-partner-emails.md");

beforeEach(() => installSpaceRuntime(liveRuntime));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Agent Files links in CLI output", () => {
  it("finds whole Agent Files names only", () => {
    const index = indexAgentFiles([
      emails,
      agentFile("artifact:plan-old", "My Plan.pdf", { createdAt: "2026-10-20T08:00:00.000Z" }),
      agentFile("artifact:plan-new", "My Plan.pdf"),
      agentFile("artifact:short", "Plan.pdf"),
      agentFile("artifact:deleted", "gone.md", { deletedAt: "2026-10-21T09:00:00.000Z" }),
      agentFile("artifact:upload", "input.txt", { storageUri: "space-artifact://cli-uploads/input.txt" })
    ]);
    const hits = (text: string) => findAgentFileNames(text, index).map(({ start, end, artifact }) => [text.slice(start, end), artifact.id]);

    expect(hits("φάκελος «Documents/SpaceApp Revenue Plan», αρχείο 13A-first-5-design-partner-emails.md. Είναι"))
      .toEqual([["13A-first-5-design-partner-emails.md", "artifact:emails"]]);
    expect(hits("see `My Plan.pdf` and (Plan.pdf)")).toEqual([["My Plan.pdf", "artifact:plan-new"], ["Plan.pdf", "artifact:short"]]);
    expect(hits("x13A-first-5-design-partner-emails.md v2.Plan.pdf Plan.pdf.bak Plan.pdfx gone.md input.txt")).toEqual([]);
  });

  it("maps a name to its cells after wide characters", async () => {
    const terminal = new Terminal({ cols: 60, rows: 4, allowProposedApi: true });
    await write(terminal, "漢字 ✓ αρχείο 13A-first-5-design-partner-emails.md.");
    const [hit] = lineAgentFiles(terminal.buffer.active.getLine(0)!, terminal.cols, indexAgentFiles([emails]));
    expect(hit).toMatchObject({ startCol: 14, endCol: 50, artifact: emails });
    terminal.dispose();
  });

  it("links a name the agent prints and opens its preview on click", async () => {
    const list = vi.spyOn(liveRuntime.api, "artifacts").mockResolvedValue({
      data: [emails],
      pagination: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 }
    });
    const terminal = new Terminal({ cols: 80, rows: 4, allowProposedApi: true });
    const register = vi.spyOn(terminal, "registerLinkProvider");
    const store = new AgentFileLinkStore();
    terminal.loadAddon(store.addon());
    const provider = register.mock.calls[0]![0] as ILinkProvider;
    await write(terminal, "Τα 5 email: αρχείο 13A-first-5-design-partner-emails.md.");
    const links = () => new Promise<ILink[] | undefined>((resolve) => provider.provideLinks(1, resolve));

    // The first look reads the list; the name links once it is known.
    await links();
    await waitFor(async () => expect(await links()).toHaveLength(1));
    const [link] = (await links())!;
    expect(link!.range).toEqual({ start: { x: 20, y: 1 }, end: { x: 55, y: 1 } });
    link!.activate(new MouseEvent("click"), link!.text);
    expect(store.snapshot().open).toBe(emails);
    expect(list).toHaveBeenCalledTimes(1);
    terminal.dispose();
  });

  it("shows the Agent Files preview over the pane and keeps its keys away from the CLI", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("/api/artifacts/artifact%3Aemails/preview");
      return { ok: true, status: 200, text: async () => "1. FULLSTACKS" };
    }));
    const store = new AgentFileLinkStore();
    const paneKeys = vi.fn();
    render(
      <div onKeyDown={paneKeys}>
        <AgentFileLinkLayer store={store} themeAttributes={() => ({ "data-ui-theme": "modern" })} />
      </div>
    );
    expect(screen.queryByRole("dialog")).toBeNull();

    act(() => store.open(emails));
    const dialog = await screen.findByRole("dialog", { name: "Preview 13A-first-5-design-partner-emails.md" });
    expect(dialog.parentElement?.className).toBe("dock-kit-scope");
    expect(dialog.parentElement?.dataset.uiTheme).toBe("modern");
    expect(await screen.findByText("1. FULLSTACKS")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download 13A-first-5-design-partner-emails.md" })).toBeTruthy();

    fireEvent.keyDown(screen.getByRole("button", { name: "Close Agent File preview" }), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(store.snapshot().open).toBeNull();
    expect(paneKeys).not.toHaveBeenCalled();
  });

  it("links Agent Files names in chat text inside AgentFileMentions and opens the preview there", async () => {
    vi.spyOn(liveRuntime.api, "artifacts").mockResolvedValue({
      data: [emails],
      pagination: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 }
    });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, text: async () => "1. FULLSTACKS" })));
    const text = "See Agent Files › Documents › 13A-first-5-design-partner-emails.md (draft), then `13A-first-5-design-partner-emails.md`.";
    const outerKeys = vi.fn();
    const { container } = render(
      <div onKeyDown={outerKeys}>
        <AgentFileMentions><ChatMarkdown content={text} /></AgentFileMentions>
        <ChatMarkdown content={text} />
      </div>
    );

    await waitFor(() => expect(screen.getAllByRole("link", { name: "13A-first-5-design-partner-emails.md" })).toHaveLength(2));
    const [plain, code] = screen.getAllByRole("link", { name: "13A-first-5-design-partner-emails.md" });
    expect(plain!.getAttribute("href")).toBe("/api/artifacts/artifact%3Aemails/download");
    expect(code!.querySelector("code")).toBeTruthy();
    // Outside the provider the same text stays plain.
    expect(container.querySelectorAll(".chat-markdown")[1]!.querySelector("a")).toBeNull();

    fireEvent.click(plain!);
    expect(await screen.findByRole("dialog", { name: "Preview 13A-first-5-design-partner-emails.md" })).toBeTruthy();
    expect(await screen.findByText("1. FULLSTACKS")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("button", { name: "Close Agent File preview" }), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(outerKeys).not.toHaveBeenCalled();
  });
});
