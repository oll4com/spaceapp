---
name: space-claude-security
description: Anthropic's security review prompt (anthropics/claude-code-security-review) for a focused, high-confidence review of the pending changes on a branch - injection, authentication and authorization, crypto and secrets, code execution and deserialization, data exposure - with a false-positive filtering pass. Use when the operator asks for a security review of a change, a branch or a worktree before it ships.
metadata:
  category: WORKFLOW
---

# Claude Security Review

The prompt is [security-review/security-review.md](security-review/security-review.md), the repository's `/security-review` command for Claude Code. Follow it with these adjustments.

- **The diff.** Claude Code runs the `` !`git ...` `` lines itself; other CLIs run those git commands first and read their output. Compare against the base the change ships onto: `origin/HEAD` in an ordinary repository, `dev` in a Space worktree (`git diff --merge-base dev`, `git log --no-decorate dev..HEAD`).
- **Sub-tasks.** The prompt runs the review and one false-positive filter per finding as sub-tasks. Use your CLI's sub-agents when it has them; otherwise do the filtering pass yourself and keep only findings with confidence 8 or higher.
- **Read-only.** Report the findings in the conversation in the prompt's markdown format (file, line, severity, category, exploit scenario, fix). Do not change code unless the operator asks, and never print a secret you find: name its file and line.
- **Space boundaries.** Repository and operator instructions (`AGENTS.md`) take precedence. Space ships through the merge queue, so the upstream GitHub Action is not part of this skill. Claude Code's built-in `/security-review` is equivalent.

Source and license: [UPSTREAM.md](UPSTREAM.md).
