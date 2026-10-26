import { createContext, lazy, Suspense, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { IBufferLine, IDecoration, ITerminalAddon, Terminal } from "@xterm/xterm";
import { isAgentFileArtifact, type Artifact } from "@space/contracts";
import { AgentFiles } from "../ui-theme/app-icons.js";
import { agentFileName, fetchAllAgentFiles } from "../agent-files/agent-files-api.js";
import "./agent-file-links.css";

// Agent Files names in CLI output (and in ChatMarkdown inside AgentFileMentions) become links with an icon; a click opens the
// Agent Files preview.

const LazyAgentFilePreviewDialog = lazy(() =>
  import("../agent-files/AgentFilesDock.js").then((module) => ({ default: module.AgentFilePreviewDialog }))
);

const INDEX_TTL_MS = 60_000;
const SCAN_DELAY_MS = 200;
// A file name ends in an extension; letters, digits, "_", "-" and inner dots around it make it a longer name.
const NAME_TOKEN = /[\p{L}\p{N}_.-]*[\p{L}\p{N}_-]\.[\p{L}\p{N}]{1,10}(?![\p{L}\p{N}_-])/gu;
const NAME_CHAR = /[\p{L}\p{N}_.-]/u;

type AgentFileIndex = ReadonlyMap<string, ReadonlyArray<{ name: string; artifact: Artifact }>>;
export interface AgentFileHit { startCol: number; endCol: number; name: string; artifact: Artifact }

/** Names keyed by their last token, so a name with spaces is found from its end; newest file wins a repeated name. */
export function indexAgentFiles(artifacts: readonly Artifact[]): AgentFileIndex {
  const index = new Map<string, Array<{ name: string; artifact: Artifact }>>();
  const seen = new Set<string>();
  for (const artifact of [...artifacts].sort((left, right) => right.createdAt.localeCompare(left.createdAt))) {
    const name = isAgentFileArtifact(artifact) && !artifact.deletedAt ? agentFileName(artifact) : null;
    if (!name || seen.has(name)) continue;
    const last = [...name.matchAll(NAME_TOKEN)].at(-1);
    if (!last || last.index + last[0].length !== name.length) continue;
    seen.add(name);
    const names = index.get(last[0]) ?? [];
    names.push({ name, artifact });
    names.sort((left, right) => right.name.length - left.name.length);
    index.set(last[0], names);
  }
  return index;
}

export function findAgentFileNames(text: string, index: AgentFileIndex) {
  const found: Array<{ start: number; end: number; name: string; artifact: Artifact }> = [];
  for (const token of text.matchAll(NAME_TOKEN)) {
    const end = token.index + token[0].length;
    const hit = index.get(token[0])?.find(({ name }) => {
      const start = end - name.length;
      return start >= 0 && text.startsWith(name, start) && !NAME_CHAR.test(text[start - 1] ?? "");
    });
    if (hit) found.push({ start: end - hit.name.length, end, ...hit });
  }
  return found;
}

/** Hits of one buffer line in cell columns (wide characters take two cells). */
// shortcut: a name wrapped onto the next row is not found; join wrapped rows if agents print longer names.
export function lineAgentFiles(line: IBufferLine, cols: number, index: AgentFileIndex): AgentFileHit[] {
  if (!index.size) return [];
  let text = "";
  const columns: number[] = [];
  const cell = line.getCell(0);
  for (let x = 0; cell && x < Math.min(cols, line.length); x++) {
    line.getCell(x, cell);
    if (cell.getWidth() === 0) continue;
    const chars = cell.getChars() || " ";
    text += chars;
    for (let i = 0; i < chars.length; i++) columns.push(x);
  }
  return findAgentFileNames(text, index).map(({ start, end, name, artifact }) => ({
    startCol: columns[start]!,
    endCol: columns[end - 1]! + 1,
    name,
    artifact
  }));
}

let agentFileIndex: AgentFileIndex = new Map();
let indexSignature = "";
let indexCheckedAt = 0;
let indexLoading = false;
const indexListeners = new Set<() => void>();

// Shared by every pane; read at most once a minute and only while a terminal renders or is hovered.
function currentAgentFileIndex(): AgentFileIndex {
  if (!indexLoading && Date.now() - indexCheckedAt >= INDEX_TTL_MS) {
    indexLoading = true;
    indexCheckedAt = Date.now();
    fetchAllAgentFiles()
      .then((artifacts) => {
        const signature = artifacts.map((artifact) => artifact.id).join();
        if (signature === indexSignature) return;
        indexSignature = signature;
        agentFileIndex = indexAgentFiles(artifacts);
        indexListeners.forEach((listener) => listener());
      }, () => undefined)
      .finally(() => { indexLoading = false; });
  }
  return agentFileIndex;
}

interface AgentFileLinkState { icons: readonly HTMLElement[]; open: Artifact | null }

/** One per CLI pane: the icons the pane's xterm shows and the file whose preview is open. */
export class AgentFileLinkStore {
  private state: AgentFileLinkState = { icons: [], open: null };
  private readonly listeners = new Set<() => void>();
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  readonly snapshot = () => this.state;
  readonly open = (artifact: Artifact) => this.update({ open: artifact });
  readonly close = () => this.update({ open: null });
  showIcon(element: HTMLElement) { this.update({ icons: [...this.state.icons, element] }); }
  hideIcon(element: HTMLElement) { this.update({ icons: this.state.icons.filter((icon) => icon !== element) }); }
  /** xterm replaces an addon's dispose when it loads it, so every terminal gets a new addon. */
  addon(): ITerminalAddon { return new AgentFileLinksAddon(this); }
  private update(patch: Partial<AgentFileLinkState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
}

let nextIconKey = 0;

class AgentFileLinksAddon implements ITerminalAddon {
  private terminal: Terminal | null = null;
  private disposables: Array<{ dispose(): void }> = [];
  private marks: Array<{ decoration: IDecoration; startCol: number; endCol: number; id: string }> = [];
  private scanTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly store: AgentFileLinkStore) {}

  activate(terminal: Terminal) {
    this.terminal = terminal;
    const onIndexChanged = () => this.scheduleScan();
    indexListeners.add(onIndexChanged);
    this.disposables.push(
      { dispose: () => indexListeners.delete(onIndexChanged) },
      terminal.onRender(() => this.scheduleScan()),
      terminal.registerLinkProvider({
        provideLinks: (y, callback) => {
          const line = terminal.buffer.active.getLine(y - 1);
          const hits = line ? lineAgentFiles(line, terminal.cols, currentAgentFileIndex()) : [];
          callback(hits.length ? hits.map((hit) => ({
            range: { start: { x: hit.startCol + 1, y }, end: { x: hit.endCol, y } },
            text: hit.name,
            decorations: { pointerCursor: true, underline: true },
            activate: () => this.store.open(hit.artifact)
          })) : undefined);
        }
      })
    );
  }

  dispose() {
    if (this.scanTimer) clearTimeout(this.scanTimer);
    this.disposables.forEach((disposable) => disposable.dispose());
    this.marks.forEach((mark) => mark.decoration.marker.dispose());
    this.disposables = [];
    this.marks = [];
    this.terminal = null;
  }

  private scheduleScan() {
    if (this.scanTimer) return;
    this.scanTimer = setTimeout(() => {
      this.scanTimer = null;
      this.scan();
    }, SCAN_DELAY_MS);
  }

  // Marks the names on screen; decorations exist only in the normal buffer. Hidden warm rooms rescan when they render again.
  private scan() {
    const terminal = this.terminal;
    if (!terminal || terminal.element?.checkVisibility?.({ visibilityProperty: true }) === false) return;
    const buffer = terminal.buffer.active;
    const wanted = new Map<string, AgentFileHit & { line: number }>();
    if (buffer.type === "normal") {
      const index = currentAgentFileIndex();
      for (let y = buffer.viewportY; y < buffer.viewportY + terminal.rows; y++) {
        const line = buffer.getLine(y);
        for (const hit of line ? lineAgentFiles(line, terminal.cols, index) : []) {
          wanted.set(`${y}:${hit.startCol}:${hit.endCol}:${hit.artifact.id}`, { ...hit, line: y });
        }
      }
    }
    this.marks = this.marks.filter((mark) => {
      const key = `${mark.decoration.marker.line}:${mark.startCol}:${mark.endCol}:${mark.id}`;
      if (!mark.decoration.isDisposed && wanted.delete(key)) return true;
      mark.decoration.marker.dispose();
      return false;
    });
    for (const hit of wanted.values()) {
      const marker = terminal.registerMarker(hit.line - buffer.baseY - buffer.cursorY);
      const decoration = terminal.registerDecoration({ marker, x: hit.startCol, width: hit.endCol - hit.startCol, layer: "top" });
      if (!decoration) {
        marker.dispose();
        continue;
      }
      decoration.onRender((element) => {
        if (element.dataset.agentFileLink) return;
        element.dataset.agentFileLink = String(nextIconKey++);
        element.classList.add("terminal-agent-file-link");
        this.store.showIcon(element);
      });
      decoration.onDispose(() => {
        if (decoration.element) this.store.hideIcon(decoration.element);
      });
      this.marks.push({ decoration, startCol: hit.startCol, endCol: hit.endCol, id: hit.artifact.id });
    }
  }
}

/** Renders only portals: the icons inside the xterm decorations and the preview under <body>. */
export function AgentFileLinkLayer({ store, themeAttributes }: {
  store: AgentFileLinkStore;
  themeAttributes: () => Record<string, string | undefined>;
}) {
  const { icons, open } = useSyncExternalStore(store.subscribe, store.snapshot);
  return (
    <>
      {icons.map((element) => createPortal(<AgentFiles aria-hidden="true" />, element, element.dataset.agentFileLink))}
      {open && typeof document !== "undefined"
        ? createPortal(
          <div
            className="dock-kit-scope"
            {...themeAttributes()}
            onKeyDown={(event) => {
              // Keys stay in the preview; the document listener covers focus outside it.
              event.stopPropagation();
              if (event.key === "Escape") store.close();
            }}
          >
            <Suspense fallback={null}>
              <LazyAgentFilePreviewDialog artifact={open} onClose={store.close} />
            </Suspense>
          </div>,
          document.body
        )
        : null}
    </>
  );
}

const subscribeIndex = (listener: () => void) => {
  indexListeners.add(listener);
  return () => { indexListeners.delete(listener); };
};

type MarkdownNode = { type: string; value?: string; url?: string; children?: MarkdownNode[] };
const agentFileHref = (artifact: Artifact) => `/api/artifacts/${encodeURIComponent(artifact.id)}/download`;

/** A remark plugin: names in text and inline code become links to their file's download, which ChatMarkdown opens as the preview. */
function remarkAgentFileLinks(index: AgentFileIndex) {
  const link = (artifact: Artifact, child: MarkdownNode): MarkdownNode => ({ type: "link", url: agentFileHref(artifact), children: [child] });
  const visit = (node: MarkdownNode) => {
    if (!node.children || node.type === "link" || node.type === "linkReference") return;
    node.children = node.children.flatMap((child) => {
      if (child.type !== "text" && child.type !== "inlineCode") {
        visit(child);
        return [child];
      }
      const text = child.value ?? "";
      const hits = findAgentFileNames(text, index);
      if (child.type === "inlineCode") return hits.length === 1 ? [link(hits[0]!.artifact, child)] : [child];
      if (!hits.length) return [child];
      const parts: MarkdownNode[] = [];
      let at = 0;
      for (const hit of hits) {
        if (hit.start < at) continue;
        if (hit.start > at) parts.push({ type: "text", value: text.slice(at, hit.start) });
        parts.push(link(hit.artifact, { type: "text", value: hit.name }));
        at = hit.end;
      }
      if (at < text.length) parts.push({ type: "text", value: text.slice(at) });
      return parts;
    });
  };
  return () => (tree: MarkdownNode) => visit(tree);
}

export interface AgentFileMentionLinks {
  remark: () => (tree: MarkdownNode) => void;
  artifact(href: string): Artifact | undefined;
  open(artifact: Artifact): void;
}

export const AgentFileMentionContext = createContext<AgentFileMentionLinks | null>(null);

/** ChatMarkdown inside links the Agent Files names it shows; the preview opens here, so inside a modal dialog it opens on top. */
export function AgentFileMentions({ children }: { children: ReactNode }) {
  const index = useSyncExternalStore(subscribeIndex, currentAgentFileIndex);
  const [open, setOpen] = useState<Artifact | null>(null);
  const links = useMemo<AgentFileMentionLinks>(() => {
    const byHref = new Map([...index.values()].flat().map(({ artifact }) => [agentFileHref(artifact), artifact]));
    return { remark: remarkAgentFileLinks(index), artifact: (href) => byHref.get(href), open: setOpen };
  }, [index]);
  return (
    <AgentFileMentionContext.Provider value={links}>
      {children}
      {open ? (
        <div
          onKeyDown={(event) => {
            // Keys stay in the preview; Escape closes only the preview, not a dialog or fullscreen dock around it.
            event.stopPropagation();
            if (event.key === "Escape") {
              event.preventDefault();
              setOpen(null);
            }
          }}
        >
          <Suspense fallback={null}>
            <LazyAgentFilePreviewDialog artifact={open} onClose={() => setOpen(null)} />
          </Suspense>
        </div>
      ) : null}
    </AgentFileMentionContext.Provider>
  );
}
