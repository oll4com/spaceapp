---
name: space-mail-campaigns
description: "Mail Campaigns for every agent, copilot and Nous: newsletters, offers and any bulk e-mail through the space_mailcampaigns tools: campaign e-mail templates (versioned, cleaned for sending, fingerprinted), mailing lists with an honest consent basis, one contact per address whose health every list shares, imports from CSV, text or a Mail Copilot thread, the global do-not-mail list and the owner's sender identities. Nothing reaches a customer until the operator approves the exact campaign. Use when a task needs bulk or campaign e-mail, a mailing list, an e-mail template or an address's health."
metadata:
  category: DOMAIN_POLICY
---

# Mail Campaigns

Bulk e-mail is reputation work: one careless send can put the operator's domains on blocklists for months. Every tool here is
`space_mail_*` on the `space_mailcampaigns` MCP server (without MCP tools in this session:
`node /opt/spaceapp/scripts/space-mail-campaigns-mcp.mjs call <tool> '<json>'`).

## Rules that never bend

- **No customer gets anything without the operator's approval of the exact campaign** (template version, sender, lists and counts,
  schedule, pacing). Any change after approval sends it back to review. You never approve, and you never mail customers from any other
  path (Gmail, SMTP, scripts) for a campaign.
- **Suppressions win.** Before you build or import a list, read `space_mail_suppressions`. Add every opt-out you learn
  (a reply such as "no", "unsubscribe" or its Greek equivalent, "remove me", a do-not-contact list, a complaint) with `space_mail_suppression_add` at once.
  Only the operator lifts one.
- **Honest consent.** A list's `consentBasis` says why we may mail these people: CONSENT (they subscribed), CUSTOMER (they bought from us:
  similar products only), B2B (business outreach to role addresses), CONTACT (they wrote to us), IMPORTED (unknown). Never claim more
  than you can show; only the operator changes it later. B2B and IMPORTED are capped low per day.
- **Never purchased or scraped lists, no rotating senders or domains to dodge filters, no hidden text, no misleading subjects.**
  Deliverability comes from a real, authenticated, warmed sender and content people want.
- **Never promise "it will not reach spam"**: nobody can. Say what the checks showed.
- Mail Copilot's mailboxes and CS-Cart are read only for building lists; personal addresses stay out of notes, plans and chat (counts only).

## Templates

- `space_mail_template_create` with a subject, an optional preheader (the grey line after the subject), HTML and a **plain-text part**.
- Variables are `{{name}}`, each declared in `variables: [{name, default, required}]`; values are escaped in HTML. A required variable
  with no value stops the mail.
- HTML is cleaned on save for sending: tables and inline styles are fine; scripts, forms, iframes, external CSS, web fonts and
  `http:` images are removed; links must be absolute `https:` or `mailto:`. Keep it under ~90 KB (Gmail clips at 102 KB), one column,
  600 px wide, real text (not one big image), alt text on images, the brand's own domain in every link (no shorteners).
- The server adds the unsubscribe line, the List-Unsubscribe headers and the sender's identity footer itself: do not write your own.
- A change to what recipients see makes a new version (`space_mail_template_update`); campaigns keep the version they name.
  Check with `space_mail_template_preview` before you hand it on.

## Lists and contacts

- `space_mail_list_create` (name, consentBasis), then `space_mail_list_import` with ONE source: `csvPath` (a CSV with an email column;
  a name column and other columns become attributes usable as variables), `text`, `rows` or `thread {account, threadId}`.
  The answer counts what was added, already there, invalid and suppressed.
- A contact is one per address and its `health` is shared by every list: VALID, RISKY, UNKNOWN (sendable); INVALID, BOUNCED,
  COMPLAINED, UNSUBSCRIBED (never mailed). `space_mail_list_get` shows each list's health counts.
- `space_mail_contact_get` tells whether an address is suppressed and when a campaign last mailed it.

## Senders

`space_mail_senders` lists the owner's sender identities: the route (Workspace delegation for example.invalid, a connected Gmail account, or
SMTP on our own Plesk server for oll4.com / spaceapp.dev), status, warm-up stage and caps. Consumer @gmail.com senders are not for bulk.

- A sender is SETUP until `space_mail_sender_check` passes (a sign-in or a Send-as proof; nothing is sent).
- A campaign of its own on oll4.com or spaceapp.dev (e.g. `offers@example.invalid`): `node /opt/spaceapp/scripts/space-mail-identity.mjs plesk-mailbox
  <address> --name "<display name>" --footer "<company, postal address>"`. It creates the mailbox on public-host, keeps the generated password
  in the Vault (you never see it), adds the SMTP sender and checks it. Replies and bounces to it arrive in public-host's `work@example.invalid`.
- example.invalid through Workspace delegation: the key goes into the Vault once with `node /opt/spaceapp/scripts/space-mail-identity.mjs
  delegation-key-import` (it prints only the vault_key id), then `space_mail_sender_create` with `{route: GMAIL_DELEGATED, subject, vaultKeyId}`.
  example.invalid shares Google's ~2,000-a-day Workspace limit with the shop's own order mail: keep its caps low (500/day).
- Every new identity starts at the lowest warm-up stage (50 a day) and climbs only after clean days.
- `space_mail_sender_warmup {senderId, stage}` sets the stage (an established mailbox may start higher; 7 leaves only the caps) and
  `space_mail_sender_bulk {senderId, bulk}` allows or stops bulk; both are yours to run, recorded under your pane. The day's most is the
  lower of the sender's `caps.perDay` (`space_mail_sender_update`) and its stage.
- A new paid account or an e-mail service provider costs money: ask Nous for the operator's EXTERNAL decision, never sign up yourself.

## Campaigns

1. `space_mail_campaign_create` (template, an ACTIVE bulk sender, lists, hours, pacing, `testSeeds` = the operator's own mailboxes).
2. `space_mail_campaign_test`, then read the test copies (Mail Copilot) and fix the template until they are right.
3. `space_mail_campaign_submit`: the operator gets one card and reads EVERY mail in Mail Copilot → Campaigns (one per recipient, with
   search and next/previous) and approves there; their Approve binds exactly those mails. Check a few with `space_mail_campaign_preview`
   and `space_mail_campaign_preview_mail` first. You wait; never ask them to "just approve".
- Personal mails: one template with `{{fields}}` filled from each contact (CSV columns become fields; `name`, `firstName`, `email` always
  exist). To correct a field, import again with `overwrite: true`; any change to a recipient's mail asks the operator again, even mid-send.
- A plain-text mail: leave `html` empty. Pacing: `intervalSeconds` (360 = one every 6 minutes), `perDay`, `maxHardBounces`; the lists'
  order is the send order (put the priority group first).
4. After their yes the server sends by itself in the campaign's hours, one message per recipient, at the pace of the sender's warm-up,
   and never twice. Follow it with `space_mail_campaign_get`. It pauses itself on hard bounces over 3 % or on complaints; only the operator
   resumes. `space_mail_campaign_pause` / `_stop` are yours when something looks wrong.
- Every message gets the unsubscribe headers and footer from the server; a reply asking to stop is an opt-out: add it to the suppressions.

## Deliverability (before every review)

- `space_mail_deliverability_check` runs the server's checks on what would go out now: DNS authentication for the sender's route
  (SPF, DKIM, DMARC and alignment, MX, the reverse name), blocklists, and the content. A FAIL keeps the campaign from review; every
  finding comes with its fix. Submitting runs them if you have not.
- SpamAssassin: `node /opt/spaceapp/scripts/space-mail-lab.mjs spamassassin <mcamp:id>` scores the exact message on public-host (5 or more fails,
  3 or more warns). An unsent message always carries NO_RECEIVED/NO_RELAYS (they score 0).
- Seeds: `space_mail_campaign_test` to the operator's own Gmail mailboxes, wait a minute, then `space_mail_deliverability_seeds`.
  Promotions is normal for a newsletter; spam fails.
- Any change makes a new fingerprint: run the checks again; old results stop counting.
- DNS fixes on our domains go through the documented DNS path with a backup; propose them, do not improvise them.

## Address health (every list updates by itself)

- Health lives on the contact, so one bounce, complaint or opt-out changes every list at once, and the sender never mails it again.
- Space checks addresses every 30 days without touching anyone's server: the domain takes mail, no-reply and abuse boxes (INVALID),
  throwaway providers, shared role boxes and likely typos (RISKY, with the reason). `space_mail_health_check` checks now.
- Bounces, complaints and replies: Gmail senders' mailboxes are read by Space every 10 minutes. For oll4.com / spaceapp.dev senders they
  land in public-host's catch-all mailbox: run `node /opt/spaceapp/scripts/space-mail-lab.mjs signals` (read only; it passes on only messages that
  name our campaign Message-IDs) and the one-click unsubscribes the public page https://oll4.com/u/ collected. While a campaign sends,
  keep it on a schedule: `space-task add` an hourly task in your pane that runs it (a scheduled task, never a session cron).
- Never probe a stranger's mail server (RCPT checks) to "verify" addresses: it harms our reputation.

## Sources (read only)

- example.invalid customers from CS-Cart (public-host): `node /opt/spaceapp/scripts/space-mail-cscart-export.mjs buyers <mlist:id> [--years 3]` into a
  CUSTOMER list (completed orders only: the existing-customer soft opt-in, similar products, opt-out in every mail);
  `registered <mlist:id>` (registered without a completed order) only into a NO_CONSENT list: kept and visible, never mailed in bulk.
  CS-Cart holds no newsletter consent: never call a CS-Cart list CONSENT.
- People we already write to: `space_mail_list_import_mailbox` (a connected account's sent mail) into a CONTACT list.
- A conversation's people: `space_mail_list_import` with `thread`.
- Only counts go in notes, plans and chat; addresses stay in the lists.
