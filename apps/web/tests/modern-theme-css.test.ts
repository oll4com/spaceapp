import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

const testDir = dirname(fileURLToPath(import.meta.url));
const modernCss = readFileSync(resolve(testDir, "../src/features/ui-theme/modern-theme.css"), "utf8");
const classicCss = readFileSync(resolve(testDir, "../src/styles.css"), "utf8");
const mainSource = readFileSync(resolve(testDir, "../src/main.tsx"), "utf8");

function readHexToken(block: string, token: string): string {
  return block.match(new RegExp(`${token}:\\s*(#[0-9a-f]{6})`, "i"))?.[1] ?? "";
}

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const [red, green, blue] = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  );
  return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
}

function contrastRatio(foreground: string, background: string): number {
  const luminances = [relativeLuminance(foreground), relativeLuminance(background)].sort((left, right) => right - left);
  return (luminances[0]! + 0.05) / (luminances[1]! + 0.05);
}

describe("Modern theme CSS safety contract", () => {
  it("keeps Classic independent and loads Modern only for the opt-in preference", () => {
    // Light-mode rules share the project-wide `:is([data-color-mode="light"], [data-ui-theme="modern"][data-color-mode="light"], ...)`
    // specificity alias. Inside such a group the Modern alternative is subsumed by the bare light-mode
    // selector, so it matches no extra element and adds no Modern-only styling. Any other Modern selector
    // (a Modern-only rule, or an alias that is not subsumed) must live in modern-theme.css.
    const lightModeAlias = '[data-ui-theme="modern"][data-color-mode="light"]';
    const classicWithoutLightAliases = classicCss.replace(/:is\(([^()]*)\)/g, (group, args: string) => {
      const parts = args.split(",").map((part) => part.trim());
      const subsumed =
        parts.includes('[data-color-mode="light"]') &&
        parts.every((part) => !part.includes('[data-ui-theme="modern"]') || part === lightModeAlias);
      return subsumed ? ':is([data-color-mode="light"])' : group;
    });
    expect(classicWithoutLightAliases).not.toContain('[data-ui-theme="modern"]');
    // No quoting or attribute-operator variant may smuggle a Modern selector back in.
    expect(classicWithoutLightAliases).not.toMatch(/data-ui-theme\s*[~|^$*]?=\s*["']?modern/);
    expect(mainSource).toContain('readUiTheme(window.localStorage) !== "classic"');
    expect(mainSource).toContain('import("./features/ui-theme/modern-theme.css")');
  });

  it("avoids expensive relational selectors and CSS-hidden toolbar actions", () => {
    expect(modernCss).not.toContain(":has(");
    expect(modernCss).not.toContain(":nth-of-type(");
    expect(modernCss).not.toContain("!important");
    expect(modernCss).toContain('[data-pane-mode="TERMINAL"]');
  });

  it("keeps the Modern room toolbar on two scrollable rows", () => {
    expect(modernCss).toMatch(
      /\.space-shell\[data-ui-theme="modern"\] \.board-toolbar,[\s\S]*?grid-template-areas:\s*"title lb"\s*"actions actions";/
    );
    expect(modernCss).toMatch(
      /\.space-shell\[data-ui-theme="modern"\] \.modern-action-groups\s*\{[^}]*overflow-x:\s*auto;[^}]*scrollbar-width:\s*thin;/s
    );
  });

  it("defines semantic foreground tokens for accent, status, and terminal surfaces", () => {
    for (const token of [
      "--modern-on-accent",
      "--modern-danger-soft",
      "--modern-warning-soft",
      "--modern-success",
      "--modern-success-soft",
      "--modern-terminal-text",
      "--modern-terminal-muted"
    ]) {
      expect(modernCss).toContain(token);
    }
  });

  it("bridges legacy room-theme tokens to the active Modern palette", () => {
    const shellRule = modernCss.match(/\.space-shell\[data-ui-theme="modern"\]\s*\{(?<body>[^}]*)\}/)?.groups?.body ?? "";

    for (const mapping of [
      "--room-bg: var(--modern-bg)",
      "--room-surface: var(--modern-surface-raised)",
      "--room-surface-soft: var(--modern-surface)",
      "--room-border: var(--modern-border)",
      "--room-text: var(--modern-text)",
      "--room-muted: var(--modern-muted)",
      "--room-accent: var(--modern-accent)",
      "--room-accent-soft: var(--modern-accent-soft)",
      "--room-terminal-bg: var(--modern-terminal)"
    ]) {
      expect(shellRule).toContain(mapping);
    }
  });

  it("defines distinct accessible Dark and Light accents for every room palette", () => {
    const paletteAccents = {
      graphite: { dark: "#d8c9a9", light: "#725a36" },
      forest: { dark: "#5cc8aa", light: "#087568" },
      copper: { dark: "#d58b62", light: "#9b4f2b" },
      steel: { dark: "#7db9d6", light: "#326b82" },
      contrast: { dark: "#f4efe5", light: "#17232d" }
    } as const;

    for (const [palette, accents] of Object.entries(paletteAccents)) {
      const darkRule =
        modernCss.match(new RegExp(`\\[data-ui-theme="modern"\\]\\[data-room-theme="${palette}"\\]\\s*\\{(?<body>[^}]*)\\}`))
          ?.groups?.body ?? "";
      const lightRule =
        modernCss.match(new RegExp(`\\[data-ui-theme="modern"\\]\\[data-color-mode="light"\\]\\[data-room-theme="${palette}"\\]\\s*\\{(?<body>[^}]*)\\}`))
          ?.groups?.body ?? "";

      expect(readHexToken(darkRule, "--modern-accent")).toBe(accents.dark);
      expect(readHexToken(lightRule, "--modern-accent")).toBe(accents.light);
      expect(contrastRatio(accents.dark, "#111820")).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(accents.light, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps Light faint labels at WCAG AA contrast on raised surfaces", () => {
    const lightRule = modernCss.match(/\[data-ui-theme="modern"\]\[data-color-mode="light"\]\s*\{(?<body>[^}]*)\}/)?.groups?.body ?? "";
    const foreground = readHexToken(lightRule, "--modern-faint");
    const background = readHexToken(lightRule, "--modern-surface-raised");

    expect(foreground).toMatch(/^#[0-9a-f]{6}$/i);
    expect(background).toMatch(/^#[0-9a-f]{6}$/i);
    expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(4.5);
  });

  it("covers every major user-facing surface with Modern-scoped rules", () => {
    for (const selector of [
      // The Rooms dock and its pane composer draw their colours from the dock kit tokens.
      ".surface-header strong",
      ".validation-result",
      ".agent-settings-dock",
      ".memory-workspace",
      ".room-agent",
      ".clipboard-dock",
      ".media-dock",
      ".links-panel",
      ".runtime-dock",
      ".browser-pane",
      ".codex-chat-shell",
      ".help-page",
      ".empty-state"
    ]) {
      expect(modernCss).toContain(selector);
    }
  });

  it("covers the reported Light settings, help, memory, room-agent, and menu surfaces", () => {
    for (const selector of [
      ".cli-runtime-settings-row",
      ".source-control-provider",
      ".telegram-status-panel",
      // The Room Agent goal and report now draw their light colours from the dock kit tokens.
      ".memory-workspace-header",
      ".pane-layout-options > button",
      ".server-actions-menu",
      ".workspace-text-size-picker",
      ".vibe-music-panel",
      ".toolbar-metric-panel",
      ".cli-launcher-menu"
    ]) {
      expect(modernCss).toContain(selector);
    }
    expect(modernCss).toContain('body[data-ui-theme="modern"]');
    expect(modernCss).toContain(".help-section > header");
    expect(modernCss).toContain(".help-entry-icon");
  });

  it("renders the GitHub Copilot CLI mark in white on the dark Modern theme", () => {
    expect(classicCss).toContain('body:not([data-color-mode="light"]) img[data-terminal-runtime-brand="copilot"]');
    expect(classicCss).toContain('body:not([data-color-mode="light"]) [data-brand-icon="github"]');
    expect(classicCss).toContain("filter: brightness(0) invert(1);");
  });

  it("keeps CLI restart controls square and the VPN typography on one compact scale", () => {
    expect(classicCss).toMatch(/\.cli-runtime-restart-button\s*\{[^}]*inline-size:\s*1\.12rem[^}]*block-size:\s*1\.12rem[^}]*min-height:\s*1\.12rem[^}]*padding:\s*0/s);
    // The visibility/VPN switches are SpaceToggle components now; their native-input pill styles are gone.
    expect(classicCss).not.toMatch(/\.cli-runtime-visibility-toggle input/);
    expect(classicCss).toMatch(/\.cli-runtime-settings-actions\s*\{[^}]*align-items:\s*center/s);
    expect(classicCss).toMatch(/\.cli-runtime-settings-row\s*\{[^}]*padding:\s*0\.3rem 0\.35rem/s);
    expect(classicCss).toMatch(/\.cli-egress-route-select > select\s*\{[^}]*font-size:\s*0\.72rem/s);
    expect(classicCss).toMatch(/\.cli-vpn-profile-details\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/s);
    expect(classicCss).toMatch(/\.cli-vpn-profile-details > span\s*\{[^}]*font-size:\s*0\.66rem/s);
  });

  it("keeps the overflow manager and minimized strip structurally bounded", () => {
    expect(classicCss).toMatch(/\.icon-action-manager\s*\{[^}]*position:\s*fixed/s);
    expect(classicCss).toMatch(/\.icon-action-manager button\s*\{[^}]*grid-template-columns:\s*var\(--toolbar-icon-size\) minmax\(0,\s*1fr\) auto/s);
    expect(classicCss).toMatch(/\.icon-action-manager button > span:not\(\.icon-action-manager-state\)\s*\{[^}]*text-overflow:\s*ellipsis/s);
    expect(classicCss).toMatch(/\.minimized-pane-bar\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\) auto/s);
    expect(classicCss).toMatch(/\.minimized-pane-items\s*\{[^}]*scrollbar-gutter:\s*stable/s);
  });

  it("keeps every mobile action-sheet control at least 44px in both dimensions", () => {
    expect(classicCss).not.toMatch(
      /\.space-shell\[data-shell-mode="mobile"\] \.mobile-action-sheet button\s*\{/
    );
    expect(classicCss).toMatch(
      /\.space-shell\[data-shell-mode="mobile"\] \.mobile-action-sheet-close\s*\{[^}]*width:\s*2\.75rem;[^}]*min-height:\s*2\.75rem/s
    );
    expect(classicCss).toMatch(
      /\.space-shell\[data-shell-mode="mobile"\] \.mobile-action-sheet-list button\s*\{[^}]*min-height:\s*2\.75rem/s
    );
  });

  it("scopes pane fixed-action sizing to toolbar controls instead of nested action sheets", () => {
    expect(classicCss).not.toMatch(/\.pane-actions-fixed button(?:\s|,|\{)/);
    expect(classicCss).not.toMatch(
      /\.space-shell\[data-shell-mode="mobile"\] \.pane-actions-fixed button(?:\s|,|\{)/
    );
    expect(classicCss).toContain(".pane-actions-fixed > .pane-actions-overflow > button");
    expect(modernCss).not.toMatch(
      /\.space-shell\[data-ui-theme="modern"\] \.pane-actions-fixed button(?:\s|,|\{)/
    );
    expect(modernCss).toContain(
      '.space-shell[data-ui-theme="modern"] .pane-actions-fixed > .pane-actions-overflow > button'
    );
    expect(classicCss).not.toMatch(/\.pane-card header(?:[.,:{\s])/);
    expect(classicCss).toContain(".pane-card > header");
    expect(modernCss).not.toMatch(/\.pane-card header(?:[.,:{\s])/);
    expect(modernCss).toContain('.space-shell[data-ui-theme="modern"] .pane-card > header');
  });

  it("keeps semantic states at the same specificity as their surface defaults", () => {
    expect(modernCss).toMatch(/:is\(\s*\.memory-workspace-error,/);
    expect(modernCss).toMatch(/:is\(\s*\.empty-state,/);
    expect(modernCss).not.toMatch(/:where\(\s*\.memory-workspace-error,/);
    expect(modernCss).not.toMatch(/:where\(\s*\.empty-state,/);
  });

  it("keeps the lazy Modern CSS payload within the agreed gzip budget", () => {
    expect(gzipSync(modernCss).byteLength).toBeLessThanOrEqual(20 * 1024);
  });
});

describe("Liquid Glass theme CSS contract", () => {
  const glassCss = readFileSync(resolve(testDir, "../src/features/ui-theme/liquid-glass-theme.css"), "utf8");
  const ruleBody = (selector: string) =>
    glassCss.match(new RegExp(`(?:^|\\n)${selector.replace(/[[\]().*"]/g, "\\$&")}\\s*\\{(?<body>[^}]*)\\}`))?.groups?.body ?? "";
  const dark = ruleBody(':root[data-interface-theme="liquid-glass"] [data-ui-theme="modern"]');
  const light = ruleBody(':root[data-interface-theme="liquid-glass"][data-color-mode="light"] [data-ui-theme="modern"]');

  it("defines every Modern palette token in both Dark and Light", () => {
    const modernTokens = [...(modernCss.match(/\[data-ui-theme="modern"\]\s*\{(?<body>[^}]*)\}/)?.groups?.body ?? "").matchAll(/(--modern-[a-z-]+):/g)].map((match) => match[1]!);
    expect(modernTokens.length).toBeGreaterThan(20);
    for (const token of modernTokens) {
      expect(dark).toContain(`${token}:`);
      if (!token.startsWith("--modern-terminal")) expect(light).toContain(`${token}:`);
    }
  });

  it("keeps accent, faint text and filled buttons at WCAG AA in both modes", () => {
    expect(contrastRatio(readHexToken(dark, "--modern-accent"), readHexToken(dark, "--modern-surface-raised"))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(readHexToken(dark, "--modern-faint"), readHexToken(dark, "--modern-surface-raised"))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(readHexToken(dark, "--modern-on-accent"), readHexToken(dark, "--modern-accent"))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(readHexToken(light, "--modern-accent"), readHexToken(light, "--modern-bg"))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(readHexToken(light, "--modern-faint"), readHexToken(light, "--modern-surface-raised"))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(readHexToken(light, "--modern-on-accent"), readHexToken(light, "--modern-accent"))).toBeGreaterThanOrEqual(4.5);
    for (const fill of glassCss.matchAll(/--lg-blue-fill:\s*(#[0-9a-f]{6})/gi)) {
      expect(contrastRatio("#ffffff", fill[1]!)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("gives native select options a solid, readable card in both modes", () => {
    for (const selector of [':root[data-interface-theme="liquid-glass"] select option', ':root[data-interface-theme="liquid-glass"][data-color-mode="light"] select option']) {
      const body = ruleBody(selector);
      const [background, text] = [/background-color:\s*(#[0-9a-f]{6});/i, /(?:^|\s)color:\s*(#[0-9a-f]{6});/i].map((pattern) => body.match(pattern)?.[1] ?? "");
      expect(contrastRatio(text!, background!)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("adapts the glass to Reduce Transparency, Increase Contrast and Reduce Motion", () => {
    expect(glassCss).toMatch(/@media \(prefers-reduced-transparency: reduce\)[\s\S]*?--lg-blur: none;/);
    expect(glassCss).toMatch(/@media \(prefers-contrast: more\)[\s\S]*?--lg-blur: none;/);
    expect(glassCss).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?animation: none;/);
    // The lens filter the CSS references is the one LiquidGlassLens renders, and it switches off with the blur.
    expect(glassCss).toContain("--lg-lens: url(#space-liquid-glass-lens);");
    expect(readFileSync(resolve(testDir, "../src/features/ui-theme/LiquidGlassLens.tsx"), "utf8")).toContain('id="space-liquid-glass-lens"');
    expect(glassCss).toMatch(/@media \(prefers-reduced-transparency: reduce\)[\s\S]*?--lg-lens: none;/);
    expect(glassCss).not.toContain(":has(");
    expect(glassCss).not.toContain("!important");
  });

  it("paints the focus and completion rings inside the pane, where the pane grid cannot clip them", () => {
    expect(glassCss).not.toMatch(/\.pane-card\.is-(?:target|completion-pending)\s*\{[^}]*box-shadow:\s*0 0 0/);
    expect(glassCss).toMatch(/\.pane-card:is\(\.is-target, \.is-completion-pending\):not\(\.is-drop-target\)::after\s*\{[^}]*inset: 0;[^}]*box-shadow: inset 0 0 0 2px var\(--lg-pane-ring\);/);
  });

  it("is loaded by the app and both demo entries", () => {
    expect(mainSource.match(/import\("\.\/features\/ui-theme\/liquid-glass-theme\.css"\)/g)).toHaveLength(2);
    for (const entry of ["../src/demo/mock-entry.tsx", "../src/demo/feature-entry.tsx"]) {
      expect(readFileSync(resolve(testDir, entry), "utf8")).toContain('import "../features/ui-theme/liquid-glass-theme.css";');
    }
  });
});
