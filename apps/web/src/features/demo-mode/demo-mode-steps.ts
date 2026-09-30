export interface DemoModeStep {
  id: string;
  stepNumber: number;
  totalSteps: number;
  title: string;
  subtitle: string;
  badge: string;
  description: string;
  features: string[];
  targetSelector: string;
  placement?: "top" | "bottom" | "left" | "right" | "center";
  actionLabel?: string;
  actionId?: string;
}

export const DEMO_MODE_STEPS: DemoModeStep[] = [
  {
    id: "welcome",
    stepNumber: 1,
    totalSteps: 10,
    title: "Space App Operating System",
    subtitle: "Autonomous Multi-Agent AI Platform",
    badge: "Core Architecture",
    description: "Welcome to Space App! A purpose-built, web-native operating environment for human-AI pairing, autonomous coding swarms, and distributed server execution.",
    features: [
      "Multi-agent orchestration with dedicated, isolated runtimes",
      "Persistent sessions surviving browser reloads and reboots",
      "Secure zero-credential-exposure server integration"
    ],
    targetSelector: ".brand-lockup, .board-toolbar-title, nav.desktop-navigation",
    placement: "bottom",
    actionLabel: "Next Feature",
  },
  {
    id: "rooms",
    stepNumber: 2,
    totalSteps: 10,
    title: "Spatial Rooms & Multi-Workspaces",
    subtitle: "Isolated Work Environments",
    badge: "Rooms Management",
    description: "Organize parallel tasks, independent codebases, and team projects across persistent, customizable rooms.",
    features: [
      "Instant room switching, creation, and drag-and-drop ordering",
      "Rich visual room themes: Cyberpunk, Nord, Matrix, Monokai, Minimal",
      "Dynamic multi-column layouts & category color tags for visual isolation"
    ],
    targetSelector: '[data-rail-id="docks"], [data-testid="room-strip"], .room-toolbar',
    placement: "right",
    actionLabel: "Explore Rooms",
    actionId: "surface-rooms"
  },
  {
    id: "panes",
    stepNumber: 3,
    totalSteps: 10,
    title: "The Pane Ecosystem",
    subtitle: "Specialized Work Surfaces",
    badge: "Creation Rail",
    description: "Launch and tile versatile work surfaces directly inside any room, tailored for coding, research, execution, and real-time review.",
    features: [
      "AI Terminal CLI panes with full PTY, virtual keyboard & shortcuts",
      "AI Chat panes for conversational prompt engineering",
      "Embedded Browser, YouTube tutorial player, VNC Remote Desktop, and Live Voice Audio"
    ],
    targetSelector: '[data-rail-id="create"]',
    placement: "right",
    actionLabel: "View Create Options",
    actionId: "create-menu"
  },
  {
    id: "agents",
    stepNumber: 4,
    totalSteps: 10,
    title: "Multi-Engine AI Coding Agents",
    subtitle: "Codex, Claude, Gemini, Qwen & Reasonix",
    badge: "Autonomous Agents",
    description: "Run any leading coding assistant side-by-side with full native shell access, background task resilience, and hierarchical subagents.",
    features: [
      "Plug-and-play support for Codex, Claude Code, Gemini CLI, Qwen, Kimi, and DeepSeek",
      "Detached background execution with seamless reconnect & resume",
      "Real-time streaming, tool-call inspection, and floating controls"
    ],
    targetSelector: '.terminal-pane, .board-panes, .chat-pane, [data-rail-id="create"]',
    placement: "bottom",
    actionLabel: "Explore Agents",
    actionId: "surface-agent-sessions"
  },
  {
    id: "docks",
    stepNumber: 5,
    totalSteps: 10,
    title: "Collaborative Docks & Work Surfaces",
    subtitle: "Context & Artifact Management",
    badge: "Side Docks",
    description: "Slide-out side docks keep your shared context, artifacts, and tools neatly organized without cluttering active code panes.",
    features: [
      "Shared Chat & Media Gallery with direct screen clip sharing",
      "Agent Files dock for reviewed deliverables and persistent downloads",
      "Private Clipboard for operator notes, plans, and copy/paste history",
      "Tasks dock for tracking long-running asynchronous jobs"
    ],
    targetSelector: '[data-rail-id="docks"]',
    placement: "right",
    actionLabel: "Open Docks",
    actionId: "surface-clipboard"
  },
  {
    id: "memory",
    stepNumber: 6,
    totalSteps: 10,
    title: "Unified Memory Workspace",
    subtitle: "Cross-Session Knowledge & Recall",
    badge: "Long-Term Memory",
    description: "A persistent memory graph that retains facts, user preferences, project knowledge, and architectural decisions across sessions.",
    features: [
      "Semantic knowledge graph search and real-time fact indexing",
      "Bounded memory recall engine for instant, low-latency fact lookup",
      "Automatic cross-agent knowledge propagation and context injection"
    ],
    targetSelector: 'button[aria-label*="memory" i], [data-action-id="memory-workspace"], [data-rail-id="tools"]',
    placement: "bottom",
    actionLabel: "Open Memory",
    actionId: "memory-workspace"
  },
  {
    id: "admin-telemetry",
    stepNumber: 7,
    totalSteps: 10,
    title: "Admin Suite & System Telemetry",
    subtitle: "Real-time Host & Model Inspection",
    badge: "Admin Tools",
    description: "Comprehensive enterprise monitoring and operational control over host resources, systemd services, and AI model performance.",
    features: [
      "Live CPU, RAM, disk, and detached CLI session telemetry",
      "Model latency tracking, token usage breakdown, and cost analytics",
      "Full systemd unit management and background worker supervision"
    ],
    targetSelector: '[data-rail-id="tools"]',
    placement: "right",
    actionLabel: "Open Resources",
    actionId: "system-resources"
  },
  {
    id: "benchmark",
    stepNumber: 8,
    totalSteps: 10,
    title: "Asteroids AI Championship",
    subtitle: "Headless Agent Benchmarking",
    badge: "AI Benchmarks",
    description: "An automated real-time benchmark testing model decision speed, precision, and tool-use under simulated stress in an Asteroids simulation.",
    features: [
      "Headless browser gameplay with live scoreboards and frame telemetry",
      "Direct head-to-head comparison across all free and paid models",
      "Latency, token efficiency, and error-recovery ranking"
    ],
    targetSelector: 'button[aria-label*="benchmark" i], [data-rail-id="tools"]',
    placement: "bottom",
    actionLabel: "Launch Benchmark",
    actionId: "benchmark"
  },
  {
    id: "productivity",
    stepNumber: 9,
    totalSteps: 10,
    title: "Productivity & Security Utilities",
    subtitle: "Everyday Operator Enhancements",
    badge: "Utilities",
    description: "Essential utilities built directly into the workspace chrome for privacy, focus, and rapid interaction.",
    features: [
      "Vibe Music with freeCodeCamp Code Radio integration",
      "Sensitive Data Masking for blurring IPs, emails, and credentials on screen",
      "Dynamic VPN Egress City rotation (NordVPN/Mullvad)",
      "On-Screen Virtual Keyboard and Workspace Text Scaling"
    ],
    targetSelector: '.board-toolbar-actions, [data-rail-id="tools"]',
    placement: "top",
    actionLabel: "Toggle Music",
    actionId: "vibe-music"
  },
  {
    id: "server-ops",
    stepNumber: 10,
    totalSteps: 10,
    title: "Guarded Operations & Resilience",
    subtitle: "High Availability & Safe Maintenance",
    badge: "Guarded Operations",
    description: "Enterprise-grade guarded procedures ensure upgrades and reboots never kill active user terminals or lose uncommitted work.",
    features: [
      "Guarded server restarts with process-preserving proxies",
      "Automated Proxmox DR backup status verification",
      "Privileged host-root admin terminal with full auditing"
    ],
    targetSelector: 'button[aria-label*="Admin" i], [data-rail-id="tools"]',
    placement: "top",
    actionLabel: "Finish Tour",
  }
];
