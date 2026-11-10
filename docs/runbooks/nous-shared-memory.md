# Shared Nous memory

Nous's generic working knowledge is shared per installation team when multi-user is enabled; otherwise it belongs to the single owner's team. Personal Space Memory remains separate. Team scope is resolved by the server, never by a request argument.

Administrators manage entries in Settings → Assistants & AI → Nous → Shared memory. A person with role ADMIN can create, edit, approve, retire, restore or delete an entry. Broker, proof and automation sessions cannot write. Revisions prevent a stale edit from replacing a newer one. An explicit delete keeps a seed tombstone; no automatic pruning removes this class-A data.

`space_shared_memory_propose` records screened generic lessons as PROPOSED. Auto-approve is off by default and only the team administrator can enable it. Every Nous turn reads ACTIVE entries within a 6,000-character budget. `space_shared_memory_read` returns bounded pages; start with offset zero and continue with nextOffset until it is null. Shared knowledge is reference material; the current operator's instructions and permission gates take precedence. Helpers can read but cannot propose.

The daily built-in task is **Nous shared memory: daily upgrade**. With Nous and daily upgrade enabled, the minute lifecycle queues it for an enabled ADMIN's Nous, once per team/day in that administrator's working time zone. The completed-day receipt is durable. An interrupted task stays due after a restart; no successful receipt is written until its turn completes. It may propose a generalized lesson or report that no new lesson is appropriate. It never copies private memory into the seed or bypasses admin review.

The same conservative privacy screen applies to writes, activation, prompt rendering, import and export: generic know-how only, with no names, contact information, hosts/IPs, secrets, money, mail or private business facts. Admin review remains the default because contextual privacy cannot be decided reliably by syntax alone. A release export adds a human review of the complete diff.

## Release captain checklist (run-spaceapp 1.2.0 and every later version)

1. After the core change reaches stable, export its ACTIVE generic entries from stable in the release source checkout:
   `node --experimental-strip-types scripts/space-shared-memory-seed.mjs export --version <release-version>`.
   This uses the scoped read-only `shared-memory-list` admin action. It never writes to team memory.
2. Read the complete seed diff, remove private or installation-specific material, and preserve stable entry keys. Keep the identity entry: Nous, from the Greek Νους, the mind of SpaceApp. The export refuses invalid content rather than silently dropping it.
3. Run `node --experimental-strip-types scripts/space-shared-memory-seed.mjs verify --version <release-version>` and `space-version verify`. Commit the reviewed seed with the candidate before lab acceptance. The current pre-1.2.0 train may carry the staged 1.2.0 seed; 1.2.0 and later require an exact stamp, including registry-safe prereleases. Public readiness also requires the exported importer, repository, migration and Nous wiring.
4. Export the approved core into the public installer, preserving its public Nous overlay. The image includes the contracts package and its seed JSON. Verify the public seed is identical to the reviewed source and run the public seed/distribution checks.
5. Lab proof: a fresh install gets the identity and generic rules before the first Nous turn. Edit one rule, retire another and delete a seeded rule, then upgrade; all three admin choices must survive, while new seed keys appear. Public Nous must also execute a real tool call through its CLI container.
6. Record the exact source, seed and image identities in the release evidence. Keep the existing release approval and publication gates.

Startup imports `packages/contracts/src/nous-shared-memory-seed.json` through the contracts module before turns read it. A repeat import adds new keys and updates unchanged ACTIVE SEED rows only. Admin edits, retirements and deletions always win. The first seed is distilled from the operator's generic draft; personal and business records are never release inputs.
