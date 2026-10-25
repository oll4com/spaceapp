---
name: space-mattpocock-skills
description: Matt Pocock's handoff and git-guardrails skills. Use when the user asks for a handoff document so another agent or CLI can continue the work, or asks to block dangerous git commands (push, reset --hard, clean, branch -D) in Claude Code with a hook.
metadata:
  category: WORKFLOW
---

# Matt Pocock Skills

Two skills from [mattpocock/skills](https://github.com/mattpocock/skills). Read the one the task needs and follow it.

| Skill | Use when | Read |
| --- | --- | --- |
| `handoff` | The user asks to hand the current work to a fresh agent, another pane, or another CLI. Only on request. | [handoff/SKILL.md](handoff/SKILL.md) |
| `git-guardrails-claude-code` | The user asks to block destructive git commands in Claude Code. | [git-guardrails-claude-code/SKILL.md](git-guardrails-claude-code/SKILL.md) |

Both skills have an "In Space" section. Repository and operator instructions (`AGENTS.md`) take precedence.

Source and license: [UPSTREAM.md](UPSTREAM.md).
