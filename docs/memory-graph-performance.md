# Reproducing the 3D memory graph checks

Use Node >=22.12 <23 and the locked dependencies described in CONTRIBUTING.md.
No rendering dependency, backend, embeddings provider, credentials or production
memory is needed for these synthetic checks.

## Renderer frame-time harness

Run `npm run dev:web`, then open:

```
http://127.0.0.1:4911/memory-graph-benchmark.html?nodes=50000&memoryProfile=1
```

The HTML entry is a development harness, not a production route. It mounts the
actual `MemoryGraph3D` with fixed deterministic coordinates and exactly three
edges per node. Select 2,000, 10,000 or 50,000 nodes, load the fixture, wait for
`aria-busy=false`, keep the tab visible, and run the benchmark. It rotates and
zooms for 60 warm-up plus 360 measured animation frames. A 20-second deadline
reports incomplete runs explicitly. Repeat at each size on the stated hardware.

The visible result distinguishes animation-frame intervals from CPU submission
time. Picking records synchronous spatial-query result time; it excludes later
highlight presentation and detail fetching. Label counts, actual rendered counts,
GPU identity, viewport and long tasks are included. The result element's
`data-raw-result` attribute also contains the individual frame samples. The
optional `memoryProfile=1` flag adds Performance measures for renderer setup,
upload, volume calculation and large spatial-index partitions.

Use the context-loss button to verify the Canvas fallback (at most 2,000 nodes
and 6,000 edges) and the automatic request to restore WebGL after five seconds.
The canvas's `data-renderer`, `data-node-count` and `data-edge-count` show the
active backend and actual counts. Also test in a browser started with WebGL
disabled to exercise initial fallback. Titles and keyboard rotation/zoom remain
available in both paths.

## Full offline app and incremental layout

Open `/demo-workspace?memoryNodes=50000&memoryProfile=1&spaceDebug=1`, open
Workspace > Memory, select Atlas, then 3D. The `memoryNodes` parameter accepts
2000, 10000 or 50000; omitting it preserves the original small demo. A 50k demo
contains 50,000 nodes and 149,973 real synthetic fixture relations. Unlike the
fixed-coordinate harness, this path exercises generation, cooperative worker
input, transferable worker replies, atlas decoding and force-layout convergence.
Record load/layout separately with browser Performance tools; the renderer
harness alone does not establish the full app's main-thread long-task bound.
`spaceDebug=1` uses the existing local diagnostics and logs long tasks.

For a local-only observable pipeline harness, open
`/memory-graph-pipeline.html?memoryNodes=50000&memoryProfile=1`, load the demo
pipeline and switch to 3D. This mounts the same production MemoryWorkspace with
its offline DemoStore API and real layout worker. Capture after convergence to
record long tasks, the first full-graph frame, intermediate progress values and
renderer phases. Keep the tab visible. Raw frame events are available in the
result element's `data-raw-result` attribute. This separates pipeline evidence
from the fixed-coordinate frame-time measurements above.

The graph becomes visible before the simulation finishes. The workspace's
`data-layout-progress` and `data-layout-ready` expose convergence; the canvas
remains busy while loading/preparing and retains rotation, layout-volume and
titles-visible attributes. Arrows rotate; plus/equal and minus/underscore zoom.

Large worker requests are sent in bounded topology chunks. Large 3D replies use
transferred coordinate buffers with dictionary-encoded atlas metadata; decoding
yields to input. A latest-pending snapshot queue lets an in-progress snapshot
finish instead of continually cancelling rendering during convergence.
Successful live overview responses with an explicit limit above 2,000 transfer
their response bytes to a parser worker and return bounded topology chunks.
Fetch, credentials and HTTP error handling keep the existing request path.
Browsers without workers, or which block their construction, use the ordinary
response reader; the large-response main-thread timing bound is not claimed for
that fallback.

## API and regression checks

`GET /api/admin/memory/graph/overview?limit=50000` opts into the larger result.
The default is still 2,000 nodes / 6,000 edges; the hard limits are 50,000 nodes /
150,000 edges. Existing label redaction and administrator authorization apply.
Report the serialized response size and elapsed handler/serialization time with
the measurement method and hardware; these are not browser load timings.
Set `MEMORY_GRAPH_BENCHMARK=1` and pass `--disableConsoleIntercept` when running
`memory-graph-api.test.ts` to print the size and handler/serialization elapsed
time for its real 50k regression fixture. This uses Fastify injection with
isolated synthetic services.

Run the CONTRIBUTING.md check/test/build/hygiene sequence, plus:

```
npm test -w @space/web -- memory
npm test -w @space/api -- memory-graph
npm test -w @space/contracts
```

Pure regression tests cover deterministic simulation snapshots, camera and
projection, spatial picking, bounded labels, fallback/lifecycle, bounded input
transport and transferable reply decoding. API tests cover defaults, limits,
redaction and access control. Skipped or platform-specific failures must be
reported separately from passing checks.
