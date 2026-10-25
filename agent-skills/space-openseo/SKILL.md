---
name: space-openseo
description: OpenSEO (every-app/open-seo) SEO workflows - keyword research and clustering, competitor and competitive-landscape analysis, site audits, link prospecting, local SEO, AI prompt research and AI visibility audits, project setup, coaching and HTML reports - driven by the hosted OpenSEO MCP server, which needs the operator's OpenSEO account. Use when the operator asks for SEO research, an SEO audit or an SEO report.
metadata:
  category: TOOL_ADAPTER
---

# OpenSEO

Read only the skill the task needs.

| Skill | Use when |
| --- | --- |
| [seo-project-setup](seo-project-setup/SKILL.md) | First use for a site: project and business context |
| [keyword-research](keyword-research/SKILL.md) | Finding and evaluating keywords |
| [keyword-clustering](keyword-clustering/SKILL.md) | Grouping keywords into pages and topics |
| [competitor-analysis](competitor-analysis/SKILL.md) | One competitor: what it ranks for, content gaps |
| [competitive-landscape](competitive-landscape/SKILL.md) | A whole market or SERP landscape |
| [seo-audit](seo-audit/SKILL.md) | Auditing a site and choosing the few fixes that matter |
| [link-prospecting](link-prospecting/SKILL.md) | Backlink analysis and link prospects |
| [local-seo](local-seo/SKILL.md) | Google Maps and local rankings |
| [ai-prompt-research](ai-prompt-research/SKILL.md) | Choosing prompts to track in AI answers |
| [ai-visibility-audit](ai-visibility-audit/SKILL.md) | Brand mentions and citations in AI answers |
| [seo-coach](seo-coach/SKILL.md) | Explaining SEO to a non-expert |
| [seo-report](seo-report/SKILL.md) | Delivering a shareable HTML report |

## In Space

Repository and operator instructions (`AGENTS.md`, `/etc/AGENTS.md`) take precedence over these skills.

- **Data.** The skills use the hosted OpenSEO MCP server (`https://app.openseo.so/mcp`, OAuth, credits from the operator's OpenSEO account). Space does not register it: the operator connects it in the CLI they use (https://openseo.so/docs/mcp). When its tools (`whoami` first) are missing, tell the operator that OpenSEO is not connected and stop; never replace its data with guesses. Never create accounts or handle the OAuth sign-in yourself.
- **Credits cost money.** Before a tool that spends credits, state the expected cost (the skills say when) and wait for the operator's approval.
- **Public pages.** Reading the operator's site or a competitor's public pages with `space_browser`, Playwright or `scrapling` is fine within the request; keep request rates polite.
- **Where files go.** Reports go to `/var/lib/spaceapp-user/agent-workspace/reports/YYYYMMDD-HHMM-<topic>/`; never commit them. Publish to Agent Files only when the user explicitly asks for the file.

Source and license: [UPSTREAM.md](UPSTREAM.md).
