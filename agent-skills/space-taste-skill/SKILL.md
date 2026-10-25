---
name: space-taste-skill
description: "Taste Skill (Leonxlnx/taste-skill) visual-direction variants for marketing-style web pages, opt-in: use when the operator asks for taste-skill or for a premium, anti-template look on a landing page, portfolio or site redesign. For product UI, dashboards and apps such as Space use space-ui-ux-pro-max instead."
metadata:
  category: WORKFLOW
---

# Taste Skill in Space

An index of the 13 Taste Skill variants. Read only the variant the task needs, at
`<this folder>/<variant>/SKILL.md` (with MCP: `space_get_skill space-taste-skill/<variant>`).
They target landing pages, portfolios and redesigns, not dashboards, data
tables or multi-step product UI; for those use `space-ui-ux-pro-max`.

## Default

| Variant | Use |
|---|---|
| [taste-skill](taste-skill/SKILL.md) (`design-taste-frontend`, v2, 87 KB) | The main skill: read the brief, infer a direction, build the page. Load it only for the page work itself. |

## Other variants

| Variant | Use |
|---|---|
| [redesign-skill](redesign-skill/SKILL.md) | Audit and upgrade an existing site |
| [minimalist-skill](minimalist-skill/SKILL.md) | Editorial, warm monochrome, flat bento |
| [soft-skill](soft-skill/SKILL.md) | High-end agency look: soft shadows, generous spacing |
| [brutalist-skill](brutalist-skill/SKILL.md) | Swiss print and terminal-style brutalism |
| [output-skill](output-skill/SKILL.md) | Complete output without placeholders or truncation |
| [brandkit](brandkit/SKILL.md) | Brand-guideline boards and identity decks (image generation) |
| [imagegen-frontend-web](imagegen-frontend-web/SKILL.md) | Website design references as images (image generation) |
| [imagegen-frontend-mobile](imagegen-frontend-mobile/SKILL.md) | Mobile screen concepts as images (image generation) |
| [image-to-code-skill](image-to-code-skill/SKILL.md) | Generate a design image, then implement it (image generation) |
| [gpt-tasteskill](gpt-tasteskill/SKILL.md) | Variant tuned for GPT models, with GSAP motion |
| [stitch-skill](stitch-skill/SKILL.md) | `DESIGN.md` for Google Stitch |
| [taste-skill-v1](taste-skill-v1/SKILL.md) | The original v1, for projects that depend on it |

Upstream's own catalogue: [llms.txt](llms.txt).

## In Space

- Repository and operator instructions take precedence. All Space UI text stays
  in English.
- The image-generation variants need an image model in the current runtime. Ask
  the operator before using an external image service, and do not publish the
  results to Agent Files unless the operator asks for a file.
- Write design files (`DESIGN.md`, references, generated images) into a project
  only when the operator asks; otherwise use
  `/var/lib/spaceapp-user/agent-workspace/active/<task>/`.

Source and license: [UPSTREAM.md](UPSTREAM.md).
