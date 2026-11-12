# Upstream

- Repository: https://github.com/Panniantong/agent-reach
- Commit: `1221ecd0c3e0502ee37406f03543bedf7503f2c7` (agent-reach 1.5.0, 2026-08-06), the `main` public-host installed on 2026-08-09:
  its 50 package files and these 8 skill files match public-host's `~/.agent-reach-venv` and `~/.agents/skills/agent-reach` byte for byte.
- License: MIT, `LICENSE` (copied unchanged).

## Files

- `agent_reach/skill/SKILL.md` → `SKILL.md`, `agent_reach/skill/references/{career,dev,finance,search,social,video,web}.md` → `references/`.

Not copied: `agent_reach/skill/SKILL_en.md` (public-host's agents loaded `SKILL.md`).

## Space changes

- `SKILL.md`: the name gained the `space-` prefix, and an "In Space" section was added (the CLI is pinned; never update it from
  upstream or PyPI). Everything else is unchanged.

## CLI

`scripts/space-operator-install.sh prereqs` builds `~/.agent-reach-venv` from `deploy/agent-reach-requirements.txt` (public-host's venv, every
package pinned by sha256) and links `agent-reach` into `~/.local/bin` and `bili`, `rdt`, `twitter`, `yt-dlp` into `/usr/local/bin`, as on
public-host. The Video engine runs that `/usr/local/bin/yt-dlp`.
