import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { paneModuleOff, PaneModuleOffNotice } from "../src/features/pane-visibility/pane-module.js";
import { noteServerModules } from "../src/features/pane-visibility/server-modules.js";

// ARCH-003 part B: an existing pane of a module the server has off shows why, instead of its body calling unregistered routes.
const MODULE_MODES = {
  JOB_APPLY: "job-copilot", MAIL_COPILOT: "mail-copilot", MARKETING_COPILOT: "marketing-copilot", FREELANCE_COPILOT: "freelance-copilot",
  DESIGN: "design", APP_STUDIO: "app-studio", VIDEO: "video", SECURITY_COPILOT: "security-copilot", MONITORING_COPILOT: "monitoring-copilot"
} as const;
const ALL = [...Object.values(MODULE_MODES), "games"];
const paneCard = readFileSync(resolve(__dirname, "../src/features/pane-card/PaneCard.tsx"), "utf8");

afterEach(() => { noteServerModules({ optionalModules: ALL }); });

describe("a pane whose optional module is off", () => {
  it("is off exactly when its own module is off, and on while the server sends no list", () => {
    for (const [mode, module] of Object.entries(MODULE_MODES)) {
      noteServerModules({ optionalModules: ALL.filter((id) => id !== module) });
      for (const other of Object.keys(MODULE_MODES)) expect(paneModuleOff(other as never), `${module} off, ${other}`).toBe(other === mode);
      expect(paneModuleOff("TERMINAL")).toBe(false);
    }
    noteServerModules({ optionalModules: [] });
    for (const mode of Object.keys(MODULE_MODES)) expect(paneModuleOff(mode as never)).toBe(true);
    expect(paneModuleOff("BROWSER")).toBe(false);
  });

  it("says which pane is off and how it comes back", () => {
    noteServerModules({ optionalModules: [] });
    render(<PaneModuleOffNotice mode="MAIL_COPILOT" />);
    expect(screen.getByRole("status").textContent).toContain("Mail Copilot is turned off on this server.");
    expect(screen.getByRole("status").textContent).toContain("SPACE_OPTIONAL_MODULES");
  });

  it("PaneCard checks it before every module pane's branch", () => {
    const check = paneCard.indexOf(") : paneModuleOff(pane.mode) ? (");
    expect(check).toBeGreaterThan(0);
    for (const mode of Object.keys(MODULE_MODES)) {
      const branch = paneCard.search(new RegExp(`\\) : [^\\n]*pane\\.mode === "${mode}"`));
      expect(branch, mode).toBeGreaterThan(check);
    }
  });
});
