---
name: space-control-mcp
description: "Manual for the Space Control MCP tools (space-control backend): room and pane control, inspect sections, schedules, watches, debug incidents and the one-by-one tool health check. Use when operating Space rooms or panes through Space Control, or when the operator asks to check its tools."
metadata:
  category: TOOL_ADAPTER
---

# Space Control MCP Guide & Verification Manual

## Overview
Space Control MCP (`version: space-control-v1`) provides authoritative, safe, audited control over SpaceApp rooms, panes, CLI runtimes, layouts, media playback, clipboard, schedules, and agent watches. It bridges the SpaceApp backend, native CLI agents, and the real-time AI Voice assistant.

### From a CLI pane
- Codex, Claude Code, Oh My Pi, Hermes, Droid and Qoder panes reach it with the pane's `SPACE_CONTROL_TOKEN` (12 hours, valid only while that CLI session runs). Never print it: check it with `[ -n "$SPACE_CONTROL_TOKEN" ] && echo set`, never `env | grep`. If it was printed, restart the pane's CLI: the old token stops working at once.
- `CONTROL_NOT_GRANTED` means the operator has not allowed CLI control in this room. Tell the operator to ask the room's Room Agent or Nous to allow CLI control (`access.cli`) and confirm; agents never grant it themselves.
- The token works only in the pane's own room. A call without `roomId` targets that room; a call naming another room is refused ("CLI control grant is restricted to its own room.").

## Core MCP Tools Catalog

### 1. `space_capabilities`
- **Purpose**: Discovers room boundaries, supported modes, CLI runtimes, model aliases, and operations before targeting panes.
- **Parameters**: `roomId` (optional string).
- **Output**: JSON payload with `version`, `supportedActions`, `limits` (maxPanesAllowed, maxActionsPerRequest), and `runtimes` catalog.

### 2. `space_inspect`
- **Purpose**: Authoritative inspection across 20 system and room domains.
- **Parameters**: `section` (enum of 20 sections), `roomId` (optional), `paneId` (optional), `query` (optional), `offset` (int), `limit` (int).
- **Available Sections**:
  - `STATE`: Authoritative room state, open panes, positions, category colors, and active clients.
  - `CONTENT`: Terminal or chat pane output, activity logs, and turn status.
  - `MODELS`: Active CLI models, configured vs effective models, and account identities.
  - `QUOTA`: Account token quotas, 5h/weekly usage percentages, and reset deadlines.
  - `RUNTIMES`: CLI runtime installation status, versions, and execution modes.
  - `VPN`: CLI egress VPN routing profiles and city status.
  - `CLIPBOARD`: Operator private clipboard entries (notes, plans, copied content).
  - `FILES`: Uploaded and published workspace files and documents.
  - `MEDIA`: Images, videos, and screenshots attached to the room.
  - `SKILLS`: Installed and registered agent skills, one page (offset, limit, query filter) of metadata; skills.read returns a skill's text.
  - `SETTINGS`: Complete sanitized app settings across CLI, providers, tools, task titles, plugins, voice, and appearance.
  - `ROOMS`: List of all user rooms with metadata and pane counts.
  - `SYSTEM_HEALTH`: Realtime health metrics, CPU/memory, active services, and API error rates.
  - `PLUGINS`: Installed plugins, connection status, and enabled agent capabilities.
  - `MODULES`: Discoverable UI navigation groups, docks, tool surfaces, and feature flags.
  - `VOICE`: Voice transcription settings, local/cloud provider status, and supported speech models.
  - `LINKS`: Workspace bookmark links and metadata.
  - `TASKS`: Task items, objectives, completion status, and room linkages.
  - `AUDIT`: Audit trail of recent Space Control actions and mutations.
  - `TERMINAL_RENDER`: Numeric browser render observations per pane (geometry and freshness only; no content). See `space-cli-render-diagnostics`.

### 3. `space_execute`
- **Purpose**: Applies validated atomic batches of Space controls.
- **Parameters**: `roomId`, `requestId`, `actions` (array of action objects), `dryRun` (boolean), `waitForCompletion` (boolean).
- **Supported Operations**:
  - `panes.open`: Open any supported pane type (CLI runtimes, browser, chat, media and the other pane kinds). Call `space_describe_pane_types` for the current open keys and their availability instead of relying on a fixed list. Supports batching and `debug: true`.
  - `pane` operations: `close`, `restart`, `start`, `resume`, `stop`, `cancel`, `continue`, `prompt`, `minimize`, `maximize`, `restore`, `color`.
  - `layout` operations: `sort`, `apply`, `tree`, `save`, `restore`.
  - `playback` operations: `play`, `pause`, `next`, `previous`, `seek`, `volume`, `mute`, `unmute`.
  - `clipboard` operations: `save`, `complete`, `delete`.
  - `ui.theme`: Change room UI theme.
  - `ui.scale`: Adjust zoom and terminal font size.

### 3a. `space_describe_pane_types`
- **Purpose**: Lists every pane type with its open key and live availability, so `panes.open` targets a type that exists and can start now.
- **Parameters**: `roomId` (optional).

### 4. `space_screenshot`
- **Purpose**: A photo or an MP4 video of the room as SpaceApp shows it, read-only as the caller (terminals attach as observers), for vision analysis or social posts. Saved in the room's Media (7 days) as a SCREENSHOT or VIDEO artifact.
- **Parameters**: `roomId`, `aspect` (16:9, 1:1, 4:5, 9:16 phone layout, full) or `viewport` (desktop, desktop-hd, laptop, tablet, tablet-landscape, mobile, android, square, portrait, story; default desktop), `paneId`, `dock`, `settings`, `health`, `crop` (pane/dock, photos only), `format` (jpeg/png/webp), `quality`, `maxWidth`, `maxHeight`, `video` (`{steps:[{dock?,settings?,health?,dwellMs}]}`, at most 20 steps and 180 s).
- **Video**: answers RUNNING with an `operationId`; poll `space_operations` (`operation: "get"`, `id`) until COMPLETED for the `artifactId` and the real `durationMs`. `skipped` lists docks or sections that could not be opened. Dots capture photos only.
- **Engine**: `scripts/space-media-capture.mjs`, shared with the `space-media-studio` skill (social sizes, frames, theme previews, video).

### 5. `space_operations`
- **Purpose**: Inspects or cancels long-running durable operations.
- **Parameters**: `roomId`, `operation` (list/get/cancel), `id`.

### 6. `space_schedules`
- **Purpose**: Creates explicit one-shot schedules or inspects/cancels them.
- **Parameters**: `roomId`, `operation` (list/create/cancel), `dueAt`, `command`.

### 7. `space_watches`
- **Purpose**: Durable agent task completion watches with automatic live assistant re-engagement.
- **Parameters**: `roomId`, `operation` (list/register/status/cancel/ack), `paneId`, `targetTaskRef`.

### 8. `space_test_mcp_tools`
- **Purpose**: Automated 1-by-1 health and capability verification of all MCP tools and inspect sections.
- **Parameters**: `roomId` (optional), `tools` (optional array), `fast` (boolean).
- **Behavior**: Executes non-destructive probes on all core tools, checks latency, catches errors, and logs incidents with remediation prompts.

### 9. `space_list_mcp_tools`
- **Purpose**: Full catalog listing of all MCP and Voice assistant tools, their arguments, and voice commands.
- **Parameters**: `category` (all/voice/mcp/resources).

### 10. `space_debug`
- **Purpose**: Diagnostic preflight check, error investigation, and structured incident logger.
- **Parameters**: `roomId`, `operation`, `paneId`, `query`.
- **Output**: Detailed root-cause diagnosis and `agentHandoffPrompt`.

### 11. Companion skills
- `space-cli-render-diagnostics` covers terminal render evidence (`TERMINAL_RENDER`, render proofs); `space-app-diagnostics` covers `APP_DEBUG` captures.
- `space-media-studio` covers screenshots and videos of the app for social posts and docs (device and social sizes, theme previews, a Studio room).
- Workflow skills (Superpowers, UI/UX Pro Max, Taste Skill, gstack and the others) are listed with descriptions by `space_inspect` section `SKILLS` and by the dispatcher's `space_list_skills`; this manual does not repeat them.

---

## 1-by-1 Tool Health Verification Procedure
When the operator asks to check all Space Control MCP tools one by one for problems (in any language):

1. **Invoke `space_test_mcp_tools`**:
   The tool automatically runs non-destructive tests across all 16 core functions:
   - Tool 1: `space_capabilities` -> Verifies protocol version and capability handshake.
   - Tool 2: `space_inspect:STATE` -> Verifies room inspection, pane enumeration, and capacity.
   - Tool 3: `space_inspect:MODELS` -> Verifies active model discovery and account identity.
   - Tool 4: `space_inspect:QUOTA` -> Verifies token quota providers.
   - Tool 5: `space_inspect:RUNTIMES` -> Verifies CLI runtime installation registry.
   - Tool 6: `space_inspect:SYSTEM_HEALTH` -> Verifies system health metrics and memory.
   - Tool 7: `space_inspect:SKILLS` -> Verifies installed agent skills discovery.
   - Tool 8: `space_inspect:SETTINGS` -> Verifies global configuration store.
   - Tool 9: `space_inspect:VOICE` -> Verifies voice transcription and provider credentials (including Vercel).
   - Tool 10: `space_inspect:PLUGINS` -> Verifies plugins service.
   - Tool 11: `space_execute:validation` -> Verifies dryRun command schema validation.
   - Tool 12: `space_operations` -> Verifies operations store and query interface.
   - Tool 13: `space_schedules` -> Verifies schedule manager.
   - Tool 14: `space_watches` -> Verifies task watch monitor.
   - Tool 15: `space_screenshot` -> Verifies screenshot pipeline readiness.
   - Tool 16: `voice_youtube_search` -> Verifies YouTube search endpoint.

2. **Evaluate Results**:
   - Each test returns `status: "PASS" | "FAIL" | "WARN"` with measured latency.
   - If any test fails, an incident is registered in `/opt/spaceapp/var/live-voice-logs/debug-incidents.jsonl` with an `agentHandoffPrompt`.
   - Reply in the operator's language with the number of passed tests, any failures and the exact reason. UI text stays English.

3. **Developer Agent Handoff**:
   - The `agentHandoffPrompt` in the incident record contains the exact error, operation, room, and recommended fix, allowing an agent to quickly repair the underlying issue.
