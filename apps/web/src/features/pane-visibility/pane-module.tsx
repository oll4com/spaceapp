import type { Pane } from "@space/contracts";
import { uiText, useUiLanguage } from "../ui-language/ui-language.js";
import { serverModuleOn } from "./server-modules.js";

// ARCH-003 part B: a pane made while its optional module was on stays in its room after the server turns the module off
// (SPACE_OPTIONAL_MODULES); its routes are then not registered, and the pane body showed "Not Found" and empty settings.
const MODE_MODULE: Partial<Record<Pane["mode"], { module: string; name: string }>> = {
  JOB_APPLY: { module: "job-copilot", name: "Job Copilot" },
  MAIL_COPILOT: { module: "mail-copilot", name: "Mail Copilot" },
  MARKETING_COPILOT: { module: "marketing-copilot", name: "Marketing Copilot" },
  FREELANCE_COPILOT: { module: "freelance-copilot", name: "Freelance Copilot" },
  DESIGN: { module: "design", name: "Design" },
  APP_STUDIO: { module: "app-studio", name: "App Studio" },
  VIDEO: { module: "video", name: "Video" },
  SECURITY_COPILOT: { module: "security-copilot", name: "Security Copilot" },
  MONITORING_COPILOT: { module: "monitoring-copilot", name: "Monitoring Copilot" }
};

/** Read at render with no hook, so PaneCard (Warm) gains no subscription; the list arrives before panes render. */
export function paneModuleOff(mode: Pane["mode"]): boolean {
  const entry = MODE_MODULE[mode];
  return entry !== undefined && !serverModuleOn(entry.module);
}

export function PaneModuleOffNotice({ mode }: { mode: Pane["mode"] }) {
  const language = useUiLanguage();
  const entry = MODE_MODULE[mode];
  return (
    <div role="status" className="pane-module-off">
      <p>{uiText(language, "{name} is turned off on this server.", { name: entry?.name ?? mode })}</p>
      <p>{uiText(language, "An administrator turns it on with SPACE_OPTIONAL_MODULES; this pane works again after the restart.")}</p>
    </div>
  );
}
