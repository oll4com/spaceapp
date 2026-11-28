# Finding postings and building a pool

## `space_job_discover_search` (the copilot's own scanner)
- `space_job_discover_search {query, sites: ["greenhouse","lever","ashby","himalayas","linkedin","workable"], tokens: ["acme","globex"],
  location?, remote?, exclude?, limit}` scans the public board APIs below through the Space API (no
  network from the CLI), filters titles by every query word, keeps every workplace (remote, hybrid,
  on-site) with fully remote postings first (Lever/Ashby `workplaceType`, Ashby `isRemote`, else "remote"
  in the location; `remote: true` keeps remote only), drops every posting whose title or location
  has an `exclude` word as a whole word, drops postings older than 30 days and remote postings closed to
  Greece/EU by their own words ("US only", "residents", "Remote (Brazil)"), marks postings already in the
  tracker (`tracked: true`) and returns `scanned` per board (404 = `no board`, normal).
- Board tokens are company slugs: `boards.greenhouse.io/<token>`, `jobs.lever.co/<token>`,
  `jobs.ashbyhq.com/<token>`. Remember every token that works as a `SITE` memory tagged
  `board-token` with text `<ats>:<token>` (`space_job_memory_remember {kind: "SITE", text:
  "greenhouse:acme", tags: ["board-token"]}`); `space_job_discover_search` scans remembered tokens
  automatically, so the pool grows with every campaign.
- Score each result against the CV 0–5 with a one-line reason (title fit, stack, seniority,
  location/remote, language) and queue only ≥ 3 through `space_job_application_start` (or hand the list
  to the operator, who queues from the Discover panel in the Queue tab).

- `himalayas` is one search by `query` (tokens are ignored; no query = `needs a query`) on Himalayas'
  remote job API with `country=Greece`, paged until the end or past `limit`. Only jobs whose
  `locationRestrictions` are empty or name Greece/the EU are kept, never by the "Worldwide" label
  (16/11: 54 of 55 such jobs were closed to Greece); expired jobs are dropped.
- `linkedin` and `workable` are searches by `query` too (`location` defaults to Greece; every workplace unless
  `remote: true`). Operator 27/11: remote is the priority, not a limit: hybrid, on-site and relocation roles
  (EU/EEA and the relocation countries in the pinned memories) are applied to as well. LinkedIn's guest job search covers the last 30 days and answers about 30 postings a
  search before `HTTP 429`: what it found is kept, so vary the query rather than repeat it. Its URLs are
  `https://www.linkedin.com/jobs/view/<id>` (queue them with ats `linkedin`, Easy Apply only, the LinkedIn
  daily cap; an external-ATS redirect is queued under that ATS's URL). Workable postings
  (`jobs.workable.com/view/...`) are queued with ats `other`.

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
- Pass both lists as `exclude` on every `space_job_discover_search` (stacks the CV does not claim such
  as `rust`, `go`, `terraform`, `nestjs`, `c#`, `.net`; geofences such as `us only`, `brazil`), so
  those postings never reach scoring. Whole words: `go` drops "Backend (Go)" and "Go-to-market", not
  "Django".
- Before queueing a posting from HN, We Work Remotely, Workable or any aggregator link, open
  it and check that it is still open and that its stack and its location/visa rules fit the preference
  memories; skip it on a mismatch. `exclude` never sees these postings (jobrun:FxwhONTgsfU2: 44 of its
  49 failures, mostly closed, a stack or a visa rule stated only in the description).
- Exclude postings already in the tracker (same URL) before building a pool;
  `space_job_discover_search` already marks them.

## When the daily target is behind
- A kickoff that asks for discovery means today's target cannot be reached from the queue. Search the sites
  whose daily limit still has room first (`settings.dailyCaps` against today's count), not boards that are
  already full. A company is never skipped for having received an application before: only the same posting
  or the employer's own stated limit holds it (operator 23/11/2026).
- Queue only postings the run will take: before `space_job_application_start`, check the CV's region and
  work-authorization rules, seniority and stack, so the run does not reject them later as not eligible.

## Pool discipline
- Verify one application fully (fill → submit → evidence) before running a batch on a board.
- Size batches to the pacing caps; failures do not consume the cap, so a batch can touch
  more postings than it submits.
- After a batch, collect `FAILED` rows with `validation:` notes and retry them once after
  fixing the cause; rows with `not eligible` or `limit` notes are not retried.
