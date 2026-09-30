# Demo Projects

Demo Projects is the Space pane where a small project can be selected, started,
previewed and tested inside the app. Each project ships one or more language
variants; the pane runs exactly one variant per selection and never mixes their
data.

## Layout

```
demos/
  project-1-salesforce-crm/
    javascript-react-node/   server/index.mjs        web/  (React, built to web/dist)
    typescript-react-node/   server/index.ts → server-dist/index.js
  project-2-crud-playground/
    javascript-react-node/
    typescript-react-node/
```

Every variant is a self-contained implementation:

- `server/` serves the built web assets and the variant's own JSON API with
  `node:http` only. No dependency install is needed to start a run.
- `web/` is a React app built by `node scripts/build-demo-projects.mjs`
  (run automatically by `npm run build`).

## Runtime contract

The Space API copies nothing: it starts `process.execPath <server entry>` with
`cwd` set to the variant directory and these variables:

| Variable | Meaning |
|---|---|
| `PORT`, `HOST` | Loopback port allocated per run (`127.0.0.1`). |
| `DEMO_RUN_ID` | Run id, also returned by `/healthz`. |
| `DEMO_MODE` | `SAMPLE` or `LIVE`. |
| `DEMO_DATA_DIR` | Per-run state directory under `var/demo-projects/runs/<run>/data`. |
| `DEMO_WORKSPACE_DIR` | The run workspace the data directory must stay inside. |
| `DEMO_SOURCE_ROOT` | Variant directory (also the web `dist` root). |
| `SPACE_API_BASE_URL`, `DEMO_RUN_TOKEN` | Only for `LIVE`: the connector API and its run-scoped token. |

Each server must answer:

- `GET /healthz` → `{ ok: true, runId, projectId, variantId, mode }`
- `GET /api/config` → project, variant, mode, entry point
- `GET /api/isolation` → `{ runId, dataPath, workspaceInsideRun, sharedStateDetected }`
- `GET /api/records` (list) and `POST /api/records` (create, idempotent per
  `operationKey`, `400` on invalid input)
- Project 2 only: `PATCH /api/records/:id` and `DELETE /api/records/:id`
- Project 1 only: `GET /api/accounts`, `GET /api/status`, `POST /api/records/:id/retry`

The React client only ever calls relative URLs (`api/...`), so the same bundle
works behind the pane preview gateway.

## Modes

- **Sample** never touches an external service. Records, ids and sheet rows are
  generated inside the run workspace and are labelled `sample` everywhere.
- **Live** (Project 1) delegates Salesforce and Google Sheets work to the Space
  connector API. The demo process never sees OAuth tokens.

## Adding a project or variant

1. Add the definition to `apps/api/src/demo-projects/catalog.ts`.
2. Create the template directory with `server/` and `web/`.
3. Run `npm run build:demos`; a variant without a built `web/dist/index.html`
   or server entry is reported as unavailable in the pane, never as ready.
