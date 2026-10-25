# Incremental domain boundaries

`npm run test:architecture` runs during the root `check` command (and the private repository's root `test`;
the public export's `npm test` runs the public suites, so run `npm run test:architecture` there directly).
It checks local TypeScript source dependencies in the API and web application.
The policy in `domain-boundaries.json` records existing cyclic edges; the check
rejects every new edge participating in a cycle, including an edge between
members of an existing cyclic component. Removing an existing cycle is allowed.
The baseline is evidence of existing debt, not a claim that the application is
acyclic. Do not regenerate it to admit a failing refactor.

The extracted artifact routes/storage/errors and login domain must not depend
on `app.ts` or `App.tsx`, directly or through helpers. Add domain entry paths to
the policy as each boundary is extracted. Domain tests import these modules
without bootstrapping their application composition roots.

The current graph includes type-only imports, re-exports, and literal dynamic
imports. Computed imports, external package internals, and runtime injection are
outside its scope; this is a dependency regression check, not a security boundary.
Four existing cyclic components (19 edges) were recorded at `7f90143b14`.

`mcp-tool-executor.ts` now owns tool-policy evaluation, invocation, result
publication and audit outcome recording through narrow store/config/event/audit
interfaces. HTTP authentication, CSRF, internal bridge authorization and selected
tool checks remain in the application boundary. Seven standalone domain cases
exercise denied execution without starting a process and one approved synthetic
stdio execution with redacted artifact output. Existing authenticated bridge
checks remain separate. This extraction adds no tool grants or approval bypass.

The review plan's 60% reduction target remains open: it was met on 2026-10-12
and lost again as main grew (see `decomposition-proposal.md`); since 2026-10-14
`composition-root-budget.json` stops further growth. Moving the login component
removed 200 net lines from `App.tsx`; artifact domain extraction removed 247
lines from `app.ts`. Neither extraction alone establishes the overall target or
live performance parity.

`streaming-admin-routes.ts` owns the integration/OAuth/overlay routes and
`streaming-bot-routes.ts` owns the bot settings, public-context, memory and internal
bridge routes. Their injected service/store/audit interfaces omit unrelated
application services. Global authentication, CSRF, internal token gates and error
handling remain in the composition root; the domains preserve their local ADMIN
checks. They are part of the same no-backreference/no-new-cycle ratchet.
