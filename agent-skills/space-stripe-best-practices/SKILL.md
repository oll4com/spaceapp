---
name: space-stripe-best-practices
description: "Stripe's best practices for planning, building and reviewing Stripe integrations (Checkout, PaymentIntents, Connect, Billing, Tax, webhooks, keys)."
metadata:
  category: WORKFLOW
---

# Stripe Best Practices

The skill is [stripe-best-practices/SKILL.md](stripe-best-practices/SKILL.md); read the `references/` file it points to for the area at hand (payments, billing, Connect, tax, security).

## In Space

Repository and operator instructions (`AGENTS.md`, `/etc/AGENTS.md`) take precedence over this skill.

- **Test mode first.** Build and verify in a sandbox or test mode. Live charges, refunds, payouts, transfers and changes to live customers or subscriptions need the operator's approval of that exact action in the current conversation.
- **Keys.** Never ask for, print, log or commit Stripe secret or restricted keys. Use the project's existing secret store and environment variables.
- **Documentation.** Space ships no Stripe MCP server or stored Stripe key. Use the `context7` backend or https://docs.stripe.com for current API and SDK details.

Source and license: [UPSTREAM.md](UPSTREAM.md).
