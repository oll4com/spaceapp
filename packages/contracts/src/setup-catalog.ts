import publicAgentChecks from "./public-setup-agent-checks.json" with { type: "json" };

import { CLI_PANE_TYPES } from "./pane-catalog.js";

/** First-run choices are independent of the host resource profile. */
/** Shared with the public native verifier; a saved login alone cannot support automatic setup. */
export const PUBLIC_SETUP_NATIVE_AGENTS: readonly string[] = Object.freeze([...publicAgentChecks.nativeAgents]);
export const SETUP_CATALOG_VERSION = "first-setup-v2.0";
export type SetupPersona = "everyday" | "creator" | "developer";
export type SetupLevel = "minimal" | "balanced" | "full";
export type SetupFeatureKind = "agent" | "dock" | "pane" | "widget" | "utility";
export type SetupFeatureId = `${SetupFeatureKind}:${string}`;
export type SetupAvailability = "AVAILABLE" | "INSTALLABLE" | "UNAVAILABLE" | "FORBIDDEN";
export type SetupCostClass = "FREE" | "PROVIDER_BILLED" | "LOCAL_RESOURCES" | "UNKNOWN";
export type SetupReadinessCheckId =
  | "AGENT_TASK" | "AUTHORIZED_SERVICE" | "BROWSER_RUNTIME" | "FILE_SERVICE"
  | "DATABASE_CONNECTION" | "DEMO_RUNTIME" | "VIDEO_PLAYER" | "REMOTE_DESKTOP"
  | "LIVE_DUPLEX" | "HARNESS_RUNTIME" | "STREAMING_DESTINATION" | "WIDGET_FUNCTION"
  | "LOCAL_GIT" | "CAPTURE_PERMISSION" | "GAME_RUNTIME" | "OSK_RUNTIME" | "SYSTEM_HEALTH";

export interface SetupFeature {
  readonly id: SetupFeatureId;
  readonly kind: SetupFeatureKind;
  readonly label: string;
  readonly description: string;
  readonly details: string;
  readonly audiences: readonly SetupPersona[];
  readonly requiredForFirstSetup: boolean;
  readonly dependencies: readonly SetupFeatureId[];
  /** Resolved on the server from real platform/permissions, never inferred from this static catalog. */
  readonly availabilityRuleId: string;
  readonly settingsBinding: { readonly kind: "dock" | "pane" | "widget" | "agent"; readonly id: string } | null;
  readonly connectionRequirements: readonly string[];
  readonly readinessCheckId: SetupReadinessCheckId;
  readonly dataUse: string;
  readonly costClass: SetupCostClass;
}

export interface SetupResolution {
  readonly requestedIds: SetupFeatureId[];
  readonly effectiveIds: SetupFeatureId[];
  readonly dependencyIds: SetupFeatureId[];
  readonly issues: { featureId: SetupFeatureId; reason: "UNAVAILABLE" | "FORBIDDEN" }[];
}

const allAudiences: readonly SetupPersona[] = ["everyday", "creator", "developer"];

function feature(
  id: SetupFeatureId,
  label: string,
  description: string,
  details: string,
  readinessCheckId: SetupReadinessCheckId,
  options: {
    dependencies?: SetupFeatureId[];
    required?: boolean;
    rule?: string;
    connections?: string[];
    dataUse?: string;
    cost?: SetupCostClass;
    audiences?: SetupPersona[];
    binding?: SetupFeature["settingsBinding"];
  } = {}
): SetupFeature {
  const [kind, rawId] = id.split(":", 2) as [SetupFeatureKind, string];
  return Object.freeze({
    id, kind, label, description, details,
    audiences: options.audiences ?? allAudiences,
    requiredForFirstSetup: options.required ?? false,
    dependencies: options.dependencies ?? [],
    availabilityRuleId: options.rule ?? `${kind}:${rawId}`,
    settingsBinding: options.binding === undefined
      ? kind === "utility" ? null : { kind, id: kind === "agent" ? `cli:${rawId}` : rawId }
      : options.binding,
    connectionRequirements: options.connections ?? [],
    readinessCheckId,
    dataUse: options.dataUse ?? "Uses your Space workspace and its existing access rules.",
    costClass: options.cost ?? "FREE"
  });
}

const agents: SetupFeature[] = CLI_PANE_TYPES.map((cli) => feature(
  `agent:${cli.typeId}`,
  cli.shortLabel,
  cli.typeId === "opencode" ? "Your first free coding assistant." : `An optional ${cli.shortLabel} coding assistant.`,
  cli.typeId === "opencode"
    ? "The installer prepares OpenCode first. Auto picks a tested, account-free model and never switches to paid use."
    : `Install the supported ${cli.shortLabel} adapter and connect with a method that adapter actually supports. Provider access and charges may vary.`,
  "AGENT_TASK",
  {
    required: cli.typeId === "opencode",
    rule: `agent-runtime:${cli.typeId}`,
    connections: cli.typeId === "opencode" ? [] : [`agent:${cli.typeId}`],
    cost: cli.typeId === "opencode" ? "FREE" : "UNKNOWN",
    dataUse: "The selected model receives the task content allowed by its provider and room permissions."
  }
));

const workspace: SetupFeature[] = [
  feature("pane:chat", "Chat", "Ask your first assistant in a conversation.", "Starts with the tested free OpenCode connection; no second provider account is needed.", "AGENT_TASK", { required: true, dependencies: ["agent:opencode"] }),
  feature("dock:rooms", "Rooms", "Keep different projects in separate spaces.", "Switch between existing rooms without changing their protected warm behavior.", "AUTHORIZED_SERVICE", { required: true }),
  feature("dock:tasks", "Tasks", "Follow your assistants' tasks and progress.", "View running and completed agent work from your Space account.", "AUTHORIZED_SERVICE", { required: true }),
  feature("dock:agent-files", "Agent Files", "Find documents and images created by assistants.", "Preview, organize and download permitted files through Space storage.", "AUTHORIZED_SERVICE", { required: true }),
  feature("dock:settings", "Settings", "Adjust your Space later.", "Manage your appearance, connections, privacy and workspace tools. This dock cannot be hidden.", "AUTHORIZED_SERVICE", { required: true }),
  feature("pane:browser", "Browser", "Browse beside your work.", "Open supported websites in a managed browser; individual sites may ask for their own login.", "BROWSER_RUNTIME", { rule: "browser-host" }),
  feature("dock:clipboard", "Clipboard", "Keep useful text and plans.", "Save and reuse notes through your Space account; browser clipboard access follows browser permissions.", "AUTHORIZED_SERVICE"),
  feature("dock:links", "Links", "Keep websites and references together.", "Save and reopen links related to your work without a separate account.", "AUTHORIZED_SERVICE"),
  feature("dock:agent-sessions", "Sessions", "Return to supported assistant sessions.", "Review or resume sessions only when their agent adapter supports it.", "AUTHORIZED_SERVICE"),
  feature("widget:clock", "Clock", "See the time in your workspace.", "Use your selected timezone; no provider or background account is required.", "WIDGET_FUNCTION"),
  feature("widget:countdown-timer", "Timer", "Run a focus countdown.", "Start, pause and reset a local countdown. Sound follows browser playback permissions.", "WIDGET_FUNCTION"),
  feature("dock:media", "Media", "Preview images and recordings.", "Use the existing Media dock for supported audio, video and image files.", "AUTHORIZED_SERVICE", { rule: "media-service" }),
  feature("pane:youtube", "YouTube", "Watch reference videos beside your work.", "Basic supported playback needs internet but no YouTube API key.", "VIDEO_PLAYER", { rule: "youtube-pane", dataUse: "Playback follows the publisher and video platform's own data policy." }),
  feature("utility:snip", "Screen capture", "Capture and annotate a screen area.", "The existing Snip Tool captures only after an explicit action and any needed OS/browser permission.", "CAPTURE_PERMISSION", { rule: "snip-tool", dataUse: "Only the screen area you choose is captured." }),
  feature("pane:files", "File Manager", "Browse permitted project files.", "Inspect, upload and organize files within authorized roots. Off by default for Everyday Minimal/Balanced.", "FILE_SERVICE", { rule: "filebrowser-service", dataUse: "Reads files you open within permitted roots." }),
  feature("pane:demos", "Demo Projects", "Try supported development examples.", "Run the built-in sample projects on a compatible local project runtime.", "DEMO_RUNTIME", { rule: "demo-runtime", cost: "LOCAL_RESOURCES" }),
  feature("dock:source-control", "Git & source control", "Review project changes.", "Inspect local Git and worktrees; private remote repositories need separately scoped authorization.", "LOCAL_GIT", { rule: "git-plugin", dataUse: "Reads the selected repository's Git metadata." }),
  feature("dock:cli", "CLI tools", "Manage your chosen coding agents.", "This dock shows available CLI tools; enabling it does not install or select every agent.", "AUTHORIZED_SERVICE"),
  feature("utility:worktrees", "Worktrees", "Work safely in isolated project copies.", "Create and manage authorized local Git worktrees using existing lifecycle rules.", "LOCAL_GIT", { rule: "worktrees-runtime", dependencies: ["dock:source-control"], dataUse: "Reads and writes only authorized Git workspaces." }),
  feature("dock:room-agent", "Room Agent", "Coordinate supported work in a room.", "Uses only the current actor's granted tool scopes and a selected compatible assistant.", "AGENT_TASK", { dependencies: ["agent:opencode"] }),
  feature("dock:shared-chat", "Shared Chat", "Discuss a room with invited members.", "Selecting this dock does not invite or message anyone.", "AUTHORIZED_SERVICE", { rule: "shared-chat-service" }),
  feature("dock:streaming", "Streaming", "Manage an authorized broadcast.", "An administrator connects a supported streaming destination and its scoped credentials. Provider charges may apply.", "STREAMING_DESTINATION", { rule: "admin-streaming", connections: ["streaming-destination"], cost: "UNKNOWN", dataUse: "Shares the broadcast with the chosen destination." }),
  feature("pane:databases", "Databases", "Inspect a connected database.", "Connect a supported database with scoped credentials before browsing tables or querying. Off by default for Everyday Minimal/Balanced.", "DATABASE_CONNECTION", { rule: "database-connector", connections: ["database-target"], dataUse: "Queries only the database connection you authorize." }),
  feature("pane:vnc", "Remote Desktop", "View an authorized remote desktop.", "A configured target and its scoped access credentials are required; setup does not create a remote machine.", "REMOTE_DESKTOP", { rule: "vnc-runtime", connections: ["vnc-target"], dataUse: "Receives pixels and sends your input to the selected remote desktop." }),
  feature("pane:live", "Live audio", "Talk with an assistant by voice.", "Choose one supported provider, connect it and complete a real microphone/playback check. Cloud providers may bill usage.", "LIVE_DUPLEX", { rule: "live-provider", connections: ["live-provider", "microphone"], cost: "PROVIDER_BILLED", dataUse: "Audio goes to the provider you explicitly choose." }),
  feature("pane:harness", "Harness", "Inspect a compatible agent runtime.", "Requires an authorized, reachable Harness runtime and a completed bounded check.", "HARNESS_RUNTIME", { rule: "harness-runtime", connections: ["harness-target"], dataUse: "Reads events from the authorized runtime." }),
  feature("widget:pushup-reminder", "Movement reminder", "Take regular movement breaks.", "Local in-app reminders need no account; system notifications are requested only if enabled.", "WIDGET_FUNCTION"),
  feature("widget:spaceapp-promo", "SpaceApp news", "Discover SpaceApp updates.", "The existing widget does not subscribe you to email or system notifications.", "WIDGET_FUNCTION"),
  feature("widget:ai-quota", "AI quota", "See reported provider limits.", "Unknown quotas are shown as unknown, never as zero or guaranteed balances.", "WIDGET_FUNCTION", { rule: "quota-data" }),
  feature("widget:streaming-metrics", "Streaming metrics", "Watch an authorized broadcast status.", "Requires the Streaming dock and a healthy metrics source.", "WIDGET_FUNCTION", { dependencies: ["dock:streaming"], rule: "streaming-metrics" }),
  feature("utility:asteroids", "Asteroids", "Take a short arcade break.", "Show the existing arcade experience only where the pane runtime exposes it.", "GAME_RUNTIME", { rule: "asteroids-runtime" }),
  feature("utility:osk", "On-screen keyboard", "Use a touch keyboard.", "Available only where the client exposes its existing touch keyboard.", "OSK_RUNTIME", { rule: "touch-keyboard" }),
  feature("utility:system-health", "System health", "View local runtime health.", "Shows supported CPU, memory and service metrics through existing read-only APIs.", "SYSTEM_HEALTH", { rule: "system-health-service" })
];

export const SETUP_CATALOG: readonly SetupFeature[] = Object.freeze([...agents, ...workspace]);

function catalogIndex(catalog: readonly SetupFeature[]) {
  const byId = new Map<SetupFeatureId, SetupFeature>();
  for (const entry of catalog) {
    if (byId.has(entry.id)) throw new Error(`Duplicate setup feature: ${entry.id}`);
    byId.set(entry.id, entry);
  }
  return byId;
}

export function resolveSetupSelection(
  requestedIds: readonly SetupFeatureId[],
  availability: Partial<Record<SetupFeatureId, SetupAvailability>>,
  catalog: readonly SetupFeature[] = SETUP_CATALOG
): SetupResolution {
  const byId = catalogIndex(catalog);
  for (const id of requestedIds) if (!byId.has(id)) throw new Error(`Unknown setup feature: ${id}`);
  const requested = new Set(requestedIds);
  const effective = new Set<SetupFeatureId>();
  const issueMap = new Map<SetupFeatureId, "UNAVAILABLE" | "FORBIDDEN">();
  const visiting = new Set<SetupFeatureId>();
  const visited = new Map<SetupFeatureId, boolean>();
  function visit(id: SetupFeatureId): boolean {
    if (visiting.has(id)) throw new Error(`Setup dependency cycle at ${id}`);
    const previous = visited.get(id);
    if (previous !== undefined) return previous;
    const entry = byId.get(id);
    if (!entry) throw new Error(`Unknown setup dependency: ${id}`);
    const current = availability[id] ?? "UNAVAILABLE";
    if (current === "UNAVAILABLE" || current === "FORBIDDEN") {
      issueMap.set(id, current);
      visited.set(id, false);
      return false;
    }
    visiting.add(id);
    let ready = true;
    for (const dependency of entry.dependencies) {
      if (!visit(dependency)) ready = false;
    }
    visiting.delete(id);
    if (ready) effective.add(id);
    visited.set(id, ready);
    return ready;
  }
  for (const entry of catalog) if (requested.has(entry.id)) visit(entry.id);
  const ordered = catalog.map((entry) => entry.id);
  return {
    requestedIds: ordered.filter((id) => requested.has(id)),
    effectiveIds: ordered.filter((id) => effective.has(id)),
    dependencyIds: ordered.filter((id) => effective.has(id) && !requested.has(id)),
    issues: ordered.filter((id) => issueMap.has(id)).map((id) => ({ featureId: id, reason: issueMap.get(id)! }))
  };
}

/** Structural selection only. Runtime availability and authorization are still resolved at plan/start/finish. */
export function getSetupDependencyClosure(requestedIds: readonly SetupFeatureId[]): SetupFeatureId[] {
  const structuralAvailability = Object.fromEntries(SETUP_CATALOG.map(entry => [entry.id, "AVAILABLE"])) as Record<SetupFeatureId, SetupAvailability>;
  return resolveSetupSelection(requestedIds, structuralAvailability).effectiveIds;
}

/** Remove the requested feature and all requested entries that transitively require it. */
export function removeSetupFeature(requestedIds: readonly SetupFeatureId[], featureId: SetupFeatureId): SetupFeatureId[] {
  return requestedIds.filter(id => !getSetupDependencyClosure([id]).includes(featureId));
}

const essentials: SetupFeatureId[] = ["agent:opencode", "pane:chat", "dock:rooms", "dock:tasks", "dock:agent-files", "dock:settings"];
const balanced: SetupFeatureId[] = ["pane:browser", "dock:clipboard", "dock:links", "dock:agent-sessions", "widget:clock", "widget:countdown-timer"];
const creator: SetupFeatureId[] = ["dock:media", "pane:youtube", "utility:snip"];
const developer: SetupFeatureId[] = ["pane:files", "pane:demos", "dock:source-control", "dock:cli", "utility:worktrees"];

export function buildSetupSelection(
  persona: SetupPersona,
  level: SetupLevel,
  availability: Partial<Record<SetupFeatureId, SetupAvailability>>,
  selectedAgents: readonly SetupFeatureId[]
): SetupResolution {
  if (!(["everyday", "creator", "developer"] as const).includes(persona)) throw new Error(`Unknown setup persona: ${persona}`);
  if (!(["minimal", "balanced", "full"] as const).includes(level)) throw new Error(`Unknown setup level: ${level}`);
  const requested = new Set<SetupFeatureId>(essentials);
  const eligible = (id: SetupFeatureId) => availability[id] === "AVAILABLE" || availability[id] === "INSTALLABLE";
  if (level === "balanced") {
    for (const id of [...balanced, ...(persona === "creator" ? creator : persona === "developer" ? developer : [])]) {
      if (eligible(id)) requested.add(id);
    }
  }
  if (level === "full") {
    for (const entry of SETUP_CATALOG) if (entry.kind !== "agent" && eligible(entry.id)) requested.add(entry.id);
  }
  const byId = catalogIndex(SETUP_CATALOG);
  for (const id of selectedAgents) {
    const entry = byId.get(id);
    if (!entry || entry.kind !== "agent") throw new Error(`Unknown setup agent: ${id}`);
    requested.add(id);
  }
  return resolveSetupSelection([...requested], availability);
}
