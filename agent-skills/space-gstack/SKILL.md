---
name: space-gstack
description: Six workflow skills from Garry Tan's gstack. Use office-hours for product office hours before any code is written (is this worth building, design doc); plan-ceo-review for a CEO-level plan review (premise, scope expansion or reduction); plan-eng-review for an engineering plan review (architecture, data flow, edge cases, tests, performance) before implementation; retro for a weekly engineering retrospective from git history; test-audit for a test-suite value audit (low-value or duplicate tests); document-release for a release documentation audit after a change and before shipping.
metadata:
  category: WORKFLOW
---

# gstack Skills

Six skills from [garrytan/gstack](https://github.com/garrytan/gstack). Read the one the task needs and follow it.

| Skill | Use when | Read |
| --- | --- | --- |
| `office-hours` | Before any code: the user wants to brainstorm, test whether an idea is worth building, or think through a product idea or design direction. Produces a design doc. | [office-hours/SKILL.md](office-hours/SKILL.md) |
| `plan-ceo-review` | The user wants a plan challenged at CEO level: rethink the premise, expand or reduce scope, decide what is in and out. | [plan-ceo-review/SKILL.md](plan-ceo-review/SKILL.md) |
| `plan-eng-review` | A plan, design doc or branch diff needs an engineering review before implementation: architecture, data flow, diagrams, edge cases, test coverage, performance. | [plan-eng-review/SKILL.md](plan-eng-review/SKILL.md) |
| `retro` | The user asks for a weekly (or 24h, 14d, 30d) engineering retrospective or what shipped. | [retro/SKILL.md](retro/SKILL.md) |
| `test-audit` | The user asks to audit the test suite for low-value or duplicate tests and the test-only code they keep alive. Report-only unless a batch is approved. | [test-audit/SKILL.md](test-audit/SKILL.md) |
| `document-release` | After a change and before shipping: audit and update the docs against the diff (in the Space repository including `docs/SPACEAPP_CAPABILITIES_SPEC.md` and `AGENTS.md`). | [document-release/SKILL.md](document-release/SKILL.md) |

Typical order: `office-hours`, then `plan-ceo-review` (optional) and `plan-eng-review`, then the build, then `document-release`. `retro` and `test-audit` stand alone. For the build itself use Superpowers (`space-superpowers`: writing-plans, test-driven-development, systematic-debugging, requesting-code-review, verification-before-completion) and Claude Code's built-in `/code-review` and `/security-review`.

Each skill has a "Conventions" section. Outputs go to `/var/lib/spaceapp-user/agent-workspace/reports/YYYYMMDD-HHMM-<skill>/`, never into a repository. These skills never commit, push, open or edit PRs, merge, deploy or bump versions: commit in your own worktree only when the user asked for it, and ship through the merge queue (`space-queue submit --worktree <wt> --summary ... --wait`). Repository and operator instructions (`AGENTS.md`) take precedence.

Source and license: [UPSTREAM.md](UPSTREAM.md).
