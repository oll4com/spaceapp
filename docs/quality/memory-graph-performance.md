# Reproduce the 3D memory benchmark

The 3D view uses WebGL2 instanced node billboards and batched edges. The depth
buffer resolves overlap; the animation loop does not sort the graph. The layout
worker streams positions before convergence and builds a median-split spatial
index for picking. Pointer movement queries that index instead of scanning nodes
or synchronously reading the GPU. Each renderer reuses traversal storage across
queries; replacing the index resizes that storage outside the pointer path.
Labels examine at most 384 candidates and draw
at most 64 labels, preserving core/source priority, collision avoidance and the
Titles switch.

Label candidates are recalculated only when focus changes or zoom crosses the
label-detail threshold. Text widths are measured lazily and cached for at most
385 titles, including focused nodes outside the candidate pool. Replacing the
graph resets the cache; rotation does not remeasure unchanged text. Label counts,
font, collision rules and rendering resolution are unchanged.

WebGL startup schedules context creation, GPU program setup and graph upload in
separate browser tasks so their costs do not accumulate in the React mount task.
The canvas stays busy and benchmark controls stay disabled until setup finishes.
Unmounting or losing the context cancels pending stages; restoration starts a
new sequence using the latest graph and layout. An individual setup stage can
still block, so the long-task measurement remains the acceptance check.

Large live responses are parsed in a worker. Graph input and atlas styles cross
worker boundaries in bounded batches; edges are referenced by transferred indices
instead of cloning the complete graph back onto the main thread. Position textures,
bounds and the volume diagnostic are prepared off-thread. The main thread reads
transferred coordinates directly instead of recreating 50,000 point objects per
layout update.

The 2D view continues to request the default 2,000-node overview. Selecting 3D
requests `limit=50000` from the existing overview endpoint. Explicit limits are
integers from 1 through 50,000, with at most three edges per requested node.
The route checks the ADMIN role (including legacy OPERATOR administrators) before
reading the snapshot, and still redacts node labels and edge evidence. A limit
change has a different ETag. Larger archives remain explicitly truncated.

## Browser measurement

Use Node 22 and an isolated contributor checkout:

```sh
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
npm run build
npm exec -w @space/web -- vite preview --host 127.0.0.1 --port 4922 --strictPort
```

Open `/demo-workspace?memoryNodes=50000&memoryBenchmark=1` on that preview. The
opt-in harness uses synthetic data without a backend or an embeddings provider.
Wait for the normal workspace to load, then open **Memory**; the harness selects
its 3D view. This exercises the normal Memory-opening flow. Repeat with
`memoryNodes=2000` and `memoryNodes=10000`.
The generator produces exactly three edges per node and deterministic IDs,
labels and topology. Generation yields between batches. No installed workspace
or user memory is read.

After layout finishes, press **Measure 600 frames**. The camera rotates and zooms
while a moving pointer queries the spatial index. The displayed JSON records
requestAnimationFrame interval p95, CPU render/pick timings, maximum pick time,
main-thread long tasks since the workspace opened, actual viewport/DPR, browser
version and GPU renderer. Copy this JSON with the machine model, RAM and OS into
the PR. Measure the compiled build, keep the tab visible, and record material
background load. A run requested in a hidden tab waits and starts automatically
when the tab becomes visible. Hiding the tab, changing graph size or pixel density,
or losing the WebGL context invalidates an active run; start a fresh run after
correcting the condition. Only results with `status: "complete"` and `valid: true`
contain a completed 600-frame measurement. Interrupted samples are not filtered
into a passing result. Frame intervals include browser scheduling; CPU duration alone
is not a frame-rate result. The long-task observer reports zero when it sees no
tasks of at least 50 ms on browsers supporting that observer, not a claim that
every task took zero time. `observerSupport` records available observer types;
unsupported task and long-animation-frame metrics are `null`, not zero.
`maxPageTaskMs` additionally includes the application's earlier startup tasks;
these are reported separately from Memory loading and layout. Diagnostic long
animation frames and measured graph work phases help locate stalls.
`longestMemoryTask` includes the start time of the largest observed task after
Memory opened. Compare it with `loadStartedAt`, `benchmarkStartedAt` and the long
animation frames to investigate a stall; a task's duration alone does not identify
the code responsible. The task maximum is cumulative while Memory remains open.

The target is p95 at most 33 ms for 50k nodes/150k edges, and 16.7 ms for 2k nodes.
Picking must stay within 4 ms and load/layout tasks within 100 ms. Report failures
and hardware constraints rather than treating a smaller graph as a passing 50k
measurement. **Measure scheduling baseline** runs the same frame clock without
rendering or picking. It can identify a scheduling/refresh-rate floor; its result
is labelled `scheduler` and is never a graph performance pass.

Press **Test context recovery** to lose the real WebGL context, use the capped
Canvas fallback, and restore after three seconds. Both views support arrows for
rotation, plus/minus or wheel/pinch for zoom, Enter to open the selected/core node,
and the Titles and Reset controls. If WebGL2 is unavailable at startup, Canvas
is used immediately. A context restoration recreates all GPU resources from the
latest layout. The 2D map renderer is unchanged.

## Server measurement and regression checks

```sh
npm run check
npm test -w @space/web -- memory
npm test -w @space/api -- memory-graph
SPACE_MEMORY_BENCHMARK=1 npm test -w @space/api -- tests/memory-graph-api.test.ts -t 'serves 50k'
```

The final command prints a `memory-overview-50k` JSON record with the redacted,
serialized response size and elapsed time for a real Fastify request to an
isolated in-memory fixture. It tests 50,000 returned nodes and 150,000 edges,
truncation, invalid limits, authentication/role checks, and ETag separation from
the 2,000-node default. It measures route processing and serialization, not a
production database, network or compression. Large responses should be measured
separately from demo rendering.

Pure tests compare indexed picking against exhaustive projection at different
angles and zoom levels, verify depth selection, bounded label LOD, deterministic
stream snapshots, synthetic topology and the fallback cap. Existing memory
projection and source-distance tests remain in place.
