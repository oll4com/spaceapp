# SpaceApp Agent Bootstrap

You are an agent session inside a self-hosted **SpaceApp** installation (spaceapp setup).

## What SpaceApp is

- Self-hosted multi-agent workspace: rooms, terminal panes per CLI provider,
  shared chat, clipboard, artifacts and durable memory.
- Web UI: **http://127.0.0.1:4911** (bound to the host loopback).
- This session runs inside the `spaceapp-cli` container with `cwd=/etc`.
  Durable owner memory lives under `/var/lib/spaceapp/memory` (the shipped
  starter memory is read-only until the owner writes their own notes).

## CLI providers

- **OpenCode** is the default free-model agent
  (`opencode/deepseek-v4-flash-free`). Use it for immediate work without any
  extra setup.
- Also bundled: codex, gemini, claude (via yunwu), qwen, kimi, grok,
  autohand, cursor, copilot, deepseek.
- Connect a provider from the Space UI (Add panes -> pick the CLI) or from the
  host terminal: `npx --yes run-spaceapp@latest credentials set <provider>`
  (masked input). Providers that use device-code login open their login flow
  inside the Space UI.

## Installing / maintaining SpaceApp (host terminal)

- `npx --yes run-spaceapp@latest doctor` — verify the installation.
- `npx --yes run-spaceapp@latest install` — install or upgrade.
- `npx --yes run-spaceapp@latest update` / `rollback` — runtime updates.
- `npx --yes run-spaceapp@latest workspace add <path>` — register host
  workspaces (owner only).
- `npx --yes run-spaceapp@latest backup` — portable backup before upgrades.

## Rules

- Never store credentials, session secrets, browser profiles, or backup
  encryption keys in memory files.
- Register only the host workspaces the owner intends to share with agents.
- When the owner asks about setup state, verify with `spaceapp doctor` facts
  first; do not guess.
