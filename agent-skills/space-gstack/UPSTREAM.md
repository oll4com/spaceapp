# Upstream

- Repository: https://github.com/garrytan/gstack
- Commit: `e23f7b807ff4788f6d7c90af2ab82960bd8c5851`
- License: MIT (full text below)

## Files

| Space file | Upstream source |
| --- | --- |
| `office-hours/SKILL.md` | `openclaw/skills/gstack-openclaw-office-hours/SKILL.md` |
| `plan-ceo-review/SKILL.md` | `openclaw/skills/gstack-openclaw-ceo-review/SKILL.md` |
| `retro/SKILL.md` | `openclaw/skills/gstack-openclaw-retro/SKILL.md` |
| `plan-eng-review/SKILL.md` | `plan-eng-review/SKILL.md` (generated from `SKILL.md.tmpl`) |
| `plan-eng-review/sections/review-sections.md` | `plan-eng-review/sections/review-sections.md` |
| `test-audit/SKILL.md` | `test-audit/SKILL.md` |
| `document-release/SKILL.md` | `document-release/SKILL.md` |
| `document-release/sections/audit-scope.md` | `document-release/sections/audit-scope.md` |
| `document-release/sections/release-body.md` | `document-release/sections/release-body.md` |

`SKILL.md` (this folder's index) is new. Not copied: `plan-eng-review/sections/checklist.md` (runner profile for gstack's autoplan only), the `sections/manifest.json` files, the `*.tmpl` sources, and gstack's binaries, hooks and other skills.

## Space changes

Every modified file carries a `Modified by SpaceApp (2026-10-12)` notice.

All sub-skills:

- Front matter reduced to `name` and a one-sentence `description`; `preamble-tier`, `version`, `allowed-tools`, `triggers`, `hooks`, `gbrain` and the AUTO-GENERATED comments dropped.
- The generated preamble (Preamble through Plan Status Footer: `gstack-skill-start`, Artifacts Sync, Model-Specific Behavioral Patch, Voice, Context Recovery, Writing Style, Boil the Ocean, Confusion Protocol, Claims Need Evidence, Context Health, Question Tuning, Repo Ownership, Search Before Building, Completion Status Protocol, Operational Self-Improvement, Telemetry) replaced by a short Space `## Conventions` section. The OpenClaw skills had no preamble and gained the same section.
- Outputs go to `/var/lib/spaceapp-user/agent-workspace/reports/YYYYMMDD-HHMM-<skill>/` instead of `$GSTACK_STATE_ROOT/projects/$SLUG` (`~/.gstack`) or OpenClaw `memory/`; `gstack-slug`, `gstack-paths` and `gstack-config` calls replaced by plain shell.
- No skill commits, pushes, opens or edits PRs, merges, deploys or bumps versions. `/ship`, `git push` and `gh pr ...` steps replaced by: commit in your own worktree only when the user asked for it, and ship through the merge queue (`space-queue submit --worktree <wt> --summary ... --wait`).
- References to skills not shipped here removed (`/qa`, `/qa-only`, `/review`, `/plan-design-review`, `/plan-devex-review`, `/autoplan`, `/codex review`, `/document-generate`, `/gstack-upgrade`, `/plan-tune`), together with the Codex "outside voice" and its native fallback, Aside web research and the `$B`/`$D` plan-mode entries, Context Recovery (`gstack-context-recovery`), Brain Context and Brain Cache (`gstack-brain-cache`), learnings logging (`gstack-learnings-log`, `gstack-learnings-search`), decision and question logs (`gstack-decision-log`, `gstack-question-log`), the review log and review readiness dashboard (`gstack-review-log`, `gstack-review-read`), plan-reality rows (`gstack-plan-reality`), the implementation-model hint (`gstack-models`) and telemetry (`gstack-skill-start`, `gstack-skill-end`). The selected upstream files contain no `/cso`, `/browse`, `/benchmark`, `/canary`, `/land-and-deploy`, Greptile, `gstack-gate-diff`, `gstack-next-version` or mode-handoff references.

Per skill:

- `office-hours`: design doc saved to the reports directory instead of `memory/`; "Garry's Note" (Y Combinator promotion and ycombinator.com links) removed; Signal Reflection kept.
- `plan-ceo-review`: review summary saved to the reports directory instead of `memory/`.
- `retro`: in the Space repository it reads `origin/dev` (work lands on `dev` first through the merge queue) and falls back to the local branch when there is no `origin` remote; history is a JSON snapshot in the reports directory plus a summary saved with `node /opt/spaceapp/scripts/memory-save.mjs` and found again with `node /opt/spaceapp/scripts/memory-recall.mjs`, instead of OpenClaw `memory/`; "Format for Telegram" removed.
- `plan-eng-review`: Scope gate, startup sequence and Plan Mode Safe Operations rewritten without gstack tooling; the Conventions section carries the D-numbered decision-question format and completeness score the review uses; Design Doc Check reads `office-hours` design docs from the reports directory (replacing `gstack-design-doc-find`) and the prerequisite offer reads `../office-hours/SKILL.md`; search check uses WebSearch; the selected plan file is used as the report file only when it lies outside a repository; Prior Learnings, Calibration learning, plan-reality rows, Outside Voice, the autoplan JSONL task artifact, Review Log, Review Readiness Dashboard, Learning hooks and Brain Calibration Write-Back removed; the terminal report renamed `## ENG REVIEW REPORT` with CEO and Eng rows only and the review-log field rules kept as status rules; the Test Plan is written to `test-plan-{branch}-{datetime}.md` in the reports directory; next steps offer `plan-ceo-review` or the merge queue.
- `test-audit`: report and JSON sidecar written to the reports directory; seeds read from `plan-eng-review` test plans there; non-interactive runs detected without gstack session markers; landing through the merge queue instead of `/ship`.
- `document-release`: platform detection reads git remotes only (no `gh`/`glab` calls); Space base branch (`dev`) noted; ship-owned documentation mode, `gstack-banned-terms`, the Codex documentation review, commit/push and PR/MR body and title updates (`gh pr edit`, `glab mr update`, `gstack-redact`, `gstack-issue-guard`) removed; `docs/SPACEAPP_CAPABILITIES_SPEC.md` (enforced by `space-version verify` on version bumps) and `AGENTS.md` added to the audit; the VERSION step only recommends, because version bumps are operator decisions (`space-version bump`), replacing `gstack-version-bump`; Step 9 writes a documentation report (doc diff preview, documentation debt, version recommendation) to the reports directory.

Everything else (questions, review sections, checklists, test value bar, retirement cards, coverage map) is unchanged.

## License

MIT License

Copyright (c) 2026 Garry Tan

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
