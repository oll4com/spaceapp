import { readFileSync, readdirSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { render, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import ts from "typescript-api";
import * as AppIcons from "../src/features/ui-theme/app-icons.js";
import {
  AppIconProvider,
  Bot,
  Chrome,
  CircleHelp,
  Palette,
  Settings,
  Terminal
} from "../src/features/ui-theme/app-icons.js";
import { appIconMaterialSymbols } from "../../../packages/icons/src/app-icon-map.js";
import { isAppIconPackReady, loadAppIconPack } from "../../../packages/icons/src/icon-pack-registry.js";
import { materialRoundedPaths } from "../../../packages/icons/src/material-symbol-paths.js";
import { HelpPage } from "../src/features/help/HelpPage.js";
import { helpEntries } from "../src/features/help/help-content.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(testDir, "../src");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return [".ts", ".tsx"].includes(extname(path)) ? [path] : [];
  });
}

describe("Space app icon packs", () => {
  beforeAll(() => loadAppIconPack("material-rounded"));

  it("renders representative generic controls with Material Rounded everywhere", () => {
    const { container } = render(
      <AppIconProvider pack="material-rounded">
        <Bot data-testid="bot" />
        <CircleHelp data-testid="help" />
        <Palette data-testid="palette" />
        <Settings data-testid="settings" />
        <Terminal data-testid="terminal" />
      </AppIconProvider>
    );

    const icons = Array.from(container.querySelectorAll<SVGElement>("svg[data-app-icon]"));
    expect(icons).toHaveLength(5);
    expect(icons.every((icon) => icon.dataset.iconPack === "material-rounded")).toBe(true);
    expect(container.querySelector(".lucide")).toBeNull();
  });

  it("keeps Lucide available as the explicit Modern alternative", () => {
    const { container } = render(
      <AppIconProvider pack="lucide">
        <Settings />
      </AppIconProvider>
    );

    const icon = container.querySelector<SVGElement>("svg[data-app-icon]");
    expect(icon?.dataset.iconPack).toBe("lucide");
    expect(icon?.classList.contains("lucide")).toBe(true);
  });

  it("preserves explicit brand marks even when Material Rounded is selected", () => {
    const { container } = render(
      <AppIconProvider pack="material-rounded">
        <Chrome />
      </AppIconProvider>
    );

    const icon = container.querySelector<SVGElement>("svg[data-brand-icon='chrome']");
    expect(icon).toBeTruthy();
    expect(icon?.dataset.iconPack).toBe("brand");
    expect(icon?.classList.contains("lucide-chrome")).toBe(true);
  });

  it("has an official Material path for every generic app icon", () => {
    for (const materialName of Object.values(appIconMaterialSymbols)) {
      const definition = materialRoundedPaths[materialName];
      expect(definition.paths.length).toBeGreaterThan(0);
      expect(definition.viewBox).toBeTruthy();
    }
  });

  it("renders every Help icon through the selected global pack", () => {
    const { container } = render(
      <AppIconProvider pack="material-rounded">
        <HelpPage onBack={() => undefined} />
      </AppIconProvider>
    );

    const icons = Array.from(container.querySelectorAll<SVGElement>("svg[data-app-icon]"));
    expect(icons.length).toBeGreaterThanOrEqual(helpEntries.length + 3);
    expect(icons.every((icon) => icon.dataset.iconPack === "material-rounded")).toBe(true);
  });

  it.each(["material-rounded", "lucide"] as const)("uses %s for file, settings, and widget controls", pack => {
    const names = ["FileText", "FileAudio", "Plug", "Unlink", "Calendar", "Timer", "Dumbbell", "ChevronDown", "ZoomIn"] as const;
    for (const name of names) {
      expect(AppIcons).toHaveProperty(name);
      const Icon = (AppIcons as unknown as Record<string, AppIcons.LucideIcon>)[name]!;
      const view = render(<AppIconProvider pack={pack}><Icon aria-label={name} size={19} /></AppIconProvider>);
      const icon = view.getByLabelText(name);
      expect(icon.getAttribute("data-icon-pack")).toBe(pack);
      expect(icon.getAttribute("data-app-icon")).toBe(name);
      expect(icon.getAttribute("width")).toBe("19");
      view.unmount();
    }
  });

  it("loads non-default packs on demand and shows Lucide until the selected pack is ready", async () => {
    expect(isAppIconPackReady("lucide")).toBe(true);
    expect(isAppIconPackReady("material-rounded")).toBe(true);
    expect(isAppIconPackReady("motion")).toBe(false);

    const { container, findByTestId } = render(
      <AppIconProvider pack="motion">
        <Bot data-testid="bot" />
      </AppIconProvider>
    );
    expect(container.querySelector<SVGElement>("svg[data-app-icon]")?.dataset.iconPack).toBe("lucide");
    await waitFor(() => expect(container.querySelector<SVGElement>("svg[data-app-icon]")?.dataset.iconPack).toBe("motion"), { timeout: 10_000 });
    expect(await findByTestId("bot")).toBeTruthy();
    expect(isAppIconPackReady("motion")).toBe(true);
  });

  it("inks every app icon with the shared Aurora gradient and a currentColor fallback", async () => {
    await loadAppIconPack("aurora");
    const { container } = render(
      <AppIconProvider pack="aurora">
        <Bot />
        <Terminal color="red" />
      </AppIconProvider>
    );
    const [bot, terminal] = [...container.querySelectorAll<SVGElement>("svg[data-app-icon]")] as [SVGElement, SVGElement];
    expect(bot.dataset.iconPack).toBe("aurora");
    expect(bot.getAttribute("stroke")).toBe("url(#space-aurora-ink) currentColor");
    expect(bot.classList.contains("space-aurora-icon")).toBe(true);
    expect(terminal.getAttribute("stroke")).toBe("red");
    expect(document.querySelectorAll("#space-aurora-ink")).toHaveLength(1);
    expect(document.querySelectorAll("#space-aurora-ink stop")).toHaveLength(3);
  });

  it("tones closed shapes with Space Duotone and leaves filled icons solid", async () => {
    await loadAppIconPack("space");
    const { container } = render(
      <AppIconProvider pack="space">
        <Terminal />
        <Bot fill="currentColor" />
      </AppIconProvider>
    );
    const [terminal, bot] = [...container.querySelectorAll<SVGElement>("svg[data-app-icon]")] as [SVGElement, SVGElement];
    expect(terminal.dataset.iconPack).toBe("space");
    expect(terminal.classList.contains("space-duotone-icon")).toBe(true);
    expect(terminal.getAttribute("stroke-width")).toBe("1.75");
    expect(terminal.querySelector(".space-duotone-plate rect")).not.toBeNull();
    expect(bot.querySelector(".space-duotone-plate")).toBeNull();
  });

  it("keeps one icon per meaning", () => {
    // Pencil edits, TextCursorInput renames, Settings opens settings, SlidersHorizontal tunes,
    // CircleAlert is an error, AlertTriangle a warning, Info is information.
    for (const retired of ["Edit", "Edit2", "Edit3", "Settings2", "Sliders", "AlertCircle", "TriangleAlert"]) {
      expect(AppIcons).not.toHaveProperty(retired);
    }
    // Different meanings keep different glyphs in the Material pack too.
    for (const [a, b] of [["Brain", "BrainCircuit"], ["Camera", "Crop"], ["ArrowLeft", "SkipBack"], ["ChevronRight", "SkipForward"], ["Pencil", "TextCursorInput"], ["CircleAlert", "Info"]] as const) {
      expect(appIconMaterialSymbols[a]).not.toBe(appIconMaterialSymbols[b]);
    }
  });

  it("prevents app surfaces from bypassing the @space/icons package", () => {
    const offenders = sourceFiles(sourceRoot)
      .filter((path) => {
        const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
        return source.statements.some(node => {
          if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier) || node.moduleSpecifier.text !== "lucide-react") return false;
          const clause = node.importClause;
          if (clause?.isTypeOnly) return false;
          if (clause?.name) return true;
          const bindings = clause?.namedBindings;
          return !bindings || !ts.isNamedImports(bindings) || bindings.elements.some(element => !element.isTypeOnly);
        });
      })
      .map((path) => relative(sourceRoot, path).replaceAll("\\", "/"))
      .sort();

    expect(offenders).toEqual([]);
  });
});
