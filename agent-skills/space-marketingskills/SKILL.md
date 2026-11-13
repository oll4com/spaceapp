---
name: space-marketingskills
description: Six marketing skills from Corey Haines' marketingskills for SpaceApp. Use copywriting to write or rewrite page and post copy; launch to plan a launch or announcement (Product Hunt, Show HN, release posts); community-marketing for community work on Reddit, Discord, Hacker News and forums; directory-submissions to pick and prepare directory listings; ai-seo to get cited in AI answers (ChatGPT, Perplexity, AI Overviews); competitors for comparison and alternative pages (X vs Y). Every draft also goes through space-no-ai-slop.
metadata:
  category: WORKFLOW
---

# Marketing Skills

Six skills from [coreyhaines31/marketingskills](https://github.com/coreyhaines31/marketingskills). Read the one the task needs and follow it.

| Skill | Use when | Read |
| --- | --- | --- |
| `copywriting` | Writing or rewriting copy: a page, a post, a headline, which promise to lead with. | [copywriting/SKILL.md](copywriting/SKILL.md) |
| `launch` | Planning a launch or an announcement: Product Hunt, Show HN, a release post, whether it is ready. | [launch/SKILL.md](launch/SKILL.md) |
| `community-marketing` | Taking part in a community (Reddit, Hacker News, Discord, forums) without being removed for promotion. | [community-marketing/SKILL.md](community-marketing/SKILL.md) |
| `directory-submissions` | Choosing directories worth listing in and preparing the listing kit. | [directory-submissions/SKILL.md](directory-submissions/SKILL.md) |
| `ai-seo` | Getting SpaceApp cited and recommended in AI answers; llms.txt and answer-ready pages. | [ai-seo/SKILL.md](ai-seo/SKILL.md) |
| `competitors` | Comparison and alternative pages ("SpaceApp vs X", "X alternatives") and what they may say about a competitor. | [competitors/SKILL.md](competitors/SKILL.md) |

## Space conventions

These override the upstream text where they differ. Repository and operator instructions (`AGENTS.md`) take precedence.

- Product context: the upstream skills look for `.agents/product-marketing.md`. In Space it comes from public SpaceApp
  facts (https://spaceapp.dev, the GitHub repository) and, in a Marketing Copilot pane, from its memory
  (`space_marketing_memory_recall`: FACT, BRAND_VOICE, AUDIENCE, CHANNEL_RULE, LESSON). Never invent a feature, a number
  or a customer.
- Every draft (post, reply, page, listing) goes through `space-no-ai-slop` before review or publishing. Reddit and
  Hacker News remove posts that read as AI-written.
- Nothing is posted, submitted to a directory or sent by these skills. Publishing goes through the Marketing Copilot's
  own gates (review, autonomy, channel caps); a page goes live only after the operator approves it.
- Checks that call third parties (`npx` tools, `curl` against a site, sign-ups, form submissions) run only when the
  operator asked for them.
- Links to skills that are not in this bundle (product-marketing, cro, emails, schema, programmatic-seo and others):
  skip them and carry on with what is here.
- Drafts and reports go to `/var/lib/spaceapp-user/agent-workspace/reports/YYYYMMDD-HHMM-<skill>/` (or the Marketing Copilot's
  posts), never into a repository.

Source and license: [UPSTREAM.md](UPSTREAM.md).
