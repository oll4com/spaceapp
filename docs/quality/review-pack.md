# Independent review pack

This pack lets independent reviewers (DeepSeek, GPT, Kimi, Qwen, Claude or
others) assess SpaceApp under the same conditions. It deliberately contains no
expected score. Reviewers are free to give any rating.

## 1. Fix the snapshot first

- Review a public release tag. Build the pack with
  `node scripts/build-review-snapshot.mjs --repo <public checkout> --ref <tag> --version <x.y.z> --out <new dir>`.
  It refuses unless the newest run of every CI workflow at that commit succeeded, archives the
  source at that one commit (`docs/quality/` ships inside it, so code and evidence never come from
  different commits), runs `scripts/verify-export-provenance.mjs`, and writes the README (CI links,
  quick start, provenance counts), `files.txt` and the archives.
- Publish the pack both at `spaceapp.dev/review/<version>/` and as assets of the GitHub release:
  some reviewer sandboxes reach GitHub only.
- Give every reviewer the same tag and the same prompt (section 2).
- For a review of the private tree instead, hand over a shallow clone of one `DEPLOYED` commit
  (`git clone --depth 1 --no-local /opt/spaceapp <dir>`, then check out the SHA) and add
  `node scripts/quality-snapshot.mjs <SHA> --out <dir>/QUALITY_SNAPSHOT.json`.

## 2. Neutral prompt

> You are reviewing the SpaceApp source tree at commit `<SHA>`. It is a
> self-hosted, single-owner workspace for AI coding CLIs, browsers and agents.
> Assess architecture, security, reliability, observability, test evidence,
> operability and documentation accuracy for that stated scope. Treat
> multi-tenancy, Kubernetes and licensing as product decisions, not defects,
> unless the documentation claims otherwise.
>
> In your answer:
> 1. State your exact model ID, the date, the commit you inspected, and what
>    you executed versus only read.
> 2. List every claim you could not verify.
> 3. For each finding, cite file and line, explain impact, and say whether it
>    is a defect, a risk or a trade-off.
> 4. Give an overall rating from 1 to 5 with a short justification.
>
> `docs/quality/` contains the maintainers' evidence and a findings register.
> Treat them as claims to check, not as conclusions.

## 3. Reproduction commands

On the public source (Node from `.nvmrc`; no private access needed):

```sh
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci   # offline: add npm_config_nodedir=/usr for node-pty
node scripts/verify-export-provenance.mjs .
npm test
npm run test:architecture                # cycle ratchet, composition-root size, known limitations
npm run check
```

On the private tree, from a worktree with `node_modules` linked (CONTRIBUTING), with a short
`TMPDIR` such as `/tmp/s` for socket tests:

```sh
(cd packages/db && ../../node_modules/.bin/vitest run tests/migration-identities.test.ts)
(cd apps/api && ../../node_modules/.bin/vitest run \
  src/__tests__/files-user-mode-secrets.test.ts src/__tests__/files-containment.test.ts \
  tests/files-routes-security.test.ts tests/files-upload-http.test.ts tests/cors-origin-guard.test.ts \
  tests/route-auth-inventory.test.ts tests/worktree-removal-guard.test.ts tests/project-ensure-security.test.ts \
  tests/readiness-probes.test.ts tests/log-redaction.test.ts tests/route-rate-limits.test.ts \
  tests/config-registry.test.ts tests/cli-adapter-contract.test.ts)
(cd apps/worker && ../../node_modules/.bin/vitest run)
npm run memory:eval
node scripts/temporal-replay-check.mjs --limit 50   # read-only replay of live Temporal histories
```

## 4. Evidence index

| Topic | Where |
| --- | --- |
| Findings, dispositions and evidence (D/G/K/Q plus new) | `review-findings.json` |
| Corrected plan and phase status | `plan-v2.md` |
| Security slice, uploads, previews | `README.md` (implemented security slice), `upload-reconciliation.md` |
| Execution and recovery | `failure-matrix.md`, `postgres-proofs.md` |
| Runtime adapters and installed versions | `runtime-compatibility.md`, `native-resume-matrix.md` (if present) |
| Context, budgets, cost | `context-and-budgets.md` |
| State ownership | `state-ownership.md` |
| Decomposition status and approval-gated plan | `domain-boundaries.json`, `decomposition-proposal.md` |
| Merge-queue delivery and its known hazard | `../runbooks/merge-queue.md`, finding REL-001 |

## 5. Known limitations

`KNOWN_LIMITATIONS.md` lists every open, partly fixed, accepted or product-decision finding. It is
generated from `review-findings.json` (`resolution` field) by `scripts/quality-known-limitations.mjs`
and `npm run test:architecture` fails when it differs from the register. That check covers only
`KNOWN_LIMITATIONS.md`: this pack and the README are kept in line by hand. Reviews so far, with model, commit and rating, are recorded in `verification-results.json`
(`current.independentReview`), including the 2026-10-14 reviews of the v1.1.4 snapshot (`snapshotReviews`).
