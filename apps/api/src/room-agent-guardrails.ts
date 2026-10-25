/**
 * Deterministic limits on what the Room Agent may approve in a pane by itself.
 *
 * PROTECTED: approvals the repository rules reserve for the operator (AGENTS.md: Warm and room switch,
 * terminal resize presentation, the minimized-bar toggle, the 2026-10-07 locks, stable promotion and
 * hotfix approval, queue resume, Agent Files, version bumps, pushes, secrets, the live checkout and
 * host services). The Room Agent never answers these; it would launder the operator's approval.
 * DESTRUCTIVE: irreversible commands. Also reserved for the operator.
 * Pane text is untrusted, so the check runs on the screen itself, never on the model's summary of it.
 */
export type RoomAgentApprovalLevel = "SAFE" | "DESTRUCTIVE" | "PROTECTED";

export interface RoomAgentApprovalVerdict {
  level: RoomAgentApprovalLevel;
  reasons: string[];
}

const protectedRules: Array<[string, RegExp]> = [
  ["Warm and room-switch code", /\bwarm[- ]?(?:room|cache|code|resident|runtime|budget|pane)|room[- ]switch|space_room_switch_performance_baseline|use-warm|warm-room/i],
  ["terminal resize presentation", /terminal-resize-presentation|data-terminal-resize-frame|anti-?flicker|initialPopulatedLines|requiredPopulatedLines/i],
  ["minimized pane bar toggle", /minimizedBarToggle|data-rail-id="?minimized-bar|MinimizedPaneBar/i],
  ["stable promotion and queue control", /space-queue\s+(?:promote|default-target|resume|approve|pause)\b|--target\s+stable|--hotfix\b/i],
  ["host service restart", /systemctl\s+(?:restart|stop|kill|disable)\b[^\n]*(?:pane-host|browser-host|space-|memory-worker|temporal)|codex-pane-host\.service|space-browser-host\.service/i],
  ["direct deploy", /space-deploy-commit|space_deploy_commit|space-queue-deploy\.sh|space-ship\.sh\s+deploy\s+--target\s+stable/i],
  ["Agent Files publishing", /space-publish-file|\bagent files\b/i],
  ["version bump", /space-version\s+bump|\bversion bump\b|npm\s+version\s+(?:patch|minor|major)/i],
  ["git push", /\bgit\s+push\b/i],
  ["secrets and credentials", /(?:^|[\s"'/])\.env\b|\bsecrets?\/|\bpassword\b|\bcredentials?\b|\bapi[_-]?key\b|space_session|SPACE_SESSION_SECRET|\.secret\b|id_(?:rsa|ed25519)/i],
  // The path is written plainly so the public export's path rewrite reaches it (a \/ escape hides it).
  ["live Space checkout", new RegExp("/opt/spaceapp/(?!var/worktrees/|var/artifacts/)(?:apps|packages|scripts|deploy|docs|bin)/", "i")],
  ["operator-only Space files", /\/etc\/(?:AGENTS\.md|docs\/)/i]
];

const destructiveRules: Array<[string, RegExp]> = [
  ["recursive delete", /\brm\s+(?:-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|--recursive|-r\b)|\brmdir\b|find\s[^\n]*-delete\b/i],
  ["git history rewrite", /git\s+(?:reset\s+--hard|clean\s+-[a-z]*[fdx]|checkout\s+--\s|restore\s+--source|branch\s+-D|rebase\b|stash\s+(?:drop|clear)|filter-(?:branch|repo)|push\s+(?:-f|--force))/i],
  ["database destruction", /\bdrop\s+(?:table|database|schema|index)\b|\btruncate\s+(?:table\s+)?\w|\bdelete\s+from\b|\bdropdb\b/i],
  ["disk or system command", /\bmkfs\b|\bdd\s+if=|\bshutdown\b|\breboot\b|\bpoweroff\b|chmod\s+-R\s+0?777|chown\s+-R\s/i],
  ["process kill", /\bkill\s+-9\b|\bpkill\b|\bkillall\b/i],
  ["room or pane deletion", /delete (?:this |the )?(?:room|pane)s?\b|close all panes|archive (?:the )?room/i]
];

export function classifyPaneApproval(screen: string): RoomAgentApprovalVerdict {
  // The prompt and the action it asks about sit at the bottom of the screen.
  const recent = screen.split("\n").slice(-40).join("\n");
  const match = (rules: Array<[string, RegExp]>) => rules.filter(([, pattern]) => pattern.test(recent)).map(([reason]) => reason);
  const protectedReasons = match(protectedRules);
  if (protectedReasons.length) return { level: "PROTECTED", reasons: protectedReasons };
  const destructiveReasons = match(destructiveRules);
  if (destructiveReasons.length) return { level: "DESTRUCTIVE", reasons: destructiveReasons };
  return { level: "SAFE", reasons: [] };
}
