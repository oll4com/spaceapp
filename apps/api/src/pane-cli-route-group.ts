import type { FastifyInstance } from "fastify";
import { registerCliLocalComposerRoutes } from "./cli-local-composer-routes.js";
import { registerPaneCliModelRoutes, registerPaneCliTerminalRoutes } from "./pane-cli-routes.js";

type PaneCliRouteDependencies = Parameters<typeof registerPaneCliTerminalRoutes>[1]
  & Parameters<typeof registerCliLocalComposerRoutes>[1]
  & Parameters<typeof registerPaneCliModelRoutes>[1];

/** Keep CLI route wiring and shared dependencies in the CLI domain. */
export function registerPaneCliRoutes(app: FastifyInstance, deps: PaneCliRouteDependencies) {
  registerPaneCliTerminalRoutes(app, deps);
  registerCliLocalComposerRoutes(app, deps);
  registerPaneCliModelRoutes(app, deps);
}
