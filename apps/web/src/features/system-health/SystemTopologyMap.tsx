import { useEffect, useState, useMemo, useCallback } from "react";
import type {
  SystemTopologyEdge,
  SystemTopologyNode,
  SystemTopologySnapshot,
  SystemTopologySubcomponent,
} from "@space/contracts";
import { api } from "../../api.js";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Boxes as Layers,
  CheckCircle2,
  ChevronRight,
  Cpu,
  Database,
  ExternalLink,
  Minus,
  Network,
  Plus,
  RefreshCw,
  RotateCcw,
  Route,
  Search,
  ServerCog,
  ShieldAlert,
  Terminal,
  Wrench,
  X,
  type LucideIcon,
} from "../ui-theme/app-icons.js";

interface SystemTopologyMapProps {
  onInspectNode?: (nodeId: string) => void;
}

type TierKey = "all" | "clients" | "core" | "runtimes" | "external" | "infra";
type ViewMode = "graph" | "subsystem" | "mcp-control" | "cards";

function getSubcomponentCatColor(cat: string): string {
  const c = cat.toLowerCase();
  if (c.includes("security") || c.includes("auth") || c.includes("guard")) return "#ef4444";
  if (c.includes("control") || c.includes("execution") || c.includes("schedule")) return "#818cf8";
  if (c.includes("diagnostics") || c.includes("vision")) return "#f59e0b";
  if (c.includes("inspect") || c.includes("discovery") || c.includes("telemetry") || c.includes("observability")) return "#10b981";
  if (c.includes("ops") || c.includes("maintenance") || c.includes("transport")) return "#06b6d4";
  if (c.includes("runtime") || c.includes("agent") || c.includes("autonomous") || c.includes("engine")) return "#a855f7";
  if (c.includes("storage") || c.includes("database") || c.includes("persistence") || c.includes("volume")) return "#ec4899";
  if (c.includes("frontend") || c.includes("client") || c.includes("window") || c.includes("input") || c.includes("styling")) return "#38bdf8";
  return "#60a5fa";
}

const tierLabels: Record<TierKey, string> = {
  all: "All Tiers",
  clients: "Clients & UI",
  core: "Core Platform",
  runtimes: "Runtimes & Agents",
  infra: "Infrastructure",
  external: "External Providers",
};

const nodeTypeIcons: Record<string, LucideIcon> = {
  client: Layers,
  gateway: Network,
  database: Database,
  service: Route,
  runtime: Terminal,
  infra: ServerCog,
  external: ExternalLink,
};

// Canvas coordinates for the interactive visual graph (1280x720)
const nodeCoords: Record<string, { x: number; y: number; w: number; h: number; tier: string }> = {
  "client-web": { x: 140, y: 360, w: 210, h: 96, tier: "CLIENTS & UI" },
  "database": { x: 440, y: 160, w: 210, h: 96, tier: "CORE STORAGE" },
  "api-gateway": { x: 440, y: 360, w: 210, h: 100, tier: "CORE GATEWAY" },
  "mcp-gateway": { x: 440, y: 560, w: 210, h: 96, tier: "CORE TOOLS" },
  "temporal-worker": { x: 750, y: 150, w: 210, h: 96, tier: "RUNTIMES" },
  "cli-hosts": { x: 750, y: 290, w: 210, h: 96, tier: "RUNTIMES" },
  "browser-host": { x: 750, y: 430, w: 210, h: 96, tier: "RUNTIMES" },
  "opencode-harness": { x: 750, y: 570, w: 210, h: 96, tier: "RUNTIMES" },
  "proxmox-infra": { x: 1060, y: 160, w: 210, h: 96, tier: "INFRASTRUCTURE" },
  "storage": { x: 1060, y: 360, w: 210, h: 96, tier: "INFRASTRUCTURE" },
  "ai-providers": { x: 1060, y: 560, w: 210, h: 96, tier: "EXTERNAL CLOUD" },
};

function getEdgeGeometry(
  src: { x: number; y: number; w: number; h: number },
  tgt: { x: number; y: number; w: number; h: number }
) {
  // If target is directly above or below in same column
  if (Math.abs(src.x - tgt.x) < 40) {
    if (src.y > tgt.y) {
      // Source is below target (e.g. api-gateway -> database)
      const x1 = src.x;
      const y1 = src.y - src.h / 2;
      const x2 = tgt.x;
      const y2 = tgt.y + tgt.h / 2;
      const cy1 = y1 - 40;
      const cy2 = y2 + 40;
      return {
        pathD: `M ${x1} ${y1} C ${x1} ${cy1}, ${x2} ${cy2}, ${x2} ${y2}`,
        mx: (x1 + x2) / 2,
        my: (y1 + y2) / 2,
      };
    } else {
      // Source is above target (e.g. api-gateway -> mcp-gateway)
      const x1 = src.x;
      const y1 = src.y + src.h / 2;
      const x2 = tgt.x;
      const y2 = tgt.y - tgt.h / 2;
      const cy1 = y1 + 40;
      const cy2 = y2 - 40;
      return {
        pathD: `M ${x1} ${y1} C ${x1} ${cy1}, ${x2} ${cy2}, ${x2} ${y2}`,
        mx: (x1 + x2) / 2,
        my: (y1 + y2) / 2,
      };
    }
  }

  // Left-to-right connection
  if (tgt.x > src.x) {
    const x1 = src.x + src.w / 2;
    const y1 = src.y;
    const x2 = tgt.x - tgt.w / 2;
    const y2 = tgt.y;
    const dx = x2 - x1;
    const cx1 = x1 + dx * 0.45;
    const cx2 = x2 - dx * 0.45;
    return {
      pathD: `M ${x1} ${y1} C ${cx1} ${y1}, ${cx2} ${y2}, ${x2} ${y2}`,
      mx: (x1 + x2) / 2,
      my: (y1 + y2) / 2,
    };
  }

  // Right-to-left connection (e.g. opencode-harness -> mcp-gateway)
  const x1 = src.x - src.w / 2;
  const y1 = src.y;
  const x2 = tgt.x + tgt.w / 2;
  const y2 = tgt.y;
  const dx = Math.abs(x2 - x1);
  const cx1 = x1 - dx * 0.45;
  const cx2 = x2 + dx * 0.45;
  return {
    pathD: `M ${x1} ${y1} C ${cx1} ${y1}, ${cx2} ${y2}, ${x2} ${y2}`,
    mx: (x1 + x2) / 2,
    my: (y1 + y2) / 2,
  };
}

// MCP Control Subsystem Tools (Detailed Breakdown)
interface McpVisualTool {
  id: string;
  name: string;
  category: "Control" | "Inspection" | "Diagnostics" | "Space Ops" | "Infrastructure";
  description: string;
  riskLevel: string;
  protocol: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

const mcpVisualTools: McpVisualTool[] = [
  // Column 1: Control & Diagnostics (x = 830)
  { id: "mcp-space-execute", name: "space_execute", category: "Control", riskLevel: "R1 - Guarded", protocol: "Fastify / JSON-RPC", description: "Apply atomic batches of controls (panes.open, pane close/prompt/color, layout mutation, clipboard).", x: 830, y: 110, w: 230, h: 64 },
  { id: "mcp-space-operations", name: "space_operations", category: "Control", riskLevel: "R1 - Guarded", protocol: "Fastify / Temporal", description: "Inspect, monitor, or cancel durable asynchronous operations and long-running workflows.", x: 830, y: 185, w: 230, h: 64 },
  { id: "mcp-space-schedules", name: "space_schedules", category: "Control", riskLevel: "R1 - Guarded", protocol: "Fastify / Temporal", description: "Create, inspect, or manage deferred, recurring cron, and one-shot scheduled tasks.", x: 830, y: 260, w: 230, h: 64 },
  { id: "mcp-space-watches", name: "space_watches", category: "Control", riskLevel: "R0 - Low", protocol: "Fastify / WebSocket", description: "Durable task completion monitoring with automatic assistant re-engagement upon finish.", x: 830, y: 335, w: 230, h: 64 },
  { id: "mcp-space-debug", name: "space_debug", category: "Diagnostics", riskLevel: "R1 - Guarded", protocol: "Fastify / Diagnostics", description: "Run comprehensive diagnostic checks on any operation or pane, generating incident reports.", x: 830, y: 410, w: 230, h: 64 },
  { id: "mcp-space-test-tools", name: "space_test_mcp_tools", category: "Diagnostics", riskLevel: "R0 - Low", protocol: "Fastify / JSON-RPC", description: "One-by-one automated health and capability verification across all MCP tools and sections.", x: 830, y: 485, w: 230, h: 64 },
  { id: "mcp-srv-space-status", name: "space_status", category: "Space Ops", riskLevel: "R0 - Low", protocol: "stdio (space-readonly)", description: "System readiness, systemd services health, resource telemetry, and port listeners inspection.", x: 830, y: 560, w: 230, h: 64 },
  { id: "mcp-srv-space-logs", name: "space_logs", category: "Space Ops", riskLevel: "R0 - Low", protocol: "stdio (space-readonly)", description: "Targeted journalctl log retrieval across Space core services with line limit and filters.", x: 830, y: 635, w: 230, h: 64 },

  // Column 2: Inspection & Discovery & Infrastructure (x = 1100)
  { id: "mcp-space-inspect", name: "space_inspect", category: "Inspection", riskLevel: "R0 - Low", protocol: "Fastify / JSON-RPC", description: "Authoritative inspection across 19 domains (state, models, quota, runtimes, health, settings, metrics).", x: 1100, y: 110, w: 230, h: 64 },
  { id: "mcp-space-capabilities", name: "space_capabilities", category: "Inspection", riskLevel: "R0 - Low", protocol: "Fastify / JSON-RPC", description: "Discover Space room controls, limits, model configurations, and runtime support.", x: 1100, y: 185, w: 230, h: 64 },
  { id: "mcp-space-list-tools", name: "space_list_mcp_tools", category: "Inspection", riskLevel: "R0 - Low", protocol: "Fastify / JSON-RPC", description: "List all Space Control tools, categories, parameter schemas, and functions.", x: 1100, y: 260, w: 230, h: 64 },
  { id: "mcp-space-describe-panes", name: "space_describe_pane_types", category: "Inspection", riskLevel: "R0 - Low", protocol: "Fastify / JSON-RPC", description: "List supported pane types (CLI, browser, demos, YouTube, files) with open keys and live availability.", x: 1100, y: 335, w: 230, h: 64 },
  { id: "mcp-space-screenshot", name: "space_screenshot", category: "Diagnostics", riskLevel: "R0 - Low", protocol: "CDP / Vision Engine", description: "Full-screen viewport capture and deterministic Vision AI analysis of the Space App UI.", x: 1100, y: 410, w: 230, h: 64 },
  { id: "mcp-srv-ui-proof", name: "space_authenticated_ui_proof", category: "Space Ops", riskLevel: "R1 - Guarded", protocol: "stdio (space-readonly)", description: "Deterministic Headless Chromium authenticated UI proof capture with DOM assertions.", x: 1100, y: 485, w: 230, h: 64 },
  { id: "mcp-infra-transport", name: "JSON-RPC 2.0 Bridge", category: "Infrastructure", riskLevel: "Core Bridge", protocol: "JSON-RPC 2.0", description: "Bidirectional stdio and HTTP JSON-RPC 2.0 protocol serialization and dispatch engine.", x: 1100, y: 560, w: 230, h: 64 },
  { id: "mcp-infra-policy", name: "Security Policy Guard", category: "Infrastructure", riskLevel: "Security Gate", protocol: "Internal Fastify Guard", description: "Risk-level based authorization, schema hash verification, and human-in-the-loop approval gate.", x: 1100, y: 635, w: 230, h: 64 },
];

export function SystemTopologyMap({ onInspectNode }: SystemTopologyMapProps) {
  const [snapshot, setSnapshot] = useState<SystemTopologySnapshot | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedSubcomponent, setSelectedSubcomponent] = useState<SystemTopologySubcomponent | null>(null);
  const [subcomponentSearch, setSubcomponentSearch] = useState<string>("");
  const [filterTier, setFilterTier] = useState<TierKey>("all");
  const [viewMode, setViewMode] = useState<ViewMode>("graph");
  const [activeSubsystemId, setActiveSubsystemId] = useState<string>("mcp-gateway");
  const [autoRefresh, setAutoRefresh] = useState<boolean>(true);
  const [zoom, setZoom] = useState<number>(1);

  const loadTopology = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await api.systemTopology();
      setSnapshot(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load system topology");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTopology();
  }, [loadTopology]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(() => {
      void loadTopology();
    }, 10_000);
    return () => clearInterval(interval);
  }, [autoRefresh, loadTopology]);

  const selectedNode = useMemo(() => {
    if (!snapshot || !selectedNodeId) return null;
    return snapshot.nodes.find((n) => n.id === selectedNodeId) ?? null;
  }, [snapshot, selectedNodeId]);

  const nodeConnections = useMemo(() => {
    if (!snapshot || !selectedNodeId) return { incoming: [], outgoing: [] };
    const incoming = snapshot.edges.filter((e) => e.target === selectedNodeId);
    const outgoing = snapshot.edges.filter((e) => e.source === selectedNodeId);
    return { incoming, outgoing };
  }, [snapshot, selectedNodeId]);

  const filteredNodes = useMemo(() => {
    if (!snapshot) return [];
    if (filterTier === "all") return snapshot.nodes;
    return snapshot.nodes.filter((n) => n.group === filterTier);
  }, [snapshot, filterTier]);

  const tierGroups = useMemo(() => {
    const clients = filteredNodes.filter((n) => n.group === "clients");
    const core = filteredNodes.filter((n) => n.group === "core");
    const runtimes = filteredNodes.filter((n) => n.group === "runtimes");
    const infraAndExternal = filteredNodes.filter(
      (n) => n.group === "infra" || n.group === "external"
    );
    return { clients, core, runtimes, infraAndExternal };
  }, [filteredNodes]);

  const filteredSubcomponents = useMemo(() => {
    if (!selectedNode?.subcomponents) return [];
    if (!subcomponentSearch.trim()) return selectedNode.subcomponents;
    const q = subcomponentSearch.toLowerCase().trim();
    return selectedNode.subcomponents.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.category.toLowerCase().includes(q) ||
        (s.protocol && s.protocol.toLowerCase().includes(q)) ||
        (s.riskLevel && s.riskLevel.toLowerCase().includes(q)) ||
        s.description.toLowerCase().includes(q)
    );
  }, [selectedNode, subcomponentSearch]);

  const getNodeStatusTone = (status: SystemTopologyNode["status"]) => {
    switch (status) {
      case "healthy":
        return {
          bg: "rgba(16, 185, 129, 0.12)",
          border: "rgba(16, 185, 129, 0.4)",
          text: "#10b981",
          dot: "#10b981",
          label: "Healthy",
        };
      case "warning":
        return {
          bg: "rgba(245, 158, 11, 0.12)",
          border: "rgba(245, 158, 11, 0.4)",
          text: "#f59e0b",
          dot: "#f59e0b",
          label: "Degraded",
        };
      case "critical":
      case "unavailable":
        return {
          bg: "rgba(239, 68, 68, 0.12)",
          border: "rgba(239, 68, 68, 0.4)",
          text: "#ef4444",
          dot: "#ef4444",
          label: "Offline",
        };
      case "disabled":
      default:
        return {
          bg: "rgba(148, 163, 184, 0.1)",
          border: "rgba(148, 163, 184, 0.25)",
          text: "#94a3b8",
          dot: "#94a3b8",
          label: "Disabled",
        };
    }
  };

  const getEdgeStatusTone = (status: SystemTopologyEdge["status"]) => {
    switch (status) {
      case "active":
        return { text: "#10b981", border: "rgba(16, 185, 129, 0.3)", bg: "rgba(16, 185, 129, 0.08)" };
      case "degraded":
        return { text: "#f59e0b", border: "rgba(245, 158, 11, 0.3)", bg: "rgba(245, 158, 11, 0.08)" };
      case "inactive":
      default:
        return { text: "#ef4444", border: "rgba(239, 68, 68, 0.3)", bg: "rgba(239, 68, 68, 0.08)" };
    }
  };

  const renderNodeCard = (node: SystemTopologyNode) => {
    const tone = getNodeStatusTone(node.status);
    const Icon = nodeTypeIcons[node.type] ?? ServerCog;
    const isSelected = selectedNodeId === node.id;
    const isConnectedToSelected =
      selectedNodeId !== null &&
      snapshot?.edges.some(
        (e) =>
          (e.source === selectedNodeId && e.target === node.id) ||
          (e.target === selectedNodeId && e.source === node.id)
      );

    return (
      <div
        key={node.id}
        onClick={() => {
          setSelectedNodeId(node.id);
          onInspectNode?.(node.id);
        }}
        className={`topology-node-card ${isSelected ? "selected" : ""} ${
          isConnectedToSelected ? "connected-highlight" : ""
        }`}
        style={{
          border: isSelected
            ? `2px solid ${tone.text}`
            : isConnectedToSelected
            ? `1px solid rgba(59, 130, 246, 0.5)`
            : `1px solid ${tone.border}`,
          background: isSelected ? "rgba(30, 41, 59, 0.95)" : tone.bg,
        }}
      >
        <div className="topology-node-header">
          <div className="topology-node-title-group">
            <span className="topology-node-icon" style={{ color: tone.text }}>
              <Icon size={16} />
            </span>
            <div className="topology-node-name-wrapper">
              <span className="topology-node-name">{node.label}</span>
              {node.host && <span className="topology-node-host">{node.host}</span>}
            </div>
          </div>
          <span
            className="topology-node-status-badge"
            style={{ color: tone.text, borderColor: tone.border }}
          >
            <span
              className="topology-status-pulse"
              style={{ backgroundColor: tone.dot }}
            />
            {tone.label}
          </span>
        </div>

        <p className="topology-node-detail">{node.detail}</p>

        {node.metrics && node.metrics.length > 0 && (
          <div className="topology-node-metrics">
            {node.metrics.slice(0, 3).map((m, idx) => (
              <span key={idx} className="topology-metric-chip">
                <span className="topology-metric-label">{m.label}:</span>{" "}
                <strong className="topology-metric-value">{m.value}</strong>
              </span>
            ))}
          </div>
        )}
      </div>
    );
  };

  const renderSvgGraph = () => {
    if (!snapshot) return null;

    return (
      <div className="topology-svg-canvas-container">
        {!selectedNodeId && (
          <div className="topology-canvas-tip">
            Click any node to view real-time telemetry & connections
          </div>
        )}

        <div className="topology-canvas-floating-controls">
          <button
            type="button"
            className="topology-canvas-btn"
            title="Zoom In"
            onClick={(e) => {
              e.stopPropagation();
              setZoom((z) => Math.min(Math.round((z + 0.15) * 100) / 100, 1.8));
            }}
          >
            <Plus size={13} />
          </button>
          <button
            type="button"
            className="topology-canvas-btn"
            title="Reset Zoom (100%)"
            onClick={(e) => {
              e.stopPropagation();
              setZoom(1);
            }}
          >
            <RotateCcw size={12} />
            <span className="topology-zoom-val">{Math.round(zoom * 100)}%</span>
          </button>
          <button
            type="button"
            className="topology-canvas-btn"
            title="Zoom Out"
            onClick={(e) => {
              e.stopPropagation();
              setZoom((z) => Math.max(Math.round((z - 0.15) * 100) / 100, 0.7));
            }}
          >
            <Minus size={13} />
          </button>
        </div>

        <svg
          viewBox="0 0 1280 720"
          width="100%"
          height="100%"
          className="topology-svg-canvas"
          preserveAspectRatio="xMidYMid meet"
          style={{
            minWidth: `${Math.round(920 * zoom)}px`,
            minHeight: `${Math.round(540 * zoom)}px`,
            aspectRatio: "1280 / 720",
          }}
        >
          <defs>
            <filter id="drop-shadow" x="-10%" y="-10%" width="130%" height="130%">
              <feDropShadow dx="0" dy="6" stdDeviation="5" floodColor="#000" floodOpacity="0.45" />
            </filter>
            <filter id="glow-shadow" x="-20%" y="-20%" width="140%" height="140%">
              <feDropShadow dx="0" dy="0" stdDeviation="8" floodColor="#38bdf8" floodOpacity="0.75" />
            </filter>
            <marker
              id="arrow-active"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 1.5 L 8 5 L 0 8.5 z" fill="#38bdf8" />
            </marker>
            <marker
              id="arrow-warning"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 1.5 L 8 5 L 0 8.5 z" fill="#f59e0b" />
            </marker>
            <marker
              id="arrow-critical"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 1.5 L 8 5 L 0 8.5 z" fill="#ef4444" />
            </marker>
            <pattern id="grid-pattern" width="40" height="40" patternUnits="userSpaceOnUse">
              <path d="M 40 0 L 0 0 0 40" fill="none" stroke="rgba(255,255,255,0.04)" strokeWidth="1" />
            </pattern>
          </defs>

          {/* Grid background (click to deselect node) */}
          <rect
            width="100%"
            height="100%"
            fill="url(#grid-pattern)"
            onClick={() => setSelectedNodeId(null)}
            style={{ cursor: "default" }}
          />

          {/* Tier Labels */}
          <g opacity="0.75" className="svg-tier-headers">
            <text x="140" y="45" fill="#38bdf8" fontSize="13" fontWeight="800" textAnchor="middle" letterSpacing="0.06em">
              1. CLIENTS & UI
            </text>
            <text x="440" y="45" fill="#a855f7" fontSize="13" fontWeight="800" textAnchor="middle" letterSpacing="0.06em">
              2. CORE PLATFORM HUB
            </text>
            <text x="750" y="45" fill="#eab308" fontSize="13" fontWeight="800" textAnchor="middle" letterSpacing="0.06em">
              3. RUNTIMES & AGENTS
            </text>
            <text x="1060" y="45" fill="#10b981" fontSize="13" fontWeight="800" textAnchor="middle" letterSpacing="0.06em">
              4. INFRASTRUCTURE & CLOUD
            </text>
          </g>

          {/* Edges */}
          <g className="svg-edges-layer">
            {snapshot.edges.map((edge) => {
              const src = nodeCoords[edge.source];
              const tgt = nodeCoords[edge.target];
              if (!src || !tgt) return null;

              const geom = getEdgeGeometry(src, tgt);
              const isConnected = selectedNodeId === edge.source || selectedNodeId === edge.target;
              const isActive = edge.status === "active";
              const strokeColor = isConnected
                ? "#38bdf8"
                : isActive
                ? "rgba(56, 189, 248, 0.65)"
                : edge.status === "degraded"
                ? "#f59e0b"
                : "#ef4444";
              const markerId =
                edge.status === "inactive"
                  ? "arrow-critical"
                  : edge.status === "degraded"
                  ? "arrow-warning"
                  : "arrow-active";

              return (
                <g key={edge.id} className="svg-edge-group">
                  <path
                    d={geom.pathD}
                    fill="none"
                    stroke={strokeColor}
                    strokeWidth={isConnected ? 3 : 2}
                    strokeDasharray={isActive ? "6,4" : undefined}
                    className={isActive ? "flowing-edge" : undefined}
                    markerEnd={`url(#${markerId})`}
                  />
                  <rect
                    x={geom.mx - 36}
                    y={geom.my - 11}
                    width={72}
                    height={22}
                    rx={6}
                    fill="#0b1120"
                    stroke={strokeColor}
                    strokeWidth={1}
                    strokeOpacity={0.7}
                  />
                  <text
                    x={geom.mx}
                    y={geom.my + 4}
                    fill="#e2e8f0"
                    fontSize={10}
                    fontWeight={600}
                    textAnchor="middle"
                  >
                    {edge.label}
                  </text>
                </g>
              );
            })}
          </g>

          {/* Nodes */}
          <g className="svg-nodes-layer">
            {snapshot.nodes.map((node) => {
              const coord = nodeCoords[node.id];
              if (!coord) return null;
              const tone = getNodeStatusTone(node.status);
              const left = coord.x - coord.w / 2;
              const top = coord.y - coord.h / 2;
              const isSelected = selectedNodeId === node.id;
              const isConnected =
                selectedNodeId !== null &&
                snapshot.edges.some(
                  (e) =>
                    (e.source === selectedNodeId && e.target === node.id) ||
                    (e.target === selectedNodeId && e.source === node.id)
                );

              return (
                <g
                  key={node.id}
                  className={`svg-interactive-node ${isSelected ? "is-selected" : ""}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedNodeId(node.id);
                    onInspectNode?.(node.id);
                  }}
                  style={{ cursor: "pointer" }}
                >
                  <rect
                    x={left}
                    y={top}
                    width={coord.w}
                    height={coord.h}
                    rx={14}
                    fill={isSelected ? "#1e293b" : "#0c1322"}
                    stroke={isSelected ? "#38bdf8" : isConnected ? "rgba(56, 189, 248, 0.75)" : tone.border}
                    strokeWidth={isSelected ? 2.5 : isConnected ? 2 : 1.5}
                    filter={isSelected ? "url(#glow-shadow)" : "url(#drop-shadow)"}
                  />
                  <rect
                    x={left}
                    y={top}
                    width={coord.w}
                    height={coord.h}
                    rx={14}
                    fill={tone.bg}
                  />

                  {/* Node host/tier pill */}
                  <rect x={left + 12} y={top + 12} width={74} height={18} rx={5} fill="rgba(0,0,0,0.4)" stroke={tone.border} strokeWidth={0.5} />
                  <text x={left + 18} y={top + 25} fill="#94a3b8" fontSize={10} fontWeight={700}>
                    {(node.host || coord.tier).toUpperCase().slice(0, 11)}
                  </text>

                  {/* Status dot */}
                  <circle cx={left + coord.w - 20} cy={top + 21} r={5} fill={tone.dot} />
                  <circle cx={left + coord.w - 20} cy={top + 21} r={9} fill="none" stroke={tone.dot} strokeWidth={1.5} strokeOpacity={0.4} />

                  {/* Label */}
                  <text x={left + 12} y={top + 52} fill="#f8fafc" fontSize={14} fontWeight={700}>
                    {node.label}
                  </text>

                  {/* Metrics */}
                  <text x={left + 12} y={top + 71} fill="#94a3b8" fontSize={11}>
                    {node.metrics?.[0] ? `${node.metrics[0].label}: ${node.metrics[0].value}`.slice(0, 27) : node.detail.slice(0, 27)}
                  </text>
                  <text x={left + 12} y={top + 86} fill="#cbd5e1" fontSize={11} fontWeight={500}>
                    {node.metrics?.[1] ? `${node.metrics[1].label}: ${node.metrics[1].value}`.slice(0, 27) : ""}
                  </text>

                  {node.subcomponents && node.subcomponents.length > 0 && (
                    <g
                      onClick={(e) => {
                        e.stopPropagation();
                        setActiveSubsystemId(node.id);
                        setSelectedNodeId(node.id);
                        onInspectNode?.(node.id);
                        setViewMode("subsystem");
                      }}
                      style={{ cursor: "pointer" }}
                    >
                      <rect
                        x={left + coord.w - 114}
                        y={top + 10}
                        width={102}
                        height={20}
                        rx={5}
                        fill="rgba(56, 189, 248, 0.18)"
                        stroke="rgba(56, 189, 248, 0.6)"
                        strokeWidth={1}
                      />
                      <text
                        x={left + coord.w - 63}
                        y={top + 24}
                        fill="#38bdf8"
                        fontSize={9.5}
                        fontWeight={700}
                        textAnchor="middle"
                      >
                        {node.id === "mcp-gateway" ? "16 Tools Map ↗" : `${node.subcomponents.length} Tools ↗`}
                      </text>
                    </g>
                  )}
                </g>
              );
            })}
          </g>
        </svg>
      </div>
    );
  };

  const renderSubsystemGraph = (subsystemNodeId: string) => {
    if (!snapshot) return null;
    const targetNode =
      snapshot.nodes.find((n) => n.id === subsystemNodeId) ??
      snapshot.nodes.find((n) => n.id === "mcp-gateway") ??
      snapshot.nodes[0];
    if (!targetNode) return null;

    const subcomponents = targetNode.subcomponents ?? [];
    const tone = getNodeStatusTone(targetNode.status);

    const upstreams = snapshot.edges
      .filter((e) => e.target === targetNode.id)
      .map((e) => ({
        edge: e,
        node: snapshot.nodes.find((n) => n.id === e.source),
      }))
      .filter((u): u is { edge: SystemTopologyEdge; node: SystemTopologyNode } => Boolean(u.node));

    const categoryCounts: Record<string, number> = {};
    for (const sub of subcomponents) {
      categoryCounts[sub.category] = (categoryCounts[sub.category] ?? 0) + 1;
    }

    const isMultiColumn = subcomponents.length > 7;
    const half = Math.ceil(subcomponents.length / 2);

    const subLayouts = subcomponents.map((sub, idx) => {
      if (!isMultiColumn) {
        const w = 320;
        const h = 66;
        const x = 760;
        const totalH = subcomponents.length * 66 + (subcomponents.length - 1) * 16;
        const startY = Math.max(70, Math.round((700 - totalH) / 2));
        const y = startY + idx * 82;
        return { sub, x, y, w, h };
      } else {
        const col = idx < half ? 0 : 1;
        const row = idx < half ? idx : idx - half;
        const w = 265;
        const h = 64;
        const x = col === 0 ? 710 : 995;
        const startY = Math.max(50, Math.round((700 - half * 76) / 2));
        const y = startY + row * 76;
        return { sub, x, y, w, h };
      }
    });

    const hubX = 330;
    const hubY = 270;
    const hubW = 250;
    const hubH = 150;
    const hubCenterY = hubY + hubH / 2;

    const uCount = upstreams.length;
    const uStartY = Math.max(70, Math.round((720 - uCount * 94) / 2));

    return (
      <div className="topology-svg-canvas-container mcp-subsystem-container">
        {/* Top Header Bar */}
        <div className="topology-mcp-top-bar">
          <button
            type="button"
            className="topology-back-btn"
            onClick={() => setViewMode("graph")}
          >
            <ArrowLeft size={14} />
            <span>Back to Full Topology</span>
          </button>

          <div className="topology-mcp-title-group">
            <span className="topology-mcp-badge">{targetNode.group.toUpperCase()} SUBSYSTEM</span>
            <span className="topology-mcp-title">{targetNode.label} Architecture &amp; Sub-components</span>
            <span className="topology-mcp-sub">
              {subcomponents.length} capabilities · Host: {targetNode.host ?? "public-host"}
            </span>
          </div>

          <div className="topology-mcp-category-pills">
            {Object.entries(categoryCounts).slice(0, 5).map(([cat, count]) => {
              const color = getSubcomponentCatColor(cat);
              return (
                <span
                  key={cat}
                  className="mcp-cat-pill"
                  style={{
                    backgroundColor: `${color}18`,
                    color: color,
                    borderColor: `${color}40`,
                    borderWidth: 1,
                    borderStyle: "solid",
                  }}
                >
                  {cat} ({count})
                </span>
              );
            })}
          </div>
        </div>

        {/* Subsystem Quick Switcher Bar */}
        <div className="topology-subsystem-quick-nav">
          <span className="quick-nav-label">Select Subsystem:</span>
          {snapshot.nodes.map((n) => (
            <button
              key={n.id}
              type="button"
              className={`subsystem-nav-pill ${activeSubsystemId === n.id ? "active" : ""}`}
              onClick={() => {
                setActiveSubsystemId(n.id);
                setSelectedNodeId(n.id);
                onInspectNode?.(n.id);
              }}
            >
              {n.label} {n.subcomponents?.length ? `(${n.subcomponents.length})` : ""}
            </button>
          ))}
        </div>

        {/* Floating Zoom Controls */}
        <div className="topology-canvas-floating-controls">
          <button
            type="button"
            className="topology-canvas-btn"
            title="Zoom In"
            onClick={(e) => {
              e.stopPropagation();
              setZoom((z) => Math.min(Math.round((z + 0.15) * 100) / 100, 1.8));
            }}
          >
            <Plus size={13} />
          </button>
          <button
            type="button"
            className="topology-canvas-btn"
            title="Reset Zoom (100%)"
            onClick={(e) => {
              e.stopPropagation();
              setZoom(1);
            }}
          >
            <RotateCcw size={12} />
            <span className="topology-zoom-val">{Math.round(zoom * 100)}%</span>
          </button>
          <button
            type="button"
            className="topology-canvas-btn"
            title="Zoom Out"
            onClick={(e) => {
              e.stopPropagation();
              setZoom((z) => Math.max(Math.round((z - 0.15) * 100) / 100, 0.7));
            }}
          >
            <Minus size={13} />
          </button>
        </div>

        {/* SVG Subsystem Canvas */}
        <svg
          viewBox="0 0 1380 730"
          width="100%"
          height="100%"
          className="topology-svg-canvas"
          preserveAspectRatio="xMidYMid meet"
          style={{
            minWidth: `${Math.round(980 * zoom)}px`,
            minHeight: `${Math.round(560 * zoom)}px`,
            aspectRatio: "1380 / 730",
          }}
        >
          <defs>
            <filter id="sub-drop-shadow" x="-10%" y="-10%" width="130%" height="130%">
              <feDropShadow dx="0" dy="5" stdDeviation="4" floodColor="#000" floodOpacity="0.5" />
            </filter>
            <filter id="sub-glow-shadow" x="-20%" y="-20%" width="140%" height="140%">
              <feDropShadow dx="0" dy="0" stdDeviation="8" floodColor="#38bdf8" floodOpacity="0.8" />
            </filter>
            <marker
              id="sub-arrow"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 1.5 L 8 5 L 0 8.5 z" fill="#38bdf8" />
            </marker>
            <pattern id="sub-grid-pattern" width="40" height="40" patternUnits="userSpaceOnUse">
              <path d="M 40 0 L 0 0 0 40" fill="none" stroke="rgba(255,255,255,0.03)" strokeWidth="1" />
            </pattern>
          </defs>

          {/* Grid Background */}
          <rect
            width="100%"
            height="100%"
            fill="url(#sub-grid-pattern)"
            onClick={() => setSelectedSubcomponent(null)}
            style={{ cursor: "default" }}
          />

          {/* Section Headers */}
          <g opacity="0.8" className="svg-tier-headers">
            <text x="135" y="45" fill="#38bdf8" fontSize="12" fontWeight="800" textAnchor="middle" letterSpacing="0.06em">
              1. UPSTREAM CALLERS ({upstreams.length})
            </text>
            <text x="455" y="45" fill="#a855f7" fontSize="12" fontWeight="800" textAnchor="middle" letterSpacing="0.06em">
              2. {targetNode.label.toUpperCase()} CORE HUB
            </text>
            <text x={isMultiColumn ? 945 : 915} y="45" fill="#10b981" fontSize="12" fontWeight="800" textAnchor="middle" letterSpacing="0.06em">
              3. SUB-COMPONENTS &amp; CAPABILITIES ({subcomponents.length})
            </text>
          </g>

          {/* Upstream Caller Nodes & Edges to Hub */}
          {upstreams.map((u, i) => {
            const uX = 30;
            const uY = uStartY + i * 94;
            const uW = 210;
            const uH = 80;
            const outX = uX + uW;
            const outY = uY + uH / 2;
            const midX = (outX + hubX) / 2;
            const d = `M ${outX} ${outY} C ${midX} ${outY}, ${midX} ${hubCenterY}, ${hubX} ${hubCenterY}`;

            return (
              <g key={`upstream-${u.node.id}`}>
                <path
                  d={d}
                  fill="none"
                  stroke="rgba(56, 189, 248, 0.65)"
                  strokeWidth="2"
                  strokeDasharray="6,4"
                  className="flowing-edge"
                  markerEnd="url(#sub-arrow)"
                />
                <rect
                  x={midX - 35}
                  y={(outY + hubCenterY) / 2 - 10}
                  width={70}
                  height={18}
                  rx={4}
                  fill="#0b1120"
                  stroke="rgba(56, 189, 248, 0.4)"
                  strokeWidth={0.8}
                />
                <text
                  x={midX}
                  y={(outY + hubCenterY) / 2 + 3}
                  fill="#94a3b8"
                  fontSize={8.5}
                  textAnchor="middle"
                  fontWeight={600}
                >
                  {u.edge.protocol ? u.edge.protocol.slice(0, 14) : "Call"}
                </text>

                <g
                  className="svg-interactive-node"
                  onClick={() => {
                    setActiveSubsystemId(u.node.id);
                    setSelectedNodeId(u.node.id);
                    onInspectNode?.(u.node.id);
                  }}
                  style={{ cursor: "pointer" }}
                >
                  <rect
                    x={uX}
                    y={uY}
                    width={uW}
                    height={uH}
                    rx={12}
                    fill="#0c1322"
                    stroke="#38bdf8"
                    strokeWidth={1.5}
                    filter="url(#sub-drop-shadow)"
                  />
                  <rect x={uX + 12} y={uY + 12} width={76} height={16} rx={4} fill="rgba(56, 189, 248, 0.2)" />
                  <text x={uX + 18} y={uY + 24} fill="#38bdf8" fontSize={9} fontWeight={700}>
                    {u.node.group.toUpperCase().slice(0, 12)}
                  </text>
                  <circle cx={uX + uW - 16} cy={uY + 20} r={4.5} fill="#10b981" />
                  <text x={uX + 12} y={uY + 48} fill="#f8fafc" fontSize={13} fontWeight={700}>
                    {u.node.label}
                  </text>
                  <text x={uX + 12} y={uY + 66} fill="#94a3b8" fontSize={10}>
                    {u.node.host ?? "Active caller"}
                  </text>
                </g>
              </g>
            );
          })}

          {/* Upstream fallback if no upstream connections */}
          {upstreams.length === 0 && (
            <g opacity="0.6">
              <rect x={35} y={320} width={200} height={70} rx={10} fill="rgba(255,255,255,0.02)" stroke="rgba(255,255,255,0.1)" strokeDasharray="4,4" />
              <text x={135} y={352} fill="#64748b" fontSize={11} textAnchor="middle" fontWeight={600}>
                Entrypoint / Root Source
              </text>
              <text x={135} y={368} fill="#475569" fontSize={9.5} textAnchor="middle">
                No upstream caller dependencies
              </text>
            </g>
          )}

          {/* Center Hub Node */}
          <g
            className="svg-interactive-node is-selected"
            onClick={() => {
              setSelectedNodeId(targetNode.id);
              onInspectNode?.(targetNode.id);
            }}
            style={{ cursor: "pointer" }}
          >
            <rect
              x={hubX}
              y={hubY}
              width={hubW}
              height={hubH}
              rx={16}
              fill="#111827"
              stroke={tone.text}
              strokeWidth={2.5}
              filter="url(#sub-glow-shadow)"
            />
            <rect x={hubX + 14} y={hubY + 14} width={88} height={18} rx={5} fill="rgba(0,0,0,0.5)" stroke={tone.border} strokeWidth={0.8} />
            <text x={hubX + 22} y={hubY + 27} fill="#94a3b8" fontSize={9.5} fontWeight={800}>
              {targetNode.group.toUpperCase()}
            </text>
            <circle cx={hubX + hubW - 20} cy={hubY + 23} r={5} fill={tone.dot} />
            <circle cx={hubX + hubW - 20} cy={hubY + 23} r={9} fill="none" stroke={tone.dot} strokeWidth={1.5} strokeOpacity={0.4} />

            <text x={hubX + 14} y={hubY + 56} fill="#f8fafc" fontSize={15} fontWeight={800}>
              {targetNode.label}
            </text>
            <text x={hubX + 14} y={hubY + 76} fill="#94a3b8" fontSize={11}>
              {targetNode.detail.slice(0, 32)}
            </text>
            <text x={hubX + 14} y={hubY + 94} fill="#cbd5e1" fontSize={10} fontWeight={500}>
              {targetNode.metrics?.[0] ? `${targetNode.metrics[0].label}: ${targetNode.metrics[0].value}` : `Host: ${targetNode.host ?? "Local"}`}
            </text>
            <rect x={hubX + 14} y={hubY + 112} width={hubW - 28} height={22} rx={5} fill="rgba(16, 185, 129, 0.15)" stroke="rgba(16, 185, 129, 0.3)" strokeWidth={0.8} />
            <text x={hubX + 22} y={hubY + 127} fill="#10b981" fontSize={9.5} fontWeight={700}>
              {subcomponents.length} Capabilities Active · {tone.label}
            </text>
          </g>

          {/* Connectors from Hub to Subcomponents */}
          <g className="svg-sub-edges">
            {subLayouts.map(({ sub, x, y, h }) => {
              const isSelected = selectedSubcomponent?.id === sub.id;
              const catColor = getSubcomponentCatColor(sub.category);
              const hubOutX = hubX + hubW;
              const hubOutY = hubCenterY;
              const toolInX = x;
              const toolInY = y + h / 2;
              const midX = (hubOutX + toolInX) / 2;
              const d = `M ${hubOutX} ${hubOutY} C ${midX} ${hubOutY}, ${midX} ${toolInY}, ${toolInX} ${toolInY}`;

              return (
                <path
                  key={`edge-${sub.id}`}
                  d={d}
                  fill="none"
                  stroke={isSelected ? "#38bdf8" : catColor}
                  strokeOpacity={isSelected ? 1 : 0.4}
                  strokeWidth={isSelected ? 3 : 1.5}
                  strokeDasharray={isSelected ? "5,3" : undefined}
                  className={isSelected ? "flowing-edge" : undefined}
                />
              );
            })}
          </g>

          {/* Subcomponent Cards */}
          <g className="svg-sub-nodes">
            {subLayouts.map(({ sub, x, y, w, h }) => {
              const isSelected = selectedSubcomponent?.id === sub.id;
              const catColor = getSubcomponentCatColor(sub.category);
              const isR1 = sub.riskLevel?.includes("R1");

              return (
                <g
                  key={sub.id}
                  className={`svg-mcp-tool-card ${isSelected ? "selected" : ""}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedSubcomponent(isSelected ? null : sub);
                    setSelectedNodeId(targetNode.id);
                    onInspectNode?.(targetNode.id);
                  }}
                  style={{ cursor: "pointer" }}
                >
                  <rect
                    x={x}
                    y={y}
                    width={w}
                    height={h}
                    rx={10}
                    fill={isSelected ? "#1e293b" : "#0f172a"}
                    stroke={isSelected ? "#38bdf8" : catColor}
                    strokeWidth={isSelected ? 2 : 1}
                    strokeOpacity={isSelected ? 1 : 0.6}
                    filter={isSelected ? "url(#sub-glow-shadow)" : "url(#sub-drop-shadow)"}
                  />

                  {/* Left color bar */}
                  <rect
                    x={x}
                    y={y + 4}
                    width={4}
                    height={h - 8}
                    rx={2}
                    fill={catColor}
                  />

                  {/* Subcomponent Name */}
                  <text
                    x={x + 14}
                    y={y + 22}
                    fill="#f8fafc"
                    fontSize={11.5}
                    fontWeight={700}
                    letterSpacing="0.02em"
                  >
                    {sub.name}
                  </text>

                  {/* Risk Badge */}
                  {sub.riskLevel && (
                    <>
                      <rect
                        x={x + w - (isR1 ? 78 : 64)}
                        y={y + 11}
                        width={isR1 ? 70 : 56}
                        height={15}
                        rx={3}
                        fill={isR1 ? "rgba(245, 158, 11, 0.2)" : "rgba(16, 185, 129, 0.15)"}
                      />
                      <text
                        x={x + w - (isR1 ? 43 : 36)}
                        y={y + 22}
                        fill={isR1 ? "#f59e0b" : "#10b981"}
                        fontSize={8.5}
                        fontWeight={700}
                        textAnchor="middle"
                      >
                        {sub.riskLevel.split(" - ")[0]}
                      </text>
                    </>
                  )}

                  {/* Protocol */}
                  <text
                    x={x + 14}
                    y={y + 39}
                    fill="#94a3b8"
                    fontSize={9.5}
                    fontWeight={500}
                  >
                    {sub.protocol ?? sub.category}
                  </text>

                  {/* Description preview */}
                  <text
                    x={x + 14}
                    y={y + 54}
                    fill="#64748b"
                    fontSize={9}
                  >
                    {sub.description.length > 38 ? `${sub.description.slice(0, 38)}...` : sub.description}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>
      </div>
    );
  };

  return (
    <div className="topology-container">
      {/* Top Bar with Metrics & Controls */}
      <div className="topology-toolbar">
        <div className="topology-summary-stats">
          <div className="topology-stat-item">
            <span className="topology-stat-num">{snapshot?.summary.totalNodes ?? 0}</span>
            <span className="topology-stat-label">Nodes</span>
          </div>
          <div className="topology-stat-divider" />
          <div className="topology-stat-item healthy">
            <CheckCircle2 size={15} className="topology-stat-icon" />
            <span className="topology-stat-num">{snapshot?.summary.healthyNodes ?? 0}</span>
            <span className="topology-stat-label">Healthy</span>
          </div>
          {(snapshot?.summary.warningNodes ?? 0) > 0 && (
            <div className="topology-stat-item warning">
              <AlertTriangle size={15} className="topology-stat-icon" />
              <span className="topology-stat-num">{snapshot?.summary.warningNodes}</span>
              <span className="topology-stat-label">Warning</span>
            </div>
          )}
          {(snapshot?.summary.criticalNodes ?? 0) > 0 && (
            <div className="topology-stat-item critical">
              <ShieldAlert size={15} className="topology-stat-icon" />
              <span className="topology-stat-num">{snapshot?.summary.criticalNodes}</span>
              <span className="topology-stat-label">Offline</span>
            </div>
          )}
          <div className="topology-stat-divider" />
          <div className="topology-stat-item active-edges">
            <Network size={15} className="topology-stat-icon" />
            <span className="topology-stat-num">{snapshot?.summary.activeEdges ?? 0}</span>
            <span className="topology-stat-label">Connections</span>
          </div>
        </div>

        <div className="topology-controls">
          {/* View Mode Toggle */}
          <div className="topology-view-toggle">
            <button
              type="button"
              onClick={() => setViewMode("graph")}
              className={`topology-toggle-btn ${viewMode === "graph" ? "active" : ""}`}
            >
              Visual Graph
            </button>
            <button
              type="button"
              onClick={() => {
                setViewMode("subsystem");
                if (!activeSubsystemId) setActiveSubsystemId("mcp-gateway");
              }}
              className={`topology-toggle-btn ${viewMode === "subsystem" || viewMode === "mcp-control" ? "active" : ""}`}
            >
              Subsystem Deep-Dive
            </button>
            <button
              type="button"
              onClick={() => setViewMode("cards")}
              className={`topology-toggle-btn ${viewMode === "cards" ? "active" : ""}`}
            >
              Cards Grid
            </button>
          </div>

          {/* Tier Filters */}
          {viewMode === "cards" && (
            <div className="topology-tier-filters">
              {(Object.keys(tierLabels) as TierKey[]).map((tier) => (
                <button
                  key={tier}
                  type="button"
                  onClick={() => setFilterTier(tier)}
                  className={`topology-filter-btn ${filterTier === tier ? "active" : ""}`}
                >
                  {tierLabels[tier]}
                </button>
              ))}
            </div>
          )}

          <div className="topology-actions">
            <label className="topology-autorefresh-toggle">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
              />
              <span>Live (10s)</span>
            </label>

            <button
              type="button"
              onClick={() => void loadTopology()}
              disabled={loading}
              className="topology-refresh-btn"
              title="Refresh topology now"
            >
              <RefreshCw size={14} className={loading ? "spin" : ""} />
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className="topology-error-banner">
          <AlertTriangle size={16} />
          <span>{error}</span>
          <button type="button" onClick={() => void loadTopology()}>
            Retry
          </button>
        </div>
      )}

      {/* Main View Area: Graph Canvas, Subsystem Canvas or Column Grid */}
      <div className="topology-layout-wrapper">
        <div className="topology-main-view">
          {viewMode === "graph" ? (
            renderSvgGraph()
          ) : viewMode === "subsystem" || viewMode === "mcp-control" ? (
            renderSubsystemGraph(activeSubsystemId)
          ) : (
            <div className="topology-columns-grid">
              {tierGroups.clients.length > 0 && (
                <div className="topology-column">
                  <div className="topology-column-header">
                    <span className="topology-col-tag clients">Clients</span>
                    <h4>Frontend & Access</h4>
                  </div>
                  <div className="topology-column-nodes">
                    {tierGroups.clients.map(renderNodeCard)}
                  </div>
                </div>
              )}

              {tierGroups.core.length > 0 && (
                <div className="topology-column">
                  <div className="topology-column-header">
                    <span className="topology-col-tag core">Core Hub</span>
                    <h4>Gateway & Storage</h4>
                  </div>
                  <div className="topology-column-nodes">
                    {tierGroups.core.map(renderNodeCard)}
                  </div>
                </div>
              )}

              {tierGroups.runtimes.length > 0 && (
                <div className="topology-column">
                  <div className="topology-column-header">
                    <span className="topology-col-tag runtimes">Execution</span>
                    <h4>Runtimes & Agents</h4>
                  </div>
                  <div className="topology-column-nodes">
                    {tierGroups.runtimes.map(renderNodeCard)}
                  </div>
                </div>
              )}

              {tierGroups.infraAndExternal.length > 0 && (
                <div className="topology-column">
                  <div className="topology-column-header">
                    <span className="topology-col-tag infra">External & Host</span>
                    <h4>Cluster & Cloud</h4>
                  </div>
                  <div className="topology-column-nodes">
                    {tierGroups.infraAndExternal.map(renderNodeCard)}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Node Inspector Card */}
        {selectedNode && (
          <aside className="topology-inspector-panel">
            <div className="topology-inspector-header">
              <div className="topology-inspector-title">
                <span className="topology-inspector-badge">{selectedNode.type.toUpperCase()}</span>
                <h3>{selectedNode.label}</h3>
              </div>
              <button
                type="button"
                className="topology-inspector-close"
                onClick={() => setSelectedNodeId(null)}
              >
                <X size={16} />
              </button>
            </div>

            <div className="topology-inspector-body">
              <div className="topology-inspector-row">
                <span className="topology-inspector-label">Health Status:</span>
                <span
                  className="topology-node-status-badge"
                  style={{
                    color: getNodeStatusTone(selectedNode.status).text,
                    borderColor: getNodeStatusTone(selectedNode.status).border,
                  }}
                >
                  {selectedNode.status.toUpperCase()}
                </span>
              </div>

              {selectedNode.host && (
                <div className="topology-inspector-row">
                  <span className="topology-inspector-label">Host Node:</span>
                  <span className="topology-inspector-val">{selectedNode.host}</span>
                </div>
              )}

              <div className="topology-inspector-desc">
                <p>{selectedNode.detail}</p>
              </div>

              {selectedNode.metrics && selectedNode.metrics.length > 0 && (
                <div className="topology-inspector-metrics-section">
                  <h5>Telemetry & Metrics</h5>
                  <div className="topology-inspector-metrics-table">
                    {selectedNode.metrics.map((m, idx) => (
                      <div key={idx} className="topology-inspector-metric-row">
                        <span className="metric-k">{m.label}</span>
                        <span className="metric-v">{m.value}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Sub-components & Tools (e.g. MCP Control 16 Tools) */}
              {selectedNode.subcomponents && selectedNode.subcomponents.length > 0 && (
                <div className="topology-inspector-subcomponents-section">
                  <div className="subcomponents-section-header">
                    <div className="subcomponents-title-row">
                      <h5>
                        Sub-components & Tools ({selectedNode.subcomponents.length})
                      </h5>
                      <button
                        type="button"
                        className="subcomponents-deepdive-btn"
                        onClick={() => {
                          setActiveSubsystemId(selectedNode.id);
                          setViewMode("subsystem");
                        }}
                        title={`Open Interactive Subsystem Map for ${selectedNode.label}`}
                      >
                        <span>Subsystem Map</span>
                        <ChevronRight size={13} />
                      </button>
                    </div>

                    <div className="subcomponents-search-box">
                      <Search size={13} className="search-icon" />
                      <input
                        type="text"
                        placeholder="Filter tools by name, protocol..."
                        value={subcomponentSearch}
                        onChange={(e) => setSubcomponentSearch(e.target.value)}
                      />
                      {subcomponentSearch && (
                        <button
                          type="button"
                          className="search-clear-btn"
                          onClick={() => setSubcomponentSearch("")}
                        >
                          <X size={12} />
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Selected Subcomponent Highlight / Drawer */}
                  {selectedSubcomponent && (
                    <div className="subcomponent-detail-drawer">
                      <div className="subcomponent-detail-header">
                        <div className="detail-name-row">
                          <Wrench size={13} className="detail-icon" />
                          <span className="detail-name">{selectedSubcomponent.name}</span>
                        </div>
                        <button
                          type="button"
                          className="detail-close-btn"
                          onClick={() => setSelectedSubcomponent(null)}
                        >
                          <X size={12} />
                        </button>
                      </div>
                      <div className="detail-tags">
                        <span className="detail-tag cat">{selectedSubcomponent.category}</span>
                        {selectedSubcomponent.riskLevel && (
                          <span className={`detail-tag risk ${selectedSubcomponent.riskLevel.includes("R1") ? "r1" : "r0"}`}>
                            {selectedSubcomponent.riskLevel}
                          </span>
                        )}
                        {selectedSubcomponent.protocol && (
                          <span className="detail-tag proto">{selectedSubcomponent.protocol}</span>
                        )}
                      </div>
                      <p className="detail-desc">{selectedSubcomponent.description}</p>
                    </div>
                  )}

                  {/* Subcomponents Cards List */}
                  <div className="subcomponents-cards-list">
                    {filteredSubcomponents.map((sub) => {
                      const isSubSelected = selectedSubcomponent?.id === sub.id;
                      return (
                        <div
                          key={sub.id}
                          className={`subcomponent-chip-card ${isSubSelected ? "is-selected" : ""}`}
                          onClick={() => setSelectedSubcomponent(isSubSelected ? null : sub)}
                        >
                          <div className="subcomponent-chip-head">
                            <span className="chip-name">{sub.name}</span>
                            {sub.riskLevel && (
                              <span className={`chip-risk ${sub.riskLevel.includes("R1") ? "r1" : "r0"}`}>
                                {sub.riskLevel.split(" - ")[0]}
                              </span>
                            )}
                          </div>
                          <div className="chip-cat-line">
                            <span className="chip-cat">{sub.category}</span>
                            {sub.protocol && <span className="chip-proto">{sub.protocol}</span>}
                          </div>
                          <p className="chip-desc">{sub.description}</p>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Connected Services */}
              <div className="topology-inspector-connections-section">
                <h5>Active Connections ({nodeConnections.incoming.length + nodeConnections.outgoing.length})</h5>

                {nodeConnections.incoming.length > 0 && (
                  <div className="topology-conn-group">
                    <span className="conn-group-title">Upstream Callers</span>
                    {nodeConnections.incoming.map((edge) => {
                      const tone = getEdgeStatusTone(edge.status);
                      const sourceLabel =
                        snapshot?.nodes.find((n) => n.id === edge.source)?.label ?? edge.source;
                      return (
                        <div key={edge.id} className="topology-conn-item">
                          <div className="conn-info">
                            <span className="conn-peer">{sourceLabel}</span>
                            <span className="conn-protocol">{edge.protocol}</span>
                          </div>
                          <span
                            className="conn-status-tag"
                            style={{ color: tone.text, borderColor: tone.border }}
                          >
                            {edge.label}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}

                {nodeConnections.outgoing.length > 0 && (
                  <div className="topology-conn-group">
                    <span className="conn-group-title">Downstream Services</span>
                    {nodeConnections.outgoing.map((edge) => {
                      const tone = getEdgeStatusTone(edge.status);
                      const targetLabel =
                        snapshot?.nodes.find((n) => n.id === edge.target)?.label ?? edge.target;
                      return (
                        <div key={edge.id} className="topology-conn-item">
                          <div className="conn-info">
                            <span className="conn-peer">{targetLabel}</span>
                            <span className="conn-protocol">{edge.protocol}</span>
                          </div>
                          <span
                            className="conn-status-tag"
                            style={{ color: tone.text, borderColor: tone.border }}
                          >
                            {edge.label}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
