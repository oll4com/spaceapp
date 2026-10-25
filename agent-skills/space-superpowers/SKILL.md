---
name: space-superpowers
description: "Superpowers (obra/superpowers) software development methodology for coding agents: brainstorming a design, writing and executing implementation plans, test-driven development, systematic debugging, code review, verification before completion and subagent-driven development. Use for feature work, bug fixing and planned changes where one of these methods helps, and whenever the operator asks for Superpowers."
metadata:
  category: WORKFLOW
---

# Superpowers in Space

An index of the 15 Superpowers skills. Read only the one the task needs, at
`<this folder>/<skill>/SKILL.md` (with MCP: `space_get_skill space-superpowers/<skill>`).
Upstream treats every skill as mandatory ("1% chance ... must invoke"). In Space
a skill is used when it fits the work or the operator asks for it, not merely
because it exists; quick questions, ops checks and small edits rarely need one.

## Defaults in Space

These two fit most coding work and are small; use them without a request when
the situation matches:

| Skill | When |
|---|---|
| [systematic-debugging](systematic-debugging/SKILL.md) | A bug, failing test or unexpected behaviour, before proposing a fix |
| [verification-before-completion](verification-before-completion/SKILL.md) | Before claiming work is done, fixed or passing |

## When the work calls for it

| Skill | When |
|---|---|
| [brainstorming](brainstorming/SKILL.md) | Shape an idea into a design before any code |
| [writing-plans](writing-plans/SKILL.md) | Turn a spec into a step-by-step plan |
| [executing-plans](executing-plans/SKILL.md) | Carry out a written plan yourself |
| [subagent-driven-development](subagent-driven-development/SKILL.md) | Carry out a plan with one subagent per task and reviews |
| [dispatching-parallel-agents](dispatching-parallel-agents/SKILL.md) | Two or more independent tasks at once |
| [test-driven-development](test-driven-development/SKILL.md) | Red-green-refactor for a feature or fix |
| [requesting-code-review](requesting-code-review/SKILL.md) | A reviewer pass on finished work (also used by the two plan executors) |
| [receiving-code-review](receiving-code-review/SKILL.md) | Acting on review feedback |
| [using-git-worktrees](using-git-worktrees/SKILL.md) | Isolated workspace for a feature |
| [finishing-a-development-branch](finishing-a-development-branch/SKILL.md) | Integrating finished work |
| [writing-skills](writing-skills/SKILL.md) | Test-driven skill writing (the default for skills is `space-anthropic-skills/skill-creator`) |
| [diagnosing-superpowers](diagnosing-superpowers/SKILL.md) | Why a Superpowers session went wrong |
| [using-superpowers](using-superpowers/SKILL.md) | Upstream's own entry point and per-harness tool notes (`using-superpowers/references/`) |

## In Space

Repository and operator instructions (`AGENTS.md`, `/opt/spaceapp/docs`) take precedence
over every Superpowers step. In particular:

- **Plans, specs and brainstorm files** go to
  `/var/lib/spaceapp-user/agent-workspace/active/<task>/` (or the Space clipboard as a
  PLAN record when the operator wants a plan), never into the repository, so
  `docs/superpowers/` and `.superpowers/` are not created in a project.
- **Worktrees**: Space worktrees come from `/opt/spaceapp/bin/space-worktree` under
  `/opt/spaceapp/var/worktrees/space/`; other scratch work uses
  `/var/lib/spaceapp-user/agent-workspace/active/`, not `.worktrees/`.
- **Integration**: finish Space work with `space-queue submit --worktree <wt>
  --summary "..." --wait`. Do not `git merge` into or `git push` from a shared
  branch; `finishing-a-development-branch`'s merge and push options do not apply.
- **No external reports**: `diagnosing-superpowers` must not open GitHub issues or
  send session transcripts anywhere; report findings to the operator.
- Commits, deploys and publishing still need the authorization the repository
  rules require; a workflow step is not that authorization.

Source and license: [UPSTREAM.md](UPSTREAM.md).
