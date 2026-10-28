# Platform playbooks

Caps, autonomy and the Connects budget come from `space_freelance_state`, never from here. Every send is reported
with the sent proposal's or conversation's own https URL on the platform (`space_freelance_send_done`).
Identity checks, phone, payout, tax forms, CAPTCHAs (after the single matching browser challenge attempt in SKILL.md) and live interviews are the operator's: account
`NEEDS_OPERATOR` + `space_browser_request_handoff`.

## Upwork (upwork.com) — kinds PROPOSAL, MESSAGE, FOLLOW_UP
- Account: freelancer profile of the operator (oll4.com as company/website), country Thailand. Sign-in only with
  "Continue with Google" on the pane's Google account (operator rule 2026-10-17): never the email/password form,
  never upwork@example.invalid; signed out = handoff to the operator, never a login by the copilot. Upwork verifies identity by ID and video call: operator. Agency "oll4" only when the operator asks.
- Profile: title, overview, hourly rate, skills, Specialized Profiles, portfolio, Project Catalog packages,
  Consultations (texts in PROFILE/PRICING memory).
- Finding work: saved searches with email alerts to upwork@example.invalid (MAIL items), Best Matches and search at
  https://www.upwork.com/nx/find-work/. Good posts: under 24 hours old, under 10 proposals, payment verified,
  budget at or above the floor, the niche (AI agents, MCP, LLM integrations, Node.js/TypeScript APIs, e-commerce
  and marketplace integrations, PostgreSQL).
- Proposal: "Apply now" on the post, cover letter, rate or fixed price with milestones, Connects (the post shows
  the cost; record it as `connects`), answers to screening questions. Boosting costs extra Connects: only when the
  operator asks.
- Messages: https://www.upwork.com/ab/messages/ ; reply inside the conversation.
- URL: the proposal page (`https://www.upwork.com/nx/proposals/<id>`) or the room (`https://www.upwork.com/ab/messages/rooms/<id>`).
- Rules: all contact and payment on Upwork until a contract exists; no unpaid work; never ask for or share contact
  details; "Offer" and "Contract" are for the operator (client_ready).

## Contra (contra.com) — kinds PROPOSAL, MESSAGE, FOLLOW_UP
- Account with contra@example.invalid; profile, 2-3 fixed-price services, portfolio projects. 0% commission for the
  freelancer: favour it for clients who find the operator elsewhere.
- Finding work: https://contra.com/jobs (filters: remote, development, AI); inbound messages arrive by mail.
- Proposal: the job's "Apply" form; messages in https://contra.com/inbox .
- URL: the job application or the conversation page on contra.com.

## Fiverr (fiverr.com) — kinds MESSAGE, FOLLOW_UP (and gig offers)
- Seller account with fiverr@example.invalid; identity verification and payout are the operator's. Two gigs (AI
  agent/MCP integration; Shopify/WooCommerce API integration) with three tiers each.
- Work comes to you: buyer messages and Buyer Requests/briefs (where available). Answer within hours: the response
  time is shown on the profile.
- Messages: https://www.fiverr.com/inbox ; a custom offer is a price commitment: client_ready unless it is one of
  the gig tiers unchanged.
- URL: the inbox conversation (`https://www.fiverr.com/inbox/<username>`).
- Rules: communication and payment only on Fiverr; no contact details, ever.

## Toptal (toptal.com) — kind APPLICATION
- Application with toptal@example.invalid at https://www.toptal.com/developers/join ; the screening has a language and
  personality call, a timed algorithm test, a live coding interview and a test project: each is the operator's
  (NEEDS_OPERATOR with the date). You prepare: profile text, résumé facts from memory, scheduling.
- URL: the application dashboard page on toptal.com.

## Arc (arc.dev) — kinds APPLICATION, MESSAGE
- Profile with arc@example.invalid at https://arc.dev ; vetting has a profile review and a technical interview (operator).
  Once vetted, apply to remote contract roles that fit the niche; messages come by mail.
- URL: the application or message page on arc.dev.

## Braintrust (usebraintrust.com) — kinds APPLICATION, MESSAGE
- Profile with braintrust@example.invalid at https://app.usebraintrust.com ; identity and payout checks are the operator's.
  Apply to jobs that fit the niche; the client's interview is the operator's.
- URL: the job application page on app.usebraintrust.com.
