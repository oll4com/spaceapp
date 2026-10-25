---
name: handoff
description: Compact the current conversation into a handoff document for another agent to pick up.
argument-hint: "What will the next session be used for?"
disable-model-invocation: true
---

Write a handoff document summarising the current conversation so a fresh agent can continue the work. Save to the temporary directory of the user's OS (`$TMPDIR`, else `/tmp`; `%TEMP%` on Windows) - not the current workspace.

Include a "suggested skills" section in the document, naming which skills the next agent should call the Skill tool for.

Do not duplicate content already captured in other artifacts (specs, plans, ADRs, issues, commits, diffs). Reference them by path or URL instead.

Redact any sensitive information, such as API keys, passwords, or personally identifiable information.

If the user passed arguments, treat them as a description of what the next session will focus on and tailor the doc accordingly.

## In Space

- On the Space host, save the document as `/var/lib/spaceapp-user/agent-workspace/reports/YYYYMMDD-HHMM-handoff/handoff.md`, where Space keeps reports and temporary files. Use the OS temporary directory only when that root does not exist. Never save it inside a repository or worktree.
- The next agent may run in another pane or another CLI (Codex, Claude Code, OpenCode, ...). Name skills by their installed names, for example `space-superpowers`, and state the worktree path, branch, last commit, uncommitted files and any merge-queue ticket with its state.
- Never include `.env` values, session cookies, tokens or operator passwords, even partially.
- Do not publish the handoff to Agent Files unless the user explicitly asks for a file.
