---
name: space-control-mcp
description: Comprehensive directory and operational manual for all Space Control MCP tools, resources, inspect sections, debug incident diagnostics, and step-by-step 1-by-1 tool health verification.
metadata:
  category: SYSTEM_CONTROL
---

# Space Control MCP Guide & Verification Manual

## Overview
Space Control MCP (`version: space-control-v1`) provides authoritative, safe, audited control over SpaceApp rooms, panes, CLI runtimes, layouts, media playback, clipboard, schedules, and agent watches. It bridges the SpaceApp backend, native CLI agents, and the real-time AI Voice assistant.

## Core MCP Tools Catalog

### 1. `space_capabilities`
- **Purpose**: Discovers room boundaries, supported modes, CLI runtimes, model aliases, and operations before targeting panes.
- **Parameters**: `roomId` (optional string).
- **Output**: JSON payload with `version`, `supportedActions`, `limits` (maxPanesAllowed, maxActionsPerRequest), and `runtimes` catalog.

### 2. `space_inspect`
- **Purpose**: Authoritative inspection across 19 system and room domains.
- **Parameters**: `section` (enum of 19 sections), `roomId` (optional), `paneId` (optional), `query` (optional), `offset` (int), `limit` (int).
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
  - `SKILLS`: Installed and registered agent skills with markdown guides.
  - `SETTINGS`: Complete sanitized app settings across CLI, providers, tools, task titles, plugins, voice, and appearance.
  - `ROOMS`: List of all user rooms with metadata and pane counts.
  - `SYSTEM_HEALTH`: Realtime health metrics, CPU/memory, active services, and API error rates.
  - `PLUGINS`: Installed plugins, connection status, and enabled agent capabilities.
  - `MODULES`: Discoverable UI navigation groups, docks, tool surfaces, and feature flags.
  - `VOICE`: Voice transcription settings, local/cloud provider status, and supported speech models.
  - `LINKS`: Workspace bookmark links and metadata.
  - `TASKS`: Task items, objectives, completion status, and room linkages.
  - `AUDIT`: Audit trail of recent Space Control actions and mutations.

### 3. `space_execute`
- **Purpose**: Applies validated atomic batches of Space controls.
- **Parameters**: `roomId`, `requestId`, `actions` (array of action objects), `dryRun` (boolean), `waitForCompletion` (boolean).
- **Supported Operations**:
  - `panes.open`: Open any of the 17 supported pane types (codex, opencode, gemini, claude, qwen, kimi, grok, deepseek, cursor, copilot, hermes, autohand, browser, youtube, vnc, chat, harness). Supports batching and `debug: true`.
  - `pane` operations: `close`, `restart`, `start`, `resume`, `stop`, `cancel`, `continue`, `prompt`, `minimize`, `maximize`, `restore`, `color`.
  - `layout` operations: `sort`, `apply`, `tree`, `save`, `restore`.
  - `playback` operations: `play`, `pause`, `next`, `previous`, `seek`, `volume`, `mute`, `unmute`.
  - `clipboard` operations: `save`, `complete`, `delete`.
  - `ui.theme`: Change room UI theme.
  - `ui.scale`: Adjust zoom and terminal font size.

### 4. `space_screenshot`
- **Purpose**: Captures full-screen visual state of SpaceApp for Vision AI analysis.
- **Parameters**: `roomId`, `format` (jpeg/png/webp), `quality`, `maxWidth`, `maxHeight`.

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

### 11. `space-cli-render-diagnostics` (Companion Skill & Tool)
- **Purpose**: Operational skill and automated audit tool for CLI terminal graphical rendering, stream integrity, partial screen coverage detection, dimension stress (down to minimal 20x8), dynamic in-flight resizing, and >50k token long-task verification.
- **Reference**: See [space-cli-render-diagnostics](../space-cli-render-diagnostics/SKILL.md) and script `/opt/spaceapp/scripts/space-cli-render-audit.mjs`.

### 12. `space-superpowers` (Companion Workflow Skill)
- **Purpose**: Complete software development methodology for coding agents: test-driven development (TDD), 4-phase systematic debugging, verification before completion, implementation planning, brainstorming, and subagent-driven development.
- **Reference**: See [space-superpowers](../space-superpowers/SKILL.md).

### 13. `space-ui-ux-pro-max` (Companion Design Intelligence Skill)
- **Purpose**: UI/UX design intelligence across web, mobile, and desktop: 79 searchable UI styles, 192 product palettes, 74 font pairings, 119 UX guidelines, resilient text layout, accessibility, and 22 technology stacks.
- **Reference**: See [space-ui-ux-pro-max](../space-ui-ux-pro-max/SKILL.md).

### 14. `space-taste-skill` (Companion Frontend Aesthetic Skill)
- **Purpose**: Anti-slop frontend design framework for web and mobile interfaces. Enforces modern typography, contrast, spacing, and micro-interactions, stopping AI agents from generating templated interfaces.
- **Reference**: See [space-taste-skill](../space-taste-skill/SKILL.md).

### 15. `space-no-ai-slop` (Companion Content Refinement Skill)
- **Purpose**: Editorial and writing refinement skill for documentation, release notes, and technical writing. Detects and eliminates 20+ AI slop clichés and robotic patterns while preserving the writer's authentic voice.
- **Reference**: See [space-no-ai-slop](../space-no-ai-slop/SKILL.md).

---

## 1-by-1 Tool Health Verification Procedure
When asked: *"έλεγξε όλα τα εργαλεία του mcp ένα προς ένα και δες για προβλήματα"* (check all MCP tools one by one and check for problems):

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
   - The assistant replies in fluent Greek summarizing the number of passed tests, any failures, and the exact reason.

3. **Developer Agent Handoff**:
   - The `agentHandoffPrompt` in the incident record contains the exact error, operation, room, and recommended fix, allowing an agent to quickly repair the underlying issue.
