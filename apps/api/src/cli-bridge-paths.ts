import { cliJobApplyPathPrefix } from "./job-apply/agent-routes.js";
import { cliMailCopilotPathPrefix } from "./mail-copilot/agent-routes.js";
import { cliMarketingCopilotPathPrefix } from "./marketing-copilot/agent-routes.js";
import { cliFreelanceCopilotPathPrefix } from "./freelance-copilot/agent-routes.js";
import { cliDesignPathPrefix } from "./design/agent-routes.js";
import { cliTaskItemsPathPrefix } from "./task-agent-routes.js";
import { cliNousPathPrefix } from "./nous/mcp.js";
import { cliVaultPathPrefix } from "./vault/routes.js";
import { cliProgressPath } from "./pane-report-routes.js";

// Routes the pane CLIs reach with their pane bridge token instead of a session. The API skips session
// authentication for them, so every one of these routes verifies the bridge token itself.
const cliBrowserBridgePaths = new Set([
  "/api/cli/agent-files",
  "/api/cli/browser/context",
  "/api/cli/browser/session",
  "/api/cli/browser/actions",
  "/api/cli/browser/commands",
  "/api/cli/browser/cdp",
  "/api/cli/browser/cdp/status"
]);
// Nous's MCP route checks its own turn token (nous/mcp.ts).
const cliBridgePathPrefixes = [cliJobApplyPathPrefix, cliMailCopilotPathPrefix, cliMarketingCopilotPathPrefix, cliFreelanceCopilotPathPrefix, cliDesignPathPrefix, cliTaskItemsPathPrefix, cliNousPathPrefix, cliVaultPathPrefix, cliProgressPath];

/** Whether the matched route path is a CLI bridge route (decide on the router's matched path, never the raw URL). */
export function isCliBridgeRoutePath(routePath: string): boolean {
  return cliBrowserBridgePaths.has(routePath) || cliBridgePathPrefixes.some((prefix) => routePath.startsWith(prefix));
}
