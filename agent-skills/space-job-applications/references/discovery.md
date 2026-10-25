# Finding postings and building a pool

## `space_job_discover_search` (the copilot's own scanner)
- `space_job_discover_search {query, sites: ["greenhouse","lever","ashby"], tokens: ["acme","globex"],
  location?, remote?, limit}` scans the public board APIs below through the Space API (no
  network from the CLI), filters titles by every query word, marks postings already in the
  tracker (`tracked: true`) and returns `scanned` per board (404 = `no board`, normal).
- Board tokens are company slugs: `boards.greenhouse.io/<token>`, `jobs.lever.co/<token>`,
  `jobs.ashbyhq.com/<token>`. Remember every token that works as a `SITE` memory tagged
  `board-token` with text `<ats>:<token>` (`space_job_memory_remember {kind: "SITE", text:
  "greenhouse:acme", tags: ["board-token"]}`); `space_job_discover_search` scans remembered tokens
  automatically, so the pool grows with every campaign.
- Score each result against the CV 0–5 with a one-line reason (title fit, stack, seniority,
  location/remote, language) and queue only ≥ 3 through `space_job_application_start` (or hand the list
  to the operator, who queues from the Discover panel in the Queue tab).

## Public ATS job-board APIs (JSON, no auth)
- Greenhouse: `https://boards-api.greenhouse.io/v1/boards/{token}/jobs` →
  `{jobs: [{id, title, location: {name}, absolute_url}]}`.
- Lever: `https://api.lever.co/v0/postings/{token}?mode=json` →
  `[{id, text, categories: {location}, hostedUrl, workplaceType}]`.
- Ashby: `https://api.ashbyhq.com/posting-api/job-board/{token}` →
  `{jobs: [{id, title, location, jobUrl, isRemote}]}` (large payloads for big boards).
- Board tokens differ per ATS (a company may be on Greenhouse under one token and absent on
  Ashby); 404s are normal, skip them. The API scans with a user agent, a 12 s timeout, four
  boards at a time.
- Scrapling (`scrapling` MCP server: `stealthy_fetch`, `session_fetch`) reads career pages
  that block plain HTTP; use it for listing pages only, never to bypass application checks.

## Filters (ask the operator for theirs; keep them as PREFERENCE memories)
- Title keep list (roles the candidate wants) and a negate list (sales, management,
  languages or stacks the candidate does not do). Sales-adjacent titles hide behind
  non-"sales" words ("Account Development Representative"): extend the negate list from
  every leak.
- Geography: an allow list and a ban list of location tokens. Roles whose title or location
  encode a mandatory language ("Japanese speaker", "(JP)") are out unless the profile lists
  that language.
- Exclude postings already in the tracker (same URL) before building a pool;
  `space_job_discover_search` already marks them.

## Pool discipline
- Verify one application fully (fill → submit → evidence) before running a batch on a board.
- Size batches to the pacing caps; failures do not consume the cap, so a batch can touch
  more postings than it submits.
- After a batch, collect `FAILED` rows with `validation:` notes and retry them once after
  fixing the cause; rows with `not eligible` or `limit` notes are not retried.
