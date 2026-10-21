# API configuration reference

## Optional API and worker span export

`SPACE_OTEL_EXPORTER_OTLP_ENDPOINT` is unset by default. Set it to a plain
HTTP(S) collector base URL, for example `http://127.0.0.1:4318`, on the API and
each worker process. Spans are posted as OTLP/HTTP JSON to `<base>/v1/traces`.
Credentials, query parameters and fragments in the endpoint are rejected.

The API exports SERVER spans. The main worker, memory-maintenance worker and
memory-mutation worker export INTERNAL workflow-run and activity-attempt
spans, including retries and child workflows. API-started work continues the
request's trace, while continue-as-new and background continuation spans carry
links to their predecessor. Workflow replay exports no spans. CLI Host and
Browser Host spans are outside this coverage.

The shared exporter has a bounded queue, drop counters and per-request
timeouts. Collection is best effort and cannot fail task execution. Attributes
are limited to approved identifiers, types, attempts, status, stable failure
codes/categories and durations; prompts, outputs, paths, URLs and exception
messages are excluded. No collector or tracing SDK is required when disabled.
See [observability](quality/observability.md#traces-w3c-trace-context) for tests
and the remaining limitations.

## Configuration inspection

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
