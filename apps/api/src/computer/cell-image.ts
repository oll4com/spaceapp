import { PANE_HIBERNATE_DEFAULT_MINUTES } from "@space/contracts";

// What a paid-tier cell image carries by default (plan clipboard:YqhRIXfLAnfK step 9, decision Ε; docs/agents/nous-computer.md).
// Not read by code yet: the image builder (P1) takes these files from the same release; the guard test keeps them real.
export const CELL_IMAGE_DEFAULTS = Object.freeze({
  /** Step 1 knobs, installed next to the CLIs as Space's deploy installs them. */
  cliKnobs: ["deploy/codex-vscode-parity", "deploy/claude-space-settings.json", "deploy/claude-standalone-settings.json"],
  /** Step 3: one MCP dispatcher shared by every CLI in the cell. */
  mcpDispatcher: "deploy/space-mcp-dispatcher.mjs",
  /** Step 2: an idle pane sleeps after this; space-vm-agent must carry the pane host's sleep and resume hook. */
  hibernateMinutes: PANE_HIBERNATE_DEFAULT_MINUTES,
  /** Decision Δ: Codex chats run as a light pane, one app-server per turn. */
  codexPaneType: "codex-light",
  /** Decision Ε: pi, unmodified, for users who bring API keys; never a Claude Max, ChatGPT or Google sign-in. */
  lightCli: { runtime: "pi", npmPackage: "@earendil-works/pi-coding-agent", launcher: "deploy/nous-computer/pi-light-cli" }
});
