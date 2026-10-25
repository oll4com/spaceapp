import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";

const appSource = readFileSync(resolve(__dirname, "../src/App.tsx"), "utf8");
// PaneCard (and the lazy pane chunks it renders) moved verbatim out of App.tsx.
const paneCardSource = readFileSync(resolve(__dirname, "../src/features/pane-card/PaneCard.tsx"), "utf8");
const terminalPaneSource = readFileSync(
  resolve(__dirname, "../src/features/terminal-pane/TerminalPane.tsx"),
  "utf8"
);
const chatComposerSource = readFileSync(
  resolve(__dirname, "../src/features/agent-pane/CodexComposer.tsx"),
  "utf8"
);
const agentEventsSource = readFileSync(resolve(__dirname, "../src/features/agent-pane/events.ts"), "utf8");
const browserEventsSource = readFileSync(resolve(__dirname, "../src/features/browser-pane/events.ts"), "utf8");
const refreshSource = appSource.slice(
  appSource.indexOf("  async function refresh()"),
  appSource.indexOf("  useEffect(() => {\n    refresh()", appSource.indexOf("  async function refresh()"))
);

describe("lazy pane loading boundaries", () => {
  it("keeps the Agent and Browser pane implementations out of the eager App graph", () => {
    expect(paneCardSource).toContain('import("../agent-pane/AgentPane.js")');
    expect(paneCardSource).toContain('import("../browser-pane/BrowserPane.js")');
    expect(appSource).not.toMatch(
      /import\s*\{[^}]*\bAgentPane\b[^}]*\}\s*from\s*["']\.\/features\/agent-pane\/(?:index|AgentPane)\.js["']/s
    );
    expect(appSource).not.toMatch(
      /import\s*\{[^}]*\bBrowserPane\b[^}]*\}\s*from\s*["']\.\/features\/browser-pane\/(?:index|BrowserPane)\.js["']/s
    );
    expect(paneCardSource).not.toMatch(
      /import\s*\{[^}]*\bAgentPane\b[^}]*\}\s*from\s*["']\.\.\/agent-pane\/(?:index|AgentPane)\.js["']/s
    );
    expect(paneCardSource).not.toMatch(
      /import\s*\{[^}]*\bBrowserPane\b[^}]*\}\s*from\s*["']\.\.\/browser-pane\/(?:index|BrowserPane)\.js["']/s
    );
  });

  it("keeps eagerly used pane action contracts in lightweight modules", () => {
    expect(agentEventsSource).not.toMatch(/from\s*["']\.\/AgentPane\.js["']/);
    expect(browserEventsSource).not.toMatch(/from\s*["']\.\/BrowserPane\.js["']/);
    expect(appSource).toContain('from "./features/agent-pane/events.js"');
    expect(appSource).toContain('from "./features/browser-pane/events.js"');
  });

  it("renders each lazy pane inside a pane-local loading boundary", () => {
    const ast = ts.createSourceFile("PaneCard.tsx", paneCardSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const parents = new Map<string, string[]>();
    function visit(node: ts.Node) {
      if (ts.isJsxSelfClosingElement(node) && ["LazyAgentPane", "LazyBrowserPane"].includes(node.tagName.getText(ast))) {
        const parent = node.parent;
        const tag = ts.isJsxElement(parent) ? parent.openingElement.tagName.getText(ast) : "no local boundary";
        parents.set(node.tagName.getText(ast), [...(parents.get(node.tagName.getText(ast)) ?? []), tag]);
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
    // Every use has its own boundary; the Job Applications pane renders a second Browser pane
    // next to its CLI.
    for (const lazyPane of ["LazyAgentPane", "LazyBrowserPane"]) {
      const uses = parents.get(lazyPane) ?? [];
      expect(uses.length).toBeGreaterThan(0);
      expect(uses.every((tag) => tag === "RecoverableSurface")).toBe(true);
      expect(new Set(uses)).toEqual(new Set(["RecoverableSurface"]));
    }
    const boundary = readFileSync(resolve(__dirname, "../src/features/SurfaceErrorBoundary.tsx"), "utf8");
    expect(boundary).toMatch(/<SurfaceErrorBoundary[^>]*><Suspense fallback=\{fallback\}>\{children\}<\/Suspense><\/SurfaceErrorBoundary>/);
  });

  it("keeps the shared model picker out of initial CLI and Chat rendering", () => {
    for (const source of [terminalPaneSource, chatComposerSource]) {
      expect(source).toContain('import("../codex-model-picker/CodexModelPicker.js")');
      expect(source).not.toMatch(
        /import\s*\{[^}]*\bCodexModelPicker\b[^}]*\}\s*from\s*["']\.\.\/codex-model-picker\/CodexModelPicker\.js["']/s
      );
      expect(source).toMatch(/<Suspense[^>]+>[\s\S]*?<LazyCodexModelPicker\b[\s\S]*?<\/Suspense>/);
    }
  });

  it("keeps bootstrap observer-safe without automatically opening CLI Recovery", () => {
    expect(refreshSource).not.toContain("openCliMaintenanceRecovery");
    expect(appSource).toMatch(
      /browserObserverOnly=\{auth\?\.user\?\.automationScope === "APP_DIAGNOSTICS"\}/
    );
    expect(appSource).toMatch(
      /terminalObserverOnly=\{auth\?\.user\?\.automationScope === "APP_DIAGNOSTICS"\}/
    );
    expect(appSource).toMatch(
      /auth\?\.user\?\.automationScope === "APP_DIAGNOSTICS"[\s\S]*return;[\s\S]*api\.warmCliRuntimes\(\)/
    );
    expect(terminalPaneSource).toMatch(
      /if \(observerOnly\) return;[\s\S]*void startOrReconnect\(\)/
    );
  });
});
