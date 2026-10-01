import type {
  SystemHealthSnapshot,
  SystemTopologyEdge,
  SystemTopologyNode,
  SystemTopologySnapshot,
  SystemTopologySubcomponent,
} from "@space/contracts";

export interface SystemTopologyGeneratorOptions {
  getHealthSnapshot: () => Promise<SystemHealthSnapshot>;
}

export class SystemTopologyService {
  constructor(private readonly options: SystemTopologyGeneratorOptions) {}

  async snapshot(): Promise<SystemTopologySnapshot> {
    const health = await this.options.getHealthSnapshot();
    const serviceMap = new Map(health.services.map((s) => [s.id, s]));

    const getStatus = (id: string, fallback: SystemTopologyNode["status"] = "healthy"): SystemTopologyNode["status"] => {
      const s = serviceMap.get(id);
      if (!s) return fallback;
      if (s.status === "disabled") return "disabled";
      if (s.status === "unavailable") return "unavailable";
      if (s.status === "critical") return "critical";
      if (s.status === "warning") return "warning";
      return "healthy";
    };

    const getMetrics = (id: string) => {
      return (serviceMap.get(id)?.values ?? []).map((v) => ({
        label: v.label,
        value: v.value,
      }));
    };

    const getDetail = (id: string, fallback: string) => {
      return serviceMap.get(id)?.detail ?? fallback;
    };

    const apiStatus = getStatus("api");
    const dbStatus = getStatus("database");
    const workerStatus = getStatus("worker");
    const cliStatus = getStatus("cli-host");
    const browserStatus = getStatus("browser-host");
    const storageStatus = getStatus("storage");
    const mcpStatus = getStatus("mcp");
    const providerStatus = getStatus("provider");

    const nodes: SystemTopologyNode[] = [
      {
        id: "client-web",
        label: "Space Web Client",
        type: "client",
        group: "clients",
        status: "healthy",
        detail: "React 19 SPA client with real-time WebSocket feeds",
        host: "Browser / Desktop",
        metrics: [{ label: "Engine", value: "React 19 + Vite" }],
        subcomponents: [
          { id: "web-spa", name: "React 19 SPA Core", category: "Frontend Core", status: "active", description: "Vite-bundled React 19 single-page administrative shell with zero-reload updates", riskLevel: "R0 - Low", protocol: "HTTPS / Vite" },
          { id: "web-ws-client", name: "Real-time Stream Client", category: "Live Transport", status: "active", description: "WebSocket client maintaining real-time pane, diagnostic streams, and health events", riskLevel: "R0 - Low", protocol: "WSS / Reconnecting" },
          { id: "web-panes-engine", name: "Multi-Room Pane Engine", category: "Window Manager", status: "active", description: "6-room / 96-pane layout engine with responsive docking, grid, and split panes", riskLevel: "R0 - Low", protocol: "Virtual DOM / rAF" },
          { id: "web-chat-dock", name: "Autonomous Agent Chat Dock", category: "Agent Interaction", status: "active", description: "Rich multi-agent prompt composer with attachments, model selector, and markdown streaming", riskLevel: "R0 - Low", protocol: "SSE / React Hooks" },
          { id: "web-keyboard-driver", name: "On-Screen & Physical Keyboard", category: "Input Layer", status: "active", description: "Integrated virtual touch keyboard, macro triggers, and global shortcut navigation", riskLevel: "R0 - Low", protocol: "Web Events / Touch" },
          { id: "web-theme-engine", name: "Motion Geometric Theme Engine", category: "Styling & UI", status: "active", description: "Dynamic theme switcher supporting Modern Dark, Motion Geometric, and High-Contrast", riskLevel: "R0 - Low", protocol: "CSS Variables" },
          { id: "web-diag", name: "App Diagnostics Surface", category: "Observability", status: "active", description: "Telemetry charts, room inspector, memory monitors, and live error boundaries", riskLevel: "R0 - Low", protocol: "In-Browser Store" },
        ],
      },
      {
        id: "api-gateway",
        label: "Space API Gateway",
        type: "gateway",
        group: "core",
        status: apiStatus,
        detail: getDetail("api", "Fastify REST & WebSockets gateway on port 4911"),
        host: "public-host",
        metrics: [
          ...getMetrics("api"),
          { label: "Uptime", value: `${Math.round(health.uptimeSeconds)} s` },
          { label: "CPU Cores", value: String(health.coreCount) },
        ],
        subcomponents: [
          { id: "api-fastify", name: "Fastify HTTP/1.1 Engine", category: "HTTP Gateway", status: "active", description: "Asynchronous high-performance REST routing server dispatching admin & system endpoints", riskLevel: "Core Service", protocol: "HTTP/1.1 (Port 4911)" },
          { id: "api-ws-server", name: "WebSocket Stream Hub", category: "Stream Transport", status: "active", description: "Real-time pub/sub broker multiplexing CLI pseudoterminal, room state, and telemetry", riskLevel: "Core Service", protocol: "WebSocket Server" },
          { id: "api-auth-broker", name: "Session Auth Broker & CSRF", category: "Authentication", status: "active", description: "Stateless HMAC-signed token validation, CSRF double-submit guard, and TTL enforcement", riskLevel: "Security Gate", protocol: "HMAC SHA-256 / Cookies" },
          { id: "api-guard", name: "RBAC & Actor Permission Guard", category: "Authorization", status: "active", description: "Role-based policy engine protecting admin endpoints and operator mutations", riskLevel: "Security Gate", protocol: "Internal Fastify Guard" },
          { id: "api-ratelimit", name: "Sliding Window Rate Limiter", category: "Traffic Control", status: "active", description: "Sliding window token bucket mitigating DDoS and prompt burst saturation", riskLevel: "R0 - Low", protocol: "In-Memory Window" },
          { id: "api-pty-manager", name: "Node-PTY Process Manager", category: "Terminal Bridge", status: "active", description: "Allocates, binds, and monitors interactive pseudoterminals for agent and root sessions", riskLevel: "R1 - Guarded", protocol: "Unix Domain Sockets" },
          { id: "api-health-collector", name: "System Health Collector", category: "Telemetry", status: "active", description: "Polls CPU, memory, swap, disk, network, and systemd services every 5 seconds", riskLevel: "R0 - Low", protocol: "Internal Sampling" },
        ],
      },
      {
        id: "database",
        label: "Space Database Store",
        type: "database",
        group: "core",
        status: dbStatus,
        detail: getDetail("database", "Relational persistence store (PostgreSQL / SQLite)"),
        host: "public-host",
        metrics: getMetrics("database"),
        subcomponents: [
          { id: "db-postgres", name: "PostgreSQL 17 Primary Store", category: "Persistent Storage", status: dbStatus === "healthy" ? "active" : dbStatus, description: "Primary relational database persisting users, sessions, rooms, panes, and analytics", riskLevel: "Core Database", protocol: "TCP / Port 5432" },
          { id: "db-sqlite", name: "SQLite Cache & Task Store", category: "Local Persistence", status: "active", description: "High-speed zero-network SQLite database for local caching and ephemeral task telemetry", riskLevel: "R0 - Low", protocol: "POSIX Filesystem" },
          { id: "db-migrations", name: "Knex Schema Migration Engine", category: "Schema Integrity", status: "active", description: "Automated incremental database migrations with transactional rollback verification", riskLevel: "R1 - Guarded", protocol: "Knex DDL Engine" },
          { id: "db-pool", name: "Connection Pool Multiplexer", category: "Connection Mgmt", status: "active", description: "Manages bounded client pool with automatic reconnection and query timeouts", riskLevel: "Core Engine", protocol: "pg-pool / KeepAlive" },
          { id: "db-audit-store", name: "Security & Audit Event Store", category: "Compliance", status: "active", description: "Immutable chronological log recording all administrative modifications and access events", riskLevel: "R0 - Low", protocol: "Append-Only SQL" },
        ],
      },
      {
        id: "temporal-worker",
        label: "Temporal & Workers",
        type: "service",
        group: "runtimes",
        status: workerStatus,
        detail: getDetail("worker", "Temporal activity workers and background workflows"),
        host: "public-host",
        metrics: getMetrics("worker"),
        subcomponents: [
          { id: "worker-temporal", name: "Temporal Workflow Engine", category: "Orchestration", status: workerStatus === "healthy" ? "active" : workerStatus, description: "Deterministic workflow orchestrator and durable state machine execution runner", riskLevel: "Core Engine", protocol: "gRPC / Port 7233" },
          { id: "worker-activities", name: "Activity Worker Pool", category: "Task Execution", status: workerStatus === "healthy" ? "active" : workerStatus, description: "Distributed task workers processing scheduled, long-running, and background jobs", riskLevel: "R1 - Guarded", protocol: "Temporal Activity Queue" },
          { id: "worker-schedules", name: "Cron & Scheduled Tasks", category: "Scheduler", status: "active", description: "Dispatcher for deferred cron tasks, recurring maintenance, and one-shot timers", riskLevel: "R1 - Guarded", protocol: "Temporal Schedules" },
          { id: "worker-maintenance", name: "Housekeeping & Retention", category: "Maintenance", status: "active", description: "Periodic stale session reclamation, vacuum operations, and temporary file purging", riskLevel: "R0 - Low", protocol: "Internal Poller" },
          { id: "worker-heartbeat", name: "Task Watchdog & Failover", category: "High Availability", status: "active", description: "Continuous worker health pulse monitor with automatic retry and error isolation", riskLevel: "R0 - Low", protocol: "Heartbeat Ping" },
        ],
      },
      {
        id: "cli-hosts",
        label: "PTY CLI Hosts",
        type: "runtime",
        group: "runtimes",
        status: cliStatus,
        detail: getDetail("cli-host", "Interactive pseudoterminal hosts (cli:codex, cli:root)"),
        host: "public-host",
        metrics: getMetrics("cli-host"),
        subcomponents: [
          { id: "cli-codex", name: "cli:codex Agent Terminal", category: "Agent Terminal", status: "active", description: "Isolated pseudoterminal session running Codex, Gemini, DeepSeek, and subagent CLIs", riskLevel: "R0 - Low", protocol: "node-pty / Socket" },
          { id: "cli-root", name: "cli:root Privileged Shell", category: "System Terminal", status: "active", description: "Administrative terminal host with sudo access for host configuration and diagnostics", riskLevel: "R1 - Guarded", protocol: "node-pty / Root Shell" },
          { id: "cli-sweeper", name: "PTY Process Sweeper", category: "Process Hygiene", status: "active", description: "Identifies and reaps orphaned child processes, detached shells, and zombie tasks", riskLevel: "R0 - Low", protocol: "POSIX Signals (SIGTERM)" },
          { id: "cli-ansi", name: "ANSI Stream & Buffer Parser", category: "Stream Formatting", status: "active", description: "Bidirectional terminal ANSI escape sequence sanitizer and resize handler", riskLevel: "R0 - Low", protocol: "VT100 / xterm.js" },
          { id: "cli-history", name: "Scrollback Ring Buffer", category: "Session Persistence", status: "active", description: "Maintains up to 10,000 lines of historical terminal output per pane with search", riskLevel: "R0 - Low", protocol: "Circular RAM Buffer" },
        ],
      },
      {
        id: "browser-host",
        label: "Browser Host",
        type: "runtime",
        group: "runtimes",
        status: browserStatus,
        detail: getDetail("browser-host", "Headless Chromium browser session runtime"),
        host: "public-host",
        metrics: getMetrics("browser-host"),
        subcomponents: [
          { id: "browser-chromium", name: "Headless Chromium Engine", category: "Browser Runtime", status: browserStatus === "healthy" ? "active" : browserStatus, description: "Sandboxed Chromium instance running automated browser workflows and UI inspections", riskLevel: "Core Runtime", protocol: "CDP / Chromium Process" },
          { id: "browser-cdp", name: "Chrome DevTools Protocol Bridge", category: "Protocol Bridge", status: "active", description: "Direct programmatic DOM access, console log interception, and network surveillance", riskLevel: "R0 - Low", protocol: "CDP WebSocket" },
          { id: "browser-vision", name: "Viewport Screenshot Pipeline", category: "Vision AI", status: "active", description: "High-resolution viewport rasterizer for visual proof captures and AI vision analysis", riskLevel: "R0 - Low", protocol: "CDP Page.captureScreenshot" },
          { id: "browser-auth", name: "Session Credential Injector", category: "Auth Bridge", status: "active", description: "Securely injects authenticated cookies into isolated contexts without credential exposure", riskLevel: "R1 - Guarded", protocol: "Network.setCookie" },
          { id: "browser-context-pool", name: "Context Isolation Manager", category: "Sandbox Isolation", status: "active", description: "Enforces strict incognito session boundaries preventing cross-test state leakage", riskLevel: "R0 - Low", protocol: "Chromium Target" },
        ],
      },
      {
        id: "storage",
        label: "Storage & Artifacts",
        type: "infra",
        group: "infra",
        status: storageStatus,
        detail: getDetail("storage", "Dedicated storage volume & artifact repository"),
        host: "public-host",
        metrics: getMetrics("storage"),
        subcomponents: [
          { id: "storage-volume", name: "Space Persistent Volume", category: "Storage Volume", status: "active", description: "Dedicated storage mount allocated under /opt/spaceapp/var for runtime artifacts and logs", riskLevel: "Core Storage", protocol: "POSIX Filesystem" },
          { id: "storage-artifacts", name: "Agent Files & Deliverables Depot", category: "Artifact Store", status: "active", description: "Publicly accessible workspace artifact repository powering Space Agent Files dock", riskLevel: "R0 - Low", protocol: "Local FS / HTTP" },
          { id: "storage-uploads", name: "CLI Uploads Staging Depot", category: "Upload Storage", status: "active", description: "Staging area for multimodal user images, videos, and CLI prompt attachments", riskLevel: "R0 - Low", protocol: "POSIX FS (/cli-uploads)" },
          { id: "storage-publish-broker", name: "Space File Publisher", category: "Publishing Broker", status: "active", description: "Authoritative binary /opt/spaceapp/bin/space-publish-file for deliverable registration", riskLevel: "R0 - Low", protocol: "CLI Binary / Tool" },
          { id: "storage-backups", name: "Encrypted Snapshot Archive", category: "Backup Vault", status: "active", description: "Daily encrypted database dumps and workspace state snapshots", riskLevel: "R1 - Guarded", protocol: "tar.zst / SHA-256" },
        ],
      },
      {
        id: "mcp-gateway",
        label: "MCP Tool Gateway",
        type: "service",
        group: "core",
        status: mcpStatus,
        detail: getDetail("mcp", "Model Context Protocol tools and discovery gateway"),
        host: "public-host",
        metrics: getMetrics("mcp"),
        subcomponents: [
          {
            id: "mcp-space-capabilities",
            name: "space_capabilities",
            category: "Space Control: Discovery",
            status: "active",
            description: "Discover Space room controls, limits, model configurations, and runtime support.",
            riskLevel: "R0 - Low",
            protocol: "Fastify / JSON-RPC",
          },
          {
            id: "mcp-space-inspect",
            name: "space_inspect",
            category: "Space Control: Inspection",
            status: "active",
            description: "Authoritative inspection across 19 domains (state, models, quota, runtimes, health, settings, metrics).",
            riskLevel: "R0 - Low",
            protocol: "Fastify / JSON-RPC",
          },
          {
            id: "mcp-space-execute",
            name: "space_execute",
            category: "Space Control: Execution",
            status: "active",
            description: "Apply atomic batches of controls (panes.open, pane close/prompt/color, layout mutation, clipboard).",
            riskLevel: "R1 - Guarded",
            protocol: "Fastify / JSON-RPC",
          },
          {
            id: "mcp-space-screenshot",
            name: "space_screenshot",
            category: "Space Control: Vision AI",
            status: "active",
            description: "Full-screen viewport capture and deterministic Vision AI analysis of the Space App UI.",
            riskLevel: "R0 - Low",
            protocol: "CDP / Vision Engine",
          },
          {
            id: "mcp-space-operations",
            name: "space_operations",
            category: "Space Control: Operations",
            status: "active",
            description: "Inspect, monitor, or cancel durable asynchronous operations and long-running workflows.",
            riskLevel: "R1 - Guarded",
            protocol: "Fastify / Temporal",
          },
          {
            id: "mcp-space-schedules",
            name: "space_schedules",
            category: "Space Control: Automation",
            status: "active",
            description: "Create, inspect, or manage deferred, recurring cron, and one-shot scheduled tasks.",
            riskLevel: "R1 - Guarded",
            protocol: "Fastify / Temporal",
          },
          {
            id: "mcp-space-watches",
            name: "space_watches",
            category: "Space Control: Monitoring",
            status: "active",
            description: "Durable task completion monitoring with automatic assistant re-engagement upon finish.",
            riskLevel: "R0 - Low",
            protocol: "Fastify / WebSocket",
          },
          {
            id: "mcp-space-test-tools",
            name: "space_test_mcp_tools",
            category: "Space Control: Diagnostics",
            status: "active",
            description: "One-by-one automated health and capability verification across all MCP tools and sections.",
            riskLevel: "R0 - Low",
            protocol: "Fastify / JSON-RPC",
          },
          {
            id: "mcp-space-list-tools",
            name: "space_list_mcp_tools",
            category: "Space Control: Discovery",
            status: "active",
            description: "List all Space Control tools, categories, parameter schemas, and functions.",
            riskLevel: "R0 - Low",
            protocol: "Fastify / JSON-RPC",
          },
          {
            id: "mcp-space-describe-panes",
            name: "space_describe_pane_types",
            category: "Space Control: Inspection",
            status: "active",
            description: "List supported pane types (CLI, browser, demos, YouTube, files) with open keys and live availability.",
            riskLevel: "R0 - Low",
            protocol: "Fastify / JSON-RPC",
          },
          {
            id: "mcp-space-debug",
            name: "space_debug",
            category: "Space Control: Diagnostics",
            status: "active",
            description: "Run comprehensive diagnostic checks on any operation or pane, generating incident reports.",
            riskLevel: "R1 - Guarded",
            protocol: "Fastify / Diagnostics",
          },
          {
            id: "mcp-srv-space-status",
            name: "space_status",
            category: "Space Ops MCP Server",
            status: "active",
            description: "System readiness, systemd services health, resource telemetry, and port listeners inspection.",
            riskLevel: "R0 - Low",
            protocol: "stdio (space-readonly)",
          },
          {
            id: "mcp-srv-space-logs",
            name: "space_logs",
            category: "Space Ops MCP Server",
            status: "active",
            description: "Targeted journalctl log retrieval across Space core services with line limit and filters.",
            riskLevel: "R0 - Low",
            protocol: "stdio (space-readonly)",
          },
          {
            id: "mcp-srv-ui-proof",
            name: "space_authenticated_ui_proof",
            category: "Space Ops MCP Server",
            status: "active",
            description: "Deterministic Headless Chromium authenticated UI proof capture with DOM assertions.",
            riskLevel: "R1 - Guarded",
            protocol: "stdio (space-readonly)",
          },
          {
            id: "mcp-infra-transport",
            name: "JSON-RPC 2.0 Transport Bridge",
            category: "MCP Infrastructure",
            status: "active",
            description: "Bidirectional stdio and HTTP JSON-RPC 2.0 protocol serialization and dispatch engine.",
            riskLevel: "Core Bridge",
            protocol: "JSON-RPC 2.0",
          },
          {
            id: "mcp-infra-policy",
            name: "Security Policy & Allowlist Guard",
            category: "MCP Infrastructure",
            status: "active",
            description: "Risk-level based authorization, schema hash verification, and human-in-the-loop approval gate.",
            riskLevel: "Security Gate",
            protocol: "Internal Fastify Guard",
          },
        ],
      },
      {
        id: "opencode-harness",
        label: "OpenCode & Harness",
        type: "runtime",
        group: "runtimes",
        status: "healthy",
        detail: "Autonomous agent execution engine and harness feeds",
        host: "public-host",
        metrics: [{ label: "Status", value: "Active runtime" }],
        subcomponents: [
          { id: "harness-engine", name: "Agent Execution Loop", category: "Autonomous Engine", status: "active", description: "Multi-turn reasoning and tool invocation driver orchestrating autonomous tasks", riskLevel: "R1 - Guarded", protocol: "Agent Process Loop" },
          { id: "harness-feed", name: "Harness Event Feed", category: "Event Bus", status: "active", description: "Real-time subscriber bus streaming live agent thought steps, tool calls, and statuses", riskLevel: "R0 - Low", protocol: "WebSocket / Shared Feed" },
          { id: "harness-daemon", name: "OpenCode TUI Daemon Bridge", category: "TUI Integration", status: "active", description: "Headless connector interfacing OpenCode terminal sessions with Spaceapp panes", riskLevel: "R0 - Low", protocol: "Unix Socket / IPC" },
          { id: "harness-resume", name: "Native Task Resume Engine", category: "Fault Tolerance", status: "active", description: "Stateful task reconnector restoring disrupted agent sessions via native checkpoints", riskLevel: "R1 - Guarded", protocol: "Task Checkpointer" },
          { id: "harness-subagent-pool", name: "Dynamic Subagent Manager", category: "Hierarchy Control", status: "active", description: "Spawns, monitors, and terminates isolated subagent conversations with scoped workspaces", riskLevel: "R1 - Guarded", protocol: "Subagent IPC" },
        ],
      },
      {
        id: "ai-providers",
        label: "AI Model Providers",
        type: "external",
        group: "external",
        status: providerStatus,
        detail: getDetail("provider", "Gemini, OpenAI, Claude, DeepSeek & Ollama gateways"),
        host: "Cloud & Local",
        metrics: getMetrics("provider"),
        subcomponents: [
          { id: "ai-gemini", name: "Google Gemini API Gateway", category: "Frontier Cloud AI", status: "active", description: "Gemini 2.5 Flash, 2.5 Pro, and Ultra multimodal reasoning models with vision", riskLevel: "R0 - Low", protocol: "HTTPS / REST" },
          { id: "ai-claude", name: "Anthropic Claude API Gateway", category: "Frontier Cloud AI", status: "active", description: "Claude 3.5 Sonnet, 3.7 Sonnet, and Opus frontier code reasoning models", riskLevel: "R0 - Low", protocol: "HTTPS / REST" },
          { id: "ai-openai-deepseek", name: "OpenAI & DeepSeek Gateway", category: "Frontier Cloud AI", status: "active", description: "GPT-4o, Reasonix, and DeepSeek-V3 high-throughput reasoning and vision models", riskLevel: "R0 - Low", protocol: "HTTPS / REST" },
          { id: "ai-ollama", name: "Local Ollama Engine", category: "Local AI", status: "active", description: "Zero-latency local quantized LLM inference provider for offline tasks", riskLevel: "R0 - Low", protocol: "HTTP / Port 11434" },
          { id: "ai-stream", name: "Token Streaming Multiplexer", category: "Stream Transport", status: "active", description: "Handles token chunking, backpressure, and graceful failover across provider APIs", riskLevel: "R0 - Low", protocol: "Server-Sent Events (SSE)" },
        ],
      },
      {
        id: "proxmox-infra",
        label: "Proxmox VE Cluster",
        type: "infra",
        group: "infra",
        status: "healthy",
        detail: "pve.example.invalid (192.0.2.10) · public-host prod ⇄ public-host sync",
        host: "pve.example.invalid",
        metrics: [
          { label: "Cluster Host", value: "pve.example.invalid" },
          { label: "Gateway", value: "192.0.2.1" },
        ],
        subcomponents: [
          { id: "pve-host", name: "Proxmox Hypervisor Host", category: "Hypervisor", status: "active", description: "pve.example.invalid (192.0.2.10), Gateway 192.0.2.1, hosting virtual machines and network", riskLevel: "Cluster Node", protocol: "PVE API / Port 8006" },
          { id: "pve-vm207", name: "public-host (Production Node)", category: "Production VM", status: "active", description: "Primary production virtual machine (8 cores, 32GB RAM) executing Space stack", riskLevel: "Production", protocol: "KVM / QEMU" },
          { id: "pve-vm218", name: "public-host (Sync & Staging Node)", category: "Replication VM", status: "active", description: "Dedicated development and replication sync node mirroring production codebase", riskLevel: "Staging", protocol: "KVM / QEMU" },
          { id: "pve-qemu-agent", name: "QEMU Guest Agent Daemon", category: "Telemetry Bridge", status: "active", description: "Bridges VM memory stats, network interfaces, and host synchronization events", riskLevel: "R0 - Low", protocol: "VirtIO Serial" },
          { id: "pve-backup", name: "Proxmox Backup Server (PBS) Client", category: "Disaster Recovery", status: "active", description: "Automated snapshot backup client verifying VM cluster state integrity", riskLevel: "R0 - Low", protocol: "PBS Deduplication" },
        ],
      },
    ];

    const isEdgeActive = (sourceStatus: SystemTopologyNode["status"], targetStatus: SystemTopologyNode["status"]): "active" | "degraded" | "inactive" => {
      if (sourceStatus === "critical" || targetStatus === "critical" || sourceStatus === "unavailable" || targetStatus === "unavailable") {
        return "inactive";
      }
      if (sourceStatus === "warning" || targetStatus === "warning" || sourceStatus === "disabled" || targetStatus === "disabled") {
        return "degraded";
      }
      return "active";
    };

    const edges: SystemTopologyEdge[] = [
      {
        id: "edge-web-api",
        source: "client-web",
        target: "api-gateway",
        label: "WSS / HTTPS",
        protocol: "HTTP/1.1 & WebSocket",
        status: isEdgeActive("healthy", apiStatus),
        direction: "bidirectional",
        detail: "Client user interface connection",
      },
      {
        id: "edge-api-db",
        source: "api-gateway",
        target: "database",
        label: "DB Pool",
        protocol: "TCP/Database",
        status: isEdgeActive(apiStatus, dbStatus),
        direction: "bidirectional",
        detail: "Session, rooms, panes, and analytics storage",
      },
      {
        id: "edge-api-worker",
        source: "api-gateway",
        target: "temporal-worker",
        label: "Workflows",
        protocol: "gRPC",
        status: isEdgeActive(apiStatus, workerStatus),
        direction: "bidirectional",
        detail: "Temporal workflow dispatch and polling",
      },
      {
        id: "edge-api-cli",
        source: "api-gateway",
        target: "cli-hosts",
        label: "PTY Stream",
        protocol: "Unix Socket / PTY",
        status: isEdgeActive(apiStatus, cliStatus),
        direction: "bidirectional",
        detail: "Interactive shell and terminal streams",
      },
      {
        id: "edge-api-browser",
        source: "api-gateway",
        target: "browser-host",
        label: "CDP Session",
        protocol: "CDP / Unix Socket",
        status: isEdgeActive(apiStatus, browserStatus),
        direction: "bidirectional",
        detail: "Headless browser sessions and diagnostics",
      },
      {
        id: "edge-api-storage",
        source: "api-gateway",
        target: "storage",
        label: "Volume I/O",
        protocol: "POSIX FS",
        status: isEdgeActive(apiStatus, storageStatus),
        direction: "forward",
        detail: "Artifacts, backups, and user uploads",
      },
      {
        id: "edge-api-mcp",
        source: "api-gateway",
        target: "mcp-gateway",
        label: "Tool Registry",
        protocol: "JSON-RPC",
        status: isEdgeActive(apiStatus, mcpStatus),
        direction: "bidirectional",
        detail: "Tool discovery and execution dispatch",
      },
      {
        id: "edge-opencode-mcp",
        source: "opencode-harness",
        target: "mcp-gateway",
        label: "MCP Invocations",
        protocol: "JSON-RPC / stdio",
        status: isEdgeActive("healthy", mcpStatus),
        direction: "bidirectional",
        detail: "Agent tools and environment execution",
      },
      {
        id: "edge-mcp-ai",
        source: "mcp-gateway",
        target: "ai-providers",
        label: "Model API",
        protocol: "HTTPS / REST",
        status: isEdgeActive(mcpStatus, providerStatus),
        direction: "bidirectional",
        detail: "Tool-augmented LLM requests",
      },
      {
        id: "edge-api-ai",
        source: "api-gateway",
        target: "ai-providers",
        label: "LLM Streaming",
        protocol: "HTTPS / SSE",
        status: isEdgeActive(apiStatus, providerStatus),
        direction: "forward",
        detail: "Streaming chat and completions",
      },
      {
        id: "edge-api-infra",
        source: "api-gateway",
        target: "proxmox-infra",
        label: "Cluster Telemetry",
        protocol: "PVE API / SSH",
        status: "active",
        direction: "forward",
        detail: "Host node telemetry and replication",
      },
    ];

    const summary = {
      totalNodes: nodes.length,
      healthyNodes: nodes.filter((n) => n.status === "healthy").length,
      warningNodes: nodes.filter((n) => n.status === "warning").length,
      criticalNodes: nodes.filter((n) => n.status === "critical" || n.status === "unavailable").length,
      activeEdges: edges.filter((e) => e.status === "active").length,
    };

    return {
      sampledAt: health.sampledAt,
      nodes,
      edges,
      summary,
    };
  }
}
