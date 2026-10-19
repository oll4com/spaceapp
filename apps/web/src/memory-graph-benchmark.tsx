import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryGraph3D } from "./features/memory-workspace/MemoryGraph3D.js";
import { useMemoryArchive } from "./features/memory-workspace/useMemoryArchive.js";
import "./features/memory-workspace/memory-atlas.css";
import "./memory-graph-benchmark.css";

/** Uses the production component and archive worker, with no server or provider. */
function BenchmarkPage() {
  const [count, setCount] = useState(2000), [titles, setTitles] = useState(true);
  const [selected, setSelected] = useState<string | null>(null), [reset, setReset] = useState(0);
  const archive = useMemoryArchive(true, true, count, "");
  const state = archive.state;
  return <main>
    <header>
      <h1>Memory graph browser benchmark</h1>
      <label>Graph size <select value={count} onChange={event => { setCount(Number(event.target.value)); setSelected(null); }}>
        <option value="2000">2,000</option><option value="10000">10,000</option><option value="50000">50,000</option>
      </select></label>
      <label><input type="checkbox" checked={titles} onChange={event => setTitles(event.target.checked)} /> Titles</label>
      <button onClick={() => setReset(value => value + 1)}>Reset camera</button>
      <output>{state ? `${state.model.nodes.length.toLocaleString("en-US")} nodes / ${state.model.edgeKinds.length.toLocaleString("en-US")} edges` : "Loading in worker…"}</output>
      <output aria-label="Selected node">{selected ?? "No node selected"}</output>
    </header>
    <p>Drag or use arrow keys to rotate. Scroll or use +/− to zoom. Click a node to select. Keep this tab visible during measurement.</p>
    {archive.error ? <p role="alert">{archive.error}</p> : null}
    <section className="memory-graph-benchmark-view" aria-label="Graph benchmark viewport" data-layout-ready={state?.complete === true}>
      <MemoryGraph3D nodes={state?.atlas.nodes ?? EMPTY_NODES} edges={state?.atlas.edges ?? EMPTY_EDGES} positions={state?.atlas.positions ?? EMPTY_POSITIONS} coordinates={EMPTY_DEPTH}
        preparedModel={state?.model} frame={state?.frame} benchmark showTitles={titles} selectedNodeId={selected} onSelectNode={setSelected}
        loading={!state?.complete} resetToken={reset} />
    </section>
  </main>;
}
const EMPTY_DEPTH = new Map<string, { x: number; y: number; z: number }>();
const EMPTY_POSITIONS = new Map();
const EMPTY_NODES: import("@space/contracts").MemoryGraphNode[] = [];
const EMPTY_EDGES: import("@space/contracts").MemoryGraphEdge[] = [];
createRoot(document.getElementById("root")!).render(<BenchmarkPage />);
