---
name: space-huashu-design
description: Huashu Design (alchaincyf/huashu-design) for high-fidelity HTML design work - clickable prototypes and app mockups, slide decks with PDF/PPTX export, motion design and MP4/GIF export, infographics, design-direction variants and a five-dimension design critique. Use for design, UI/UX, mockup, visual-direction, redesign or design-review tasks; the operator's design policy pairs it with space-impeccable (impeccable for structure and the final polish/audit, huashu-design for the high-fidelity execution and variants). Not for production web apps or backends.
metadata:
  category: WORKFLOW
---

# Huashu Design

The full skill is [huashu-design/SKILL.md](huashu-design/SKILL.md) (written in Chinese). Read it first, then only the `references/` file it points to for the medium at hand: prototypes (`app-prototype.md`), slide decks (`slide-decks.md`, `editable-pptx.md`, `pptx-from-rendered-html.md`), motion and video (`animations.md`, `video-export.md`, `voiceover-pipeline.md`), critique (`critique-guide.md`), design directions (`design-styles.md`, `design-context.md`).

Core method: every new design starts with three distinct directions for the user to choose from; only the chosen one is taken to high fidelity, verified in a browser and then exported.

## In Space

Repository and operator instructions (`AGENTS.md`, `/etc/AGENTS.md`) take precedence over this skill.

- **Operator design policy (2026-04-28).** For design/UI/UX/mockup/visual-direction/review work (not Figma-native tasks) use `space-impeccable` for structure and quality gates, this skill for high-fidelity execution and variants, then `space-impeccable` again for the final polish and audit.
- **SpaceApp's own UI.** Prototypes are references, not code to paste: ship UI through the repository's React components and tests. All UI strings stay English, toggles use `SpaceToggle` (no checkboxes), and changes touching Warm, room switching or terminal resize keep their user-protected rules.
- **Language.** Reply to the user in the user's language even though the skill text is Chinese; write deliverable copy in the language the brief asks for.
- **Where files go.** Work and exports go to `/var/lib/spaceapp-user/agent-workspace/active/YYYYMMDD-HHMM-<topic>/` (scratch) or `.../reports/...`, never into the repository unless asked. Publish to Agent Files only when the user explicitly asks for the file.
- **Local only by default.** The core pipeline (HTML, browser render, PDF/PPTX/MP4 export) is local. The cloud helpers in `huashu-design/scripts/cloud/` (Volcengine video review, Doubao TTS) send content to ByteDance APIs and need the user's own keys: never run them, pass `--yes` or set `HUASHU_CLOUD_OK=1` without the operator's explicit consent for that run. See [huashu-design/SECURITY.md](huashu-design/SECURITY.md).
- **Tooling.** Use the browser and Playwright already available to the session; do not `npm install` the skill's `package.json` dependencies into a repository or globally without consent, and keep any install inside the task's scratch directory.
- **Not vendored.** The background music, sound effects (`assets/bgm-*.mp3`, `assets/sfx/**`) and showcase images (~31 MB) are not included. When a video task needs them, download only the needed files from the upstream commit in [UPSTREAM.md](UPSTREAM.md) into the task's scratch directory.

Source and license: [UPSTREAM.md](UPSTREAM.md).
