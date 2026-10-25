---
name: space-google-workspace
description: Google Workspace CLI (googleworkspace/cli, gws 0.22.5) skills for Gmail, Drive, Calendar, Sheets, Docs, Slides, Chat, Meet, Forms, Tasks, Keep, People, Classroom, Apps Script and Admin reports, plus workflow recipes and personas. Use when the operator asks an agent to read or change their Google Workspace data through gws. Needs the operator's one-time gws sign-in; inside a Mail Copilot pane use space_mailcopilot instead.
metadata:
  category: TOOL_ADAPTER
---

# Google Workspace CLI

The upstream skills sit next to this file. Read [gws-shared/SKILL.md](gws-shared/SKILL.md) first (authentication, global flags, output formats, security rules), then only the skill the task needs: a service (`gws-gmail/`, `gws-drive/`, `gws-calendar/`, ...), a helper (`gws-gmail-send/`, `gws-sheets-append/`, ...), a `recipe-*` or a `persona-*`. `ls` in this folder lists all 95; each frontmatter `description` says what it does. `gws <service> --help` and `gws schema <method>` show the live API surface.

## In Space

Repository and operator instructions (`AGENTS.md`, `/etc/AGENTS.md`) take precedence over these skills.

- **Binary.** The pinned gws 0.22.5 is installed for the operator account as `~/.local/bin/gws` (a link to `~/.local/lib/gws/0.22.5/gws`; checksum in [UPSTREAM.md](UPSTREAM.md)). If `gws --version` does not print `gws 0.22.5`, stop and tell the operator. Do not install, update or rebuild gws (`npm install -g @googleworkspace/cli`, `cargo install`, `nix`), and ignore the upstream hint to run `gws generate-skills`: these skills are vendored.
- **Sign-in belongs to the operator.** Run `gws auth status`; when `auth_method` is `none`, stop and ask the operator to sign in (the upstream README describes `gws auth setup`, `gws auth login` and the headless export flow). Never run `gws auth login`, `setup`, `export` or `logout`, and never read, print or copy anything under `~/.config/gws/` or the values of `GOOGLE_WORKSPACE_CLI_TOKEN` and `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE`.
- **Writes leave the host.** Sending, replying, forwarding, inviting, sharing, changing permissions, deleting or trashing, filters, vacation responders and events with guests need the operator's approval of that exact action in the current conversation. Run the command with `--dry-run` first and show what it will do. Reads stay within the scope of the task.
- **Mail Copilot.** Inside a Mail Copilot pane use the `space_mailcopilot` tools (its own accounts, autonomy levels and reviews), not gws.
- **Model Armor.** `gws-modelarmor*` and `--sanitize` call a Google Cloud API in the operator's project; use them only when asked.
- **Where files go.** Downloads and exports go to `/var/lib/spaceapp-user/agent-workspace/active/YYYYMMDD-HHMM-<topic>/`; never commit them. Publish to Agent Files only when the user explicitly asks for the file.

Source and license: [UPSTREAM.md](UPSTREAM.md).
