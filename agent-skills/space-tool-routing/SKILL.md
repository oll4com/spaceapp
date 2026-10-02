---
name: space-tool-routing
description: Explain or inspect Space tool routing when native capabilities, fallback selection, or per-model operator overrides need diagnosis.
metadata:
  category: DOMAIN_POLICY
---

# Space tool routing

Use this only for routing questions or changes. Ordinary image analysis, coding,
browser verification and file work use the active runtime's own capable tools.

Read the current model AND runtime input capabilities. Model names do not prove
that browser tools or image attachments are available in this session.

For a routing explanation, use the existing Settings panel or the bounded
`space-capability plan` command. Neither starts an MCP backend. Read only one
backend's schema with `space-capability info <server>` when needed.

Operator overrides select Automatic, Native only, Allow fallback or Disabled.
Allow fallback does not authorize sending native-vision images to another model.
Workflow skills and external summarization are opt-in.

When invoking a protected Space operation through native shell, pass the same
allowlisted backend/tool/arguments to `space-capability call` on stdin. Preserve
the backend's real authentication, approval and evidence checks. Do not recreate
its credentials or claim a direct replacement has equivalent access.

Check route decisions, cold startup, first call and warm-call timing separately.
Do not start every backend merely to inspect or explain the routing policy.
