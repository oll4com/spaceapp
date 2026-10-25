---
name: space-impeccable
description: Impeccable (pbakaus/impeccable) for frontend design quality - shaping new surfaces, redesigns, critique and audits, polish, typography, color, layout, motion, UX copy, hardening, accessibility and live browser iteration on UI elements. Use for design, UI/UX, mockup, redesign or design-review tasks; the operator's design policy uses it first for structure and quality gates and last for the final polish and audit, with space-huashu-design for the high-fidelity execution and variants in between. Not for backend-only work.
metadata:
  category: WORKFLOW
---

# Impeccable

The full skill is [impeccable/SKILL.md](impeccable/SKILL.md). Follow its Setup, then load only the reference its Commands table names for the request (for example `critique`, `audit`, `polish`, `layout`, `typeset`, or `new-work` for a new surface).

## In Space

Repository and operator instructions (`AGENTS.md`, `/etc/AGENTS.md`) take precedence over this skill.

- **Operator design policy (2026-04-28).** For design/UI/UX/mockup/visual-direction/review work (not Figma-native tasks): `impeccable` for structure and quality gates, then `space-huashu-design` for high-fidelity execution and variants, then `impeccable` again for the final polish and audit.
- **Engine.** The pinned engine 0.1.14 is preinstalled on the Space host as `/usr/local/bin/impeccable` (a wrapper that keeps telemetry and update checks off), so the skill's launcher `impeccable/scripts/impeccable` finds it on `PATH` and never downloads anything. If `impeccable engine-probe` does not print `impeccable-engine 0.1.14`, stop and tell the operator; do not let the launcher download an engine, and do not set `IMPECCABLE_DOWNLOAD_BASE`, `IMPECCABLE_BIN` or `IMPECCABLE_HOME` to work around it.
- **No installs or hooks.** Do not run `npx impeccable install`, `update` or `telemetry on`, and do not turn the design detector hook on (`impeccable hooks on`) or write hook manifests into any CLI configuration without the operator's explicit consent for that change.
- **Network.** Starting a new design asks the roll API at impeccable.style for a hand of visual directions; it sends random keys and catalog ids, never project files. Nothing else should reach the network.
- **SpaceApp's own UI.** The repository's components, tests and rules win over generated designs: English-only UI strings, `SpaceToggle` instead of checkboxes, and the user-protected Warm, room-switch and terminal-resize rules. Do not commit `PRODUCT.md`, `DESIGN.md` or `.impeccable/` files to the Space repository unless the user asks.
- **Live mode** drives a browser against a local development server you started for the task; never point it at the operator's authenticated Space session.
- **Where files go.** Scratch work and exports go to `/var/lib/spaceapp-user/agent-workspace/active/YYYYMMDD-HHMM-<topic>/` or `.../reports/...`. Publish to Agent Files only when the user explicitly asks for the file.

Source and license: [UPSTREAM.md](UPSTREAM.md).
