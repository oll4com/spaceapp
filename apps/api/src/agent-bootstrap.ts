export interface SpaceAgentBootstrapInput {
  channel: "WEB_CHAT" | "CLI";
  selectedToolIds?: string[] | null;
  activeBrowserSessionCount?: number;
  browserToolsEnabled?: boolean;
  currentMemoryMonth?: string;
  roomId?: string | null;
  paneId?: string | null;
  agentSessionId?: string | null;
  cliSessionId?: string | null;
  runtimeId?: string | null;
}

function currentMemoryMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

function selectedToolsLine(selectedToolIds: string[] | null | undefined): string | null {
  const selected = Array.from(new Set(selectedToolIds ?? [])).slice(0, 20);
  return selected.length ? `- Selected tools for this agent: ${selected.join(", ")}.` : null;
}

function identityLines(input: SpaceAgentBootstrapInput): string[] {
  const lines = [];
  if (input.roomId) lines.push(`- Space room id: ${input.roomId}.`);
  if (input.paneId) lines.push(`- Space pane id: ${input.paneId}.`);
  if (input.channel === "WEB_CHAT" && input.agentSessionId) lines.push(`- Space web agent session id: ${input.agentSessionId}.`);
  if (input.channel === "CLI" && input.cliSessionId) lines.push(`- Space CLI session id: ${input.cliSessionId}.`);
  if (input.runtimeId) lines.push(`- Space runtime id: ${input.runtimeId}.`);
  return lines;
}

function webChatMemoryBridgeLine(channel: SpaceAgentBootstrapInput["channel"]): string | null {
  if (channel !== "WEB_CHAT") return null;
  return [
    "- Web-chat memory bridge: to read/write Space memory, include one fenced block named space-memory-actions with JSON only.",
    '  Example: ```space-memory-actions\n{"version":1,"actions":[{"toolId":"memory:search","action":{"type":"search","q":"storage"}},{"toolId":"memory:save","action":{"type":"save","title":"Finding","body":"Short durable fact.","tags":["Space","storage"]}}]}\n```',
    "  V1 supports memory:search and memory:save, at most 3 actions per turn; ROOM scope defaults to the current room and save accepts up to 12 explicit tags."
  ].join("\n");
}

function webChatMcpBridgeLine(channel: SpaceAgentBootstrapInput["channel"]): string | null {
  if (channel !== "WEB_CHAT") return null;
  return [
    "- Web-chat MCP bridge: to request a selected MCP tool, include one fenced block named space-mcp-actions with JSON only.",
    '  Example: ```space-mcp-actions\n{"version":1,"actions":[{"toolId":"space-readonly:space_status","action":{"type":"execute","arguments":{"scope":"summary"}}}]}\n```',
    "  V1 supports at most 3 execute actions per turn. Do not include approvalReason; tools that require operator approval will return APPROVAL_REQUIRED."
  ].join("\n");
}

function webChatSkillBridgeLine(channel: SpaceAgentBootstrapInput["channel"]): string | null {
  if (channel !== "WEB_CHAT") return null;
  return [
    "- Web-chat skill bridge: to list/read selected Space skills, include one fenced block named space-skill-actions with JSON only.",
    '  Example: ```space-skill-actions\n{"version":1,"actions":[{"toolId":"skills:list","action":{"type":"list","q":"browser"}},{"toolId":"skills:read","action":{"type":"read","skillId":"planning"}}]}\n```',
    "  V1 supports skills:list and skills:read, at most 3 actions per turn. Disabled skills can be listed but not read as executable guidance."
  ].join("\n");
}

export function buildSpaceAgentBootstrapPrompt(input: SpaceAgentBootstrapInput): string {
  const memoryMonth = input.currentMemoryMonth ?? currentMemoryMonth();
  const browserState = input.browserToolsEnabled
    ? `${input.activeBrowserSessionCount ?? 0} active managed browser session(s) are visible in this room.`
    : "Managed browser tools are disabled until Space browser runtime gates pass.";
  const selectedLine = selectedToolsLine(input.selectedToolIds);
  const memoryBridgeLine = webChatMemoryBridgeLine(input.channel);
  const mcpBridgeLine = webChatMcpBridgeLine(input.channel);
  const skillBridgeLine = webChatSkillBridgeLine(input.channel);

  return [
    "Space Agent Bootstrap:",
    `- Channel: ${input.channel}. Match the main Codex /etc VS Code session rules where the runtime exposes them.`,
    ...identityLines(input),
    "- Bootstrap order: read/follow /opt/spaceapp/docs/gemini.md first, then Basic Rules in /opt/spaceapp/docs/gemini_core.md, then /opt/spaceapp/docs/agent_local_workspace_hygiene.md before local project/dev-server/cleanup work.",
    `- Canonical memory plane: /opt/spaceapp/docs/gemini_history.md plus /opt/spaceapp/docs/gemini_history_${memoryMonth}.md.`,
    "- Memory parity: read/search/save through Space memory bridge or Space API memory endpoints. Treat /opt/spaceapp/docs Gemini history as canonical operational memory; Codex ad-hoc notes are fallback only.",
    "- Task/goal parity: Codex goals live in /var/lib/spaceapp-user/.codex/goals_1.sqlite and are exposed through GET /api/tasks?source=codex_goal plus bounded PATCH /api/tasks/codex-goals/:threadId.",
    "- Skills parity: shared skills live under /var/lib/spaceapp-user/.codex/skills and plugin skill roots, exposed through skills:list and skills:read. Read the relevant SKILL.md before using a skill.",
    "- MCP/tool parity: discover/use tools through Space MCP policy only. Shared on-demand catalog context is documented in /opt/spaceapp/docs/gemini_session_coder_rooms.md.",
    "- Secret policy: never write raw provider credentials, cookies, browser profile data, private keys, or unredacted tokens to docs, chat, logs, memory, or transcripts.",
    "- Space API capability access: GET /api/memory and POST /api/memory for canonical Gemini memory; GET /api/tasks for shared Space/Codex tasks; GET /api/mcp and POST /api/mcp/tools/execute for approved MCP actions; GET /api/skills for skills.",
    skillBridgeLine,
    mcpBridgeLine,
    "- CLI capability access: GET /api/cli/runtimes, then Space-managed CLI sessions. Default real CLI runtime is cli:codex; gated providers must stay fail-closed.",
    `- Browser capability access: POST /api/panes/:id/browser/action through Space mediation only. ${browserState}`,
    memoryBridgeLine,
    "- Browser safety: no low-level browser protocol access, stream tickets, profile filesystem locations, stealth plugins, fingerprint spoofing, CAPTCHA bypass, localhost/private-IP browsing, or cookie/localStorage extraction.",
    selectedLine,
    "- If a capability is not available in the current runtime, report the exact missing Space gate instead of simulating it."
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function buildCliAgentBootstrapMarkdown(input: Omit<SpaceAgentBootstrapInput, "channel"> = {}): string {
  const memoryMonth = input.currentMemoryMonth ?? currentMemoryMonth();
  return `# Space CLI Agent Bootstrap

This CLI session is launched by Space. It uses a managed writable workspace only to persist the terminal session and uploads.

${buildSpaceAgentBootstrapPrompt({
  ...input,
  channel: "CLI",
  currentMemoryMonth: memoryMonth
})}

Operational workspace:

- Treat /etc as the default operational workspace for memory, infra, access, ops, and browser-facing tasks unless the user names another path.
- This artifact folder is not the project root. If the user asks about Space, use the real target path such as /opt/spaceapp.
- Prefer Space APIs for memory, MCP, skills, browser, artifact, and CLI capabilities when API auth is available.
- If a task explicitly requires /etc operational memory and the CLI has filesystem access, read/write the canonical Gemini files listed above.
- Use GET /api/tasks?source=codex_goal to inspect shared Codex goals; bounded updates go through PATCH /api/tasks/codex-goals/:threadId when Space API auth is available.
- Space sets non-secret identity environment variables for this process:
  SPACE_AGENT_CHANNEL, SPACE_ROOM_ID, SPACE_PANE_ID, SPACE_CLI_SESSION_ID, SPACE_CLI_RUNTIME_ID, and SPACE_AGENT_RUNTIME_ID.
  For direct Codex parity launches, Space also mirrors SPACE_CLI_SESSION_ID into CODEX_MCP_SESSION_ID so MCP wrapper/session evidence can correlate to the live CLI pane.
  Space auth cookies, internal API tokens, browser stream tickets, and provider keys are intentionally not provided as Space identity variables.

Tool and skill access:

- Shared skills live under /var/lib/spaceapp-user/.codex/skills. Read the relevant SKILL.md on demand before using a skill.
- Shared MCP/tool catalog context is documented in /opt/spaceapp/docs/gemini_session_coder_rooms.md.
- Do not install per-session tool copies. Call shared tools only when the task needs them.
`;
}
