import { describe, expect, it } from "vitest";
import { classifyPaneApproval } from "../src/room-agent-guardrails.js";
import { roomApprovalPromptCue, roomPromptFingerprint } from "../src/room-terminal-screen.js";

const prompt = (body: string) => `${body}\n\nDo you want to proceed?\n❯ 1. Yes\n  2. Yes, and don't ask again\n  3. No`;

describe("Room Agent approval guardrails", () => {
  it.each([
    ["Edit apps/web/src/features/rooms/use-warm-room-cache.ts", "PROTECTED", "Warm and room-switch code"],
    ["Update apps/web/src/features/terminal-pane/terminal-resize-presentation.ts", "PROTECTED", "terminal resize presentation"],
    ["Bash: space-queue promote", "PROTECTED", "stable promotion and queue control"],
    ["Bash: space-queue submit --worktree . --target stable --hotfix", "PROTECTED", "stable promotion and queue control"],
    ["Bash: space-queue resume --reason fixed", "PROTECTED", "stable promotion and queue control"],
    ["Bash: git push github main", "PROTECTED", "git push"],
    ["Bash: /opt/spaceapp/bin/space-publish-file --folder Logos logo.svg", "PROTECTED", "Agent Files publishing"],
    ["Bash: /opt/spaceapp/bin/space-version bump core patch", "PROTECTED", "version bump"],
    ["Read /opt/spaceapp/.env", "PROTECTED", "secrets and credentials"],
    ["Write /opt/spaceapp/apps/api/src/app.ts", "PROTECTED", "live Space checkout"],
    ["Bash: sudo systemctl restart codex-pane-host.service", "PROTECTED", "host service restart"],
    ["Bash: rm -rf build", "DESTRUCTIVE", "recursive delete"],
    ["Bash: git reset --hard origin/dev", "DESTRUCTIVE", "git history rewrite"],
    ["Bash: psql -c 'DROP TABLE panes'", "DESTRUCTIVE", "database destruction"],
    ["Bash: pkill -f node", "DESTRUCTIVE", "process kill"]
  ])("escalates %s", (body, level, reason) => {
    const verdict = classifyPaneApproval(prompt(body));
    expect(verdict.level).toBe(level);
    expect(verdict.reasons).toContain(reason);
  });

  it.each([
    "Bash: npm test -w @space/api -- room-agent.test.ts",
    "Edit /opt/spaceapp/var/worktrees/space/wt-abc/apps/api/src/room-agent.ts",
    "Bash: space-queue submit --worktree /opt/spaceapp/var/worktrees/space/wt-abc --summary \"fix\" --wait",
    "Bash: git commit -m \"feat: add room snapshot\"",
    "Ready to code? Here is the plan: add a pane strip to the dock. Would you like to proceed?"
  ])("lets the Room Agent decide %s", (body) => {
    expect(classifyPaneApproval(prompt(body))).toEqual({ level: "SAFE", reasons: [] });
  });

  it("only reads the bottom of the screen, where the prompt is", () => {
    const old = Array.from({ length: 60 }, (_, index) => index === 0 ? "git push earlier output" : `line ${index}`).join("\n");
    expect(classifyPaneApproval(`${old}\n${prompt("Bash: npm run build")}`).level).toBe("SAFE");
  });

  it("recognises approval prompts but not session pickers", () => {
    expect(roomApprovalPromptCue(prompt("Bash: ls"))).toBe(true);
    expect(roomApprovalPromptCue("Allow command?\n  Allow once   Allow always   Deny")).toBe(true);
    expect(roomApprovalPromptCue("Resume a session\n❯ Fix login (2h ago)\n  Add pane strip (1d ago)\nEnter to select")).toBe(false);
  });

  it("fingerprints the question on screen and ignores spacing", () => {
    const a = roomPromptFingerprint(prompt("Bash: ls"));
    expect(a).toMatch(/^[a-f0-9]{16}$/);
    expect(roomPromptFingerprint(`\n\n${prompt("Bash:   ls")}  \n`)).toBe(a);
    expect(roomPromptFingerprint(prompt("Bash: rm -rf /tmp/x"))).not.toBe(a);
  });
});
