# API configuration reference

For a first local contribution, follow [CONTRIBUTING](../CONTRIBUTING.md).
Production installation and provider login belong to the supported installer;
the API reference is for developers and operators reviewing advanced settings.

After installing workspace dependencies and building the internal packages:

```sh
npm run config:reference -w @space/api -- --defaults
npm run config:reference -w @space/api -- --check
```

The first command describes every field of `SpaceApiConfig` (the count grows as settings are added): API scope,
environment sources, exposure classification, validation category, deprecated
sources and defaults. It calls the existing parser with an empty environment;
it never describes the current process's secret values. Paths, service addresses
and secret defaults are redacted. The canonical memory month and optional helper
availability remain date/filesystem dependent, as they are in the API parser.

Sources are ordered as used by the parser. Some are fallback aliases (for example
`SPACE_GEMINI_VOICE_KEY_FILE` after `SPACE_GOOGLE_VOICE_KEY_FILE`); others are
dependencies (`SPACE_ARTIFACT_ROOT` for generated storage paths). CLI command,
credential and login keys come directly from the runtime descriptor registry.
No existing alias has been newly deprecated or removed. There is no second
default table to keep synchronized.

`--check` performs an advisory preflight of the supplied process environment:
literal boolean flags, positive integer syntax, API port and demo port range,
and the existing MCP/live-model structured parsers. It prints only field names,
source names and error codes, never submitted values or parser exceptions. Exit
codes are 0 for no detected issues, 1 for detected issues and 2 for invalid command
usage. Existing fallback/clamping behavior remains in `config.ts`; this command
does not start a service, change settings, enable a runtime or contact a provider.

This is a bounded configuration check, not installation readiness. It does not
verify URLs, credentials, file permissions, network reachability, provider
capabilities or cross-service compatibility. Authentication/server bootstrap,
worker, web build and installer environment fields outside `SpaceApiConfig` are
outside this registry. Full cross-service configuration coverage remains open.

## Optional OTLP trace export

`SPACE_OTEL_EXPORTER_OTLP_ENDPOINT` can point to a plain HTTP(S)
collector base URL, for example `http://127.0.0.1:4318`. The API
and all three Temporal workers send OTLP JSON to `/v1/traces`. Export is disabled
when the variable is unset; invalid URLs, embedded credentials, fragments
and query strings are rejected.

Traces include an API HTTP span, Temporal workflow spans, activity-attempt
spans and links to continued-as-new and background work. A long-lived Room
Agent supervisor links later requests while preserving each turn's own
trace ancestry. Scheduled workflows without an API context start a root.
Only allowlisted
identifiers, types, statuses, reason codes, categories and durations leave
the process. No prompts, outputs, file paths or error messages are exported.

The shared runtime exporter has a bounded queue (4096), a batch cap (256)
and a request timeout (3000 ms); it drops and counts overflow or shutdown
unsent spans without blocking production operations. A failed collector batch
ends that drain instead of repeatedly extending shutdown. This is best-effort
diagnostics rather than a guaranteed audit log. No new tracing SDK is required.

Set the variable independently for the API and the worker processes. To
inspect a full trace locally, run an OTLP-compatible collector (for example,
Jaeger with HTTP receiver port 4318) and start a synthetic workflow; the
collector is optional and does not participate in business logic.

## Optional modules

`SPACE_OPTIONAL_MODULES` turns on modules beyond the coding workspace:
`games` (chess and Asteroids benchmarks), `job-copilot`, `mail-copilot`,
`marketing-copilot`, `channels` (Slack and Teams), `telegram`, `waitlist` and
`desktop-updates` (desktop client release and update routes). Use `all`, `none`
or a comma-separated list. Without it, a public install
(`SPACE_PUBLIC_DISTRIBUTION=true`) starts with none of them and any other
install with all of them. A module that is off registers no routes, starts no
background work, and is hidden in the web app. Public installs upgraded from
1.1.x that used Job Copilot, the games, channels, Telegram or the desktop
routes set the modules they keep, for example
`SPACE_OPTIONAL_MODULES=job-copilot,games`.
