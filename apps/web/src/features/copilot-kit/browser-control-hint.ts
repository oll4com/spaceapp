import { createContext } from "react";

/** Copilot handoff context belongs on the browser's existing control button, without another strip over the page. */
export const CopilotBrowserControlHint = createContext<{ reason: string | null } | null>(null);
