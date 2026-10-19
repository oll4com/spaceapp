import { useEffect, useMemo, useState } from "react";
import type { MemoryGraphNode, MemoryGraphEdge } from "@space/contracts";
import { LivePane } from "../features/live-pane/LivePane.js";
import { MemoryGraph3DStatic } from "../features/memory-workspace/MemoryGraph3DCanvas2D.js";
import { createMemoryAtlas } from "../features/memory-workspace/memory-atlas.js";
import { layoutMemoryNetwork3D } from "../features/memory-workspace/memory-3d.js";
import { createShowcaseFixture } from "./showcase-fixture.js";
import "../features/memory-workspace/memory-atlas.css";
import "./feature-showcase.css";

const conversation = [
  {
    role: "assistant",
    text: "Hello! What would you like to work on in SpaceApp?",
  },
  {
    role: "user",
    text: "Help me review my project. Keep my coding agents together and my research in another room.",
  },
  {
    role: "assistant",
    text: "Use Build for your coding agents and Research for your browser, notes and files. I can help coordinate the work while you stay focused on the idea.",
  },
  {
    role: "user",
    text: "And keep the decisions available for the next session.",
  },
  {
    role: "assistant",
    text: "Your project decisions belong in shared memory. Plans, published files and earlier sessions are available in their workspace docks.",
  },
];
const fixture = createShowcaseFixture();
const pane = fixture.panes.find((p) => p.mode === "LIVE")!;

// Public example knowledge only: never import private memory or session captures.
export function createFeatureGraph() {
  const nodes: MemoryGraphNode[] = [];
  const edges: MemoryGraphEdge[] = [];
  const topics = [
    "Projects",
    "Workspace",
    "Agents",
    "Research",
    "Decisions",
    "Tools",
  ];
  const examples = [
    "Project brief",
    "Review notes",
    "Next steps",
    "Design decision",
    "Useful source",
    "Test results",
    "Working agreement",
    "Implementation notes",
  ];
  topics.forEach((label, group) => {
    const source = `source:public-${group}`,
      topic = `topic:public-${group}`;
    nodes.push({
      id: source,
      type: "SOURCE",
      label: `${label.toLowerCase()}.md`,
      sourcePath: `/demo/${label.toLowerCase()}.md`,
      recordId: null,
    });
    nodes.push({
      id: topic,
      type: "TOPIC",
      label,
      sourcePath: null,
      recordId: null,
    });
    for (let i = 0; i < 28; i++) {
      const id = `memory:public-${group}-${i}`;
      nodes.push({
        id,
        type: "MEMORY",
        label: `${label}: ${examples[i % examples.length]} ${Math.floor(i / examples.length) + 1}`,
        sourcePath: `/demo/${label.toLowerCase()}.md`,
        recordId: id,
      });
      edges.push({
        id: `contains:${id}`,
        source,
        target: id,
        type: "CONTAINS",
      });
      edges.push({
        id: `tag:${id}`,
        source: id,
        target: topic,
        type: "TAGGED_WITH",
        origin: "EXPLICIT_TAG",
        confidence: 1,
      });
    }
  });
  for (let group = 1; group < topics.length; group++)
    edges.push({
      id: `project-link:${group}`,
      source: `source:public-${group}`,
      target: "source:public-0",
      type: "DERIVED_FROM",
    });
  return { nodes, edges };
}
const graph = createFeatureGraph();

function VoiceExample({ step }: { step: number }) {
  // The mock has document-local Storage. Seed before mounting the actual Live pane.
  useState(() => {
    localStorage.setItem(
      `space_live_pane_${pane.id}`,
      JSON.stringify({
        provider: "google",
        voiceModel: "gemini-3.8-live",
        language: "en",
        timeZone: "UTC",
        personalMemoryCollapsed: true,
      }),
    );
    localStorage.setItem(
      `space_live_room_transcripts_${pane.roomId}`,
      JSON.stringify(
        conversation.slice(0, [1, 2, 3, 5][step]).map((item, i) => ({
          ...item,
          id: `public-voice-${i}`,
          timestamp: `10:00:0${i}`,
          createdAtMs: 1790935200000 + i * 1000,
        })),
      ),
    );
    return true;
  });
  return (
    <div className="feature-live">
      <LivePane key={step} pane={pane} workspaceTextSize={15} />
    </div>
  );
}

export function FeatureShowcase({ kind }: { kind: "voice" | "memory" }) {
  const [step, setStep] = useState(0);
  const [running, setRunning] = useState(false);
  const [angle, setAngle] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const atlas = useMemo(
    () => createMemoryAtlas(graph.nodes, graph.edges, false),
    [],
  );
  const base = useMemo(
    () =>
      kind === "memory"
        ? layoutMemoryNetwork3D(graph.nodes, graph.edges)
        : new Map(),
    [kind],
  );
  const coordinates = useMemo(
    () =>
      new Map(
        [...base].map(([id, p]) => [
          id,
          {
            x: p.x * Math.cos(angle) - p.z * Math.sin(angle),
            y: p.y,
            z: p.x * Math.sin(angle) + p.z * Math.cos(angle),
          },
        ]),
      ),
    [base, angle],
  );
  useEffect(() => {
    const send = (payload: object) =>
      parent.postMessage(
        { type: "space-feature:event", kind, ...payload },
        location.origin,
      );
    const receive = (event: MessageEvent) => {
      if (
        event.origin !== location.origin ||
        event.source !== parent ||
        event.data?.type !== "space-feature:command" ||
        event.data.kind !== kind
      )
        return;
      if (event.data.command === "hello") send({ event: "ready" });
      if (event.data.command === "running")
        setRunning(event.data.value === true);
      if (
        event.data.command === "step" &&
        Number.isInteger(event.data.step) &&
        event.data.step >= 0 &&
        event.data.step < 4
      ) {
        setStep(event.data.step);
        const confirmedStep = event.data.step;
        requestAnimationFrame(() =>
          requestAnimationFrame(() =>
            send({ event: "step", step: confirmedStep }),
          ),
        );
        setSelected(
          event.data.step === 2
            ? "topic:public-2"
            : event.data.step === 3
              ? "memory:public-4-3"
              : null,
        );
      }
    };
    window.addEventListener("message", receive);
    send({ event: "ready" });
    return () => window.removeEventListener("message", receive);
  }, [kind]);
  useEffect(() => {
    if (!running || kind !== "memory") return;
    const timer = setInterval(() => setAngle((v) => v + 0.012), 50);
    return () => clearInterval(timer);
  }, [kind, running]);
  return (
    <div
      className={`feature-showcase feature-${kind}`}
      data-step={step}
      data-running={running}
    >
      {kind === "voice" ? (
        <VoiceExample key={step} step={step} />
      ) : (
        <>
          <div className="feature-memory-title">
            <strong>Shared memory</strong>
            <span>
              {graph.nodes.length} example nodes · {graph.edges.length}{" "}
              connections
            </span>
          </div>
          <MemoryGraph3DStatic
            nodes={graph.nodes}
            edges={graph.edges}
            positions={atlas.positions}
            coordinates={coordinates}
            showTitles={step > 0}
            selectedNodeId={selected}
            onSelectNode={setSelected}
            loading={false}
            resetToken={0}
          />
          <div className="feature-memory-detail">
            {selected
              ? graph.nodes.find((n) => n.id === selected)?.label
              : "Projects · Knowledge · Connections"}
          </div>
        </>
      )}
    </div>
  );
}
