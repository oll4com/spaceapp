# Large Memory 3D graphs

The 3D view requests an overview limit of 50,000 nodes (150,000 edges). The
API default remains 2,000/6,000, the route remains admin-only, and node labels
and edge evidence retain the existing redaction. Cache identity includes the
query and limit. The 2D view continues using its independent default overview.

Nodes use WebGL2 instanced quads; edges use a batched line buffer. GPU depth
replaces per-frame node sorting. A median BVH is rebuilt on layout updates;
pointer and camera moves query it without rebuilding it. Label selection
measures at most 96 candidates and draws at most 40 labels, prioritizing the
focused node, core and sources. Titles can still be hidden.

The existing worker sends a seed and six deterministic layout snapshots.
Live overview responses above 2,000 nodes transfer their bytes to that worker
for JSON decoding, returning bounded node/edge batches. Cancellation terminates
both response parsing and layout. Coordinates transfer as Float32Array buffers.
Input messages and GPU scene
preparation yield between bounded batches; the previous scene stays usable
until a replacement is ready. A superseded search or view terminates its
worker and ignores stale results. Context loss immediately exposes a capped
Canvas fallback and requests a capped overview; restoration restores WebGL
and the larger overview. There is no database migration or new render package.

## Reproduce

Use the Node version in CONTRIBUTING.md and start `npm run dev:web`. Open
`/demo-workspace?memoryNodes=50000`, then Workspace → Utilities → Memory → Atlas
→ 3D. Supported synthetic sizes are 2,000, 10,000 and 50,000. These fixtures
contain three edges per node and support search and node details.

The optional harness uses Playwright and installed Google Chrome. Install the
harness dependency outside the checkout, then run from the repository root:

```sh
npm install --prefix /tmp/space-memory-bench playwright@1.62.1
PLAYWRIGHT_MODULE_PATH=/tmp/space-memory-bench/node_modules/playwright/index.mjs \
MEMORY_BENCH_URL=http://127.0.0.1:4911 \
MEMORY_BENCH_OUTPUT=/tmp/memory-webgl-benchmark.json \
node scripts/bench-memory-webgl.mjs
```

The harness opens an isolated Chrome profile and runs the actual workspace.
It measures from entering 3D through layout completion, exercises input during
convergence, then records 360 requestAnimationFrame intervals while rotating,
zooming and hovering (after 60 warmup frames). Pointer measurements cover the
synchronous hover handler. It also checks pointer/keyboard selection, titles,
context loss/recovery and a separate `--disable-webgl` browser. The JSON keeps
all measured frame and pointer samples, errors, GPU identity and long tasks.
These are browser frame intervals, not GPU timer-query durations.

## Executed measurement — 27 October 2026

MacBook Pro Mac16,8, Apple M4 Pro integrated GPU, 24 GB unified memory;
headed Google Chrome 156 through ANGLE Metal; 1440×900 viewport, DPR 1.
The measured app used the development server and synthetic demo above.
Raw measurements: [memory-webgl-benchmark.json](memory-webgl-benchmark.json).

| Nodes / edges | p95 frame interval | Maximum pointer handler |
| --- | ---: | ---: |
| 2,000 / 6,000 | 10.1 ms | 0.50 ms |
| 10,000 / 30,000 | 10.1 ms | 0.41 ms |
| 50,000 / 150,000 | 10.1 ms | 0.70 ms |

No main-thread task of 50 ms or longer was observed during the measured 3D
load/layout intervals. All three sizes passed interaction, title, selection,
and context-loss restoration checks with no page errors. The separate
WebGL-disabled run showed the capped Canvas renderer.

A separate harness invocation exercised the actual live API response decoder
with a synthetic HTTP response: 50,000 nodes, 150,000 edges, 46,477,893 bytes,
586.5 ms elapsed including transfer and decoding, and no observed main-thread
task of 50 ms or longer. This runs on an isolated page after module loading,
so application boot is outside the measurement. Set `MEMORY_BENCH_COUNTS=""`
to repeat only this decoder check and the WebGL-disabled fallback.

The API test `large overview budgets` uses the real authenticated Fastify route
with a synthetic 50,000-node/150,000-edge snapshot. Its measured response was
32,039,414 uncompressed bytes and 498.6 ms server time on this host. This is
in-process route time, including selection/redaction/schema/serialization;
it excludes network transfer and snapshot indexing. The test also verifies
redaction, default and maximum limits, rejected invalid limits, unauthenticated
access and query-sensitive ETags. Run it with:

```sh
npm test -w @space/api -- memory-graph-api
npm test -w @space/web -- memory
```

## Validation scope

Node 22.23.1: root `npm run check` and `npm run build` passed. The full web
suite passed 4,128 tests; the final Memory subset passed 54 tests, including
stream cancellation/error handling and BVH agreement with exhaustive picking
at rotated/zoomed and perspective-clamped cameras.

The full API suite on macOS passed 3,847 tests, failed 141 and skipped 18,
with 10 errors. An isolated clean checkout of upstream `50272acb` on the same
host passed 3,845, failed 142 and skipped 18, with 10 errors. Every failing
test name on this branch also failed on that base. Failures include the
Linux-only filesystem backend, Linux Chrome paths and macOS path assumptions.
The root public suite produced the same two failures on both checkouts:
credential-status whitespace and an undici 6.28.1 expectation against the
Dockerfile's 6.29.1 pin (146 pass, 2 fail, 2 skip). Reference Linux CI still
needs to run; these native results do not establish a green full API suite.
