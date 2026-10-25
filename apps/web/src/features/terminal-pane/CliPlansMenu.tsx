import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ClipboardItem, TaskMetadata, ManagedPlanExecution, PaneCliModelSettings, StageModelSelection } from "@space/contracts";
import { api } from "../../api.js";
import { getSpaceRuntime } from "../../runtime/SpaceRuntime.js";
import {
  Activity,
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronLeft,
  ClipboardList,
  Clock3,
  ExternalLink,
  ListFilter,
  Loader2,
  RotateCw,
  Search,
  Sparkles,
  X
} from "../ui-theme/app-icons.js";
import { SPACE_CLIPBOARD_UPDATED_EVENT } from "../clipboard-dock/clipboard-events.js";
import { canOpenPlanPane, openPlanPane, planAssignee, useRoomNames } from "../clipboard-dock/plan-assignee.js";
import { shouldPreserveForSnipTool } from "../snip-tool/snip-guard.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import { ManagedPlanProgress } from "./ManagedPlanProgress.js";
import { isSameModel, resolveStepModel } from "./plan-model-resolver.js";

export interface CliPlansMenuPaneContext {
  id: string;
  title?: string;
  paneName?: string | null;
  roomId?: string | null;
  modelId?: string | null;
  reasoningEffort?: string | null;
  taskMetadata?: TaskMetadata | null;
  cwd?: string | null;
  isMaximized?: boolean;
  isMinimized?: boolean;
}

export interface CliPlansMenuProps {
  pane?: CliPlansMenuPaneContext | null;
  disabled?: boolean;
  active: boolean;
  onSelectPlan: (plan: ClipboardItem) => void;
  // Puts the plan into the CLI prompt without submitting it; the preview hides the action when absent.
  onInsertPlan?: (plan: ClipboardItem) => void;
  // True when sending this plan would replace text the operator has typed but not sent.
  draftWillBeCleared?: (plan: ClipboardItem) => boolean;
  // False while no CLI is attached: plans stay viewable, sending and inserting wait for the CLI.
  canSend?: boolean;
  managedExecution?: ManagedPlanExecution | null;
  managedSettings?: PaneCliModelSettings | null;
  managedError?: string | null;
  managedPending?: boolean;
  canControlManaged?: boolean;
  onManagedOverride?: (stageId: string, selection: StageModelSelection | null) => Promise<unknown>;
  onManagedControl?: (action: "pause" | "resume") => Promise<unknown>;
  onManagedRefresh?: () => Promise<unknown>;
}

interface DisplayStep {
  id: string;
  order: number;
  title: string;
  status: "PENDING" | "IN_PROGRESS" | "COMPLETED" | "BLOCKED" | "FAILED";
  progress: number;
  agent?: string | null;
  notes?: string | null;
  proof?: string | null;
  completedAt?: string | null;
  // The status is inferred from the plan's overall percentage, not reported for this stage.
  estimated?: boolean;
}

function formatPlanDate(isoString?: string | null): string {
  if (!isoString) return "";
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const isToday =
    date.getDate() === now.getDate() &&
    date.getMonth() === now.getMonth() &&
    date.getFullYear() === now.getFullYear();
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (isToday) {
    return `Today ${time}`;
  }
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${date.getDate()} ${months[date.getMonth()]} · ${time}`;
}

function formatPlanSnippet(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .join(" ")
    .slice(0, 160);
}

function resolvePlanDisplaySteps(plan: ClipboardItem): DisplayStep[] {
  if (Array.isArray(plan.steps) && plan.steps.length > 0) {
    return plan.steps.map((s, idx) => ({
      id: s.id || `step-${idx + 1}`,
      order: s.order || idx + 1,
      title: s.title,
      status: s.status,
      progress: s.progress,
      agent: s.agent,
      notes: s.notes,
      proof: s.proof,
      completedAt: s.completedAt
    }));
  }

  // Parse markdown headers or checkboxes from text if steps array is empty
  const lines = plan.text.split(/\r?\n/);
  const parsed: DisplayStep[] = [];
  let currentStep: DisplayStep | null = null;
  let order = 1;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const checkboxMatch = line.match(/^-\s*\[([ xX])\]\s*(.+)$/);
    if (checkboxMatch) {
      const isDone = checkboxMatch[1]?.toLowerCase() === "x";
      parsed.push({
        id: `chk-${order}`,
        order,
        title: checkboxMatch[2]!.replace(/\*\*/g, "").trim(),
        status: isDone ? "COMPLETED" : "PENDING",
        progress: isDone ? 100 : 0
      });
      order++;
      continue;
    }

    const headerMatch = line.match(/^#{2,4}\s+(.+)$/);
    if (headerMatch) {
      if (currentStep) {
        parsed.push(currentStep);
      }
      currentStep = {
        id: `sec-${order}`,
        order,
        title: headerMatch[1]!.replace(/\*\*/g, "").trim(),
        status: "PENDING",
        progress: 0
      };
      order++;
      continue;
    }

    const numberedMatch = line.match(/^(\d+)\.\s+(.+)$/);
    if (numberedMatch && !currentStep) {
      parsed.push({
        id: `num-${order}`,
        order,
        title: numberedMatch[2]!.replace(/\*\*/g, "").trim(),
        status: "PENDING",
        progress: 0
      });
      order++;
      continue;
    }
  }

  if (currentStep) {
    parsed.push(currentStep);
  }

  if (parsed.length > 0) {
    const total = parsed.length;
    const planProgress = plan.progressPercentage || 0;
    if (plan.executionStatus === "COMPLETED" || planProgress === 100) {
      return parsed.map((s) => ({ ...s, status: "COMPLETED", progress: 100 }));
    }
    const completedCount = Math.floor((planProgress / 100) * total);
    return parsed.map((s, idx) => {
      if (s.status === "COMPLETED") return { ...s, progress: 100 };
      if (idx < completedCount) {
        return { ...s, status: "COMPLETED", progress: 100, estimated: true };
      }
      if (idx === completedCount && planProgress > 0) {
        const stepProgress = Math.round(((planProgress % (100 / total)) / (100 / total)) * 100);
        return { ...s, status: "IN_PROGRESS", progress: stepProgress, estimated: true };
      }
      return { ...s, status: "PENDING", progress: 0 };
    });
  }

  return [];
}

function isGenericCliTitle(title?: string | null): boolean {
  if (!title) return true;
  const t = title.trim().toLowerCase();
  return (
    t.length < 4 ||
    /^(?:gemini cli|codex|opencode|qwen|hermes|cli \d+|terminal|bash|zsh|task|untitled|new session|child session)/i.test(t)
  );
}

function normalizeTitle(str?: string | null): string {
  return (str || "")
    .toLowerCase()
    .replace(/["“”'`’«»]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// linked: the server already binds the plan to this pane. explicit: the pane's task names the plan,
// so an unbound plan may be bound to it. guess: a heuristic that must never rebind anything by itself.
type ActivePlanBasis = "linked" | "explicit" | "guess";
interface ActivePlanMatch {
  plan: ClipboardItem;
  basis: ActivePlanBasis;
}

function resolveActivePlan(
  plans: ClipboardItem[],
  pane?: CliPlansMenuPaneContext | null
): ActivePlanMatch | null {
  if (!pane) return null;
  const linked = (plan: ClipboardItem): ActivePlanMatch => ({ plan, basis: "linked" });
  const explicit = (plan: ClipboardItem): ActivePlanMatch => ({ plan, basis: plan.paneId === pane.id ? "linked" : "explicit" });
  const guess = (plan: ClipboardItem): ActivePlanMatch => ({ plan, basis: plan.paneId === pane.id ? "linked" : "guess" });

  // 1. Direct match by paneId:
  const directMatch = plans.find(
    (p) => p.paneId === pane.id && !p.isCompleted && p.executionStatus !== "COMPLETED"
  );
  if (directMatch) return linked(directMatch);

  // 2. Explicit taskMetadata.planId:
  if (pane.taskMetadata?.planId) {
    const metaPlanId = pane.taskMetadata.planId.toLowerCase().replace("clipboard:", "");
    const planIdMatch = plans.find((p) => {
      if (p.isCompleted || p.executionStatus === "COMPLETED") return false;
      return p.id.toLowerCase().replace("clipboard:", "") === metaPlanId;
    });
    if (planIdMatch) return explicit(planIdMatch);
  }

  // 3. LocalStorage match:
  if (typeof window !== "undefined" && pane.id) {
    try {
      const storedId = localStorage.getItem(`space_active_plan_${pane.id}`);
      if (storedId) {
        const storedMatch = plans.find(
          (p) =>
            !p.isCompleted &&
            p.executionStatus !== "COMPLETED" &&
            (p.id === storedId ||
              p.id === `clipboard:${storedId}` ||
              p.id.replace("clipboard:", "") === storedId.replace("clipboard:", ""))
        );
        if (storedMatch) return guess(storedMatch);
      }
    } catch {}
  }

  // 4. Match via clipboard item metadata:
  const metaMatch = plans.find((p) => {
    if (p.isCompleted || p.executionStatus === "COMPLETED") return false;
    const metaPaneId = (p as { metadata?: { paneId?: string } }).metadata?.paneId;
    return Boolean(metaPaneId && metaPaneId === pane.id);
  });
  if (metaMatch) return explicit(metaMatch);

  // 5. Match via pane taskMetadata text if it explicitly references the plan ID:
  if (pane.taskMetadata) {
    const metaParts = [
      pane.taskMetadata.description,
      pane.taskMetadata.earlierWork,
      ...(pane.taskMetadata.steps ?? [])
    ].filter(Boolean);
    const metaText = metaParts.join(" ").toLowerCase();

    const taskMetaMatch = plans.find((p) => {
      if (p.isCompleted || p.executionStatus === "COMPLETED") return false;
      const idMatch =
        metaText.includes(p.id.toLowerCase()) ||
        metaText.includes(p.id.replace("clipboard:", "").toLowerCase());
      return idMatch;
    });
    if (taskMetaMatch) return explicit(taskMetaMatch);
  }

  // 6. Semantic title & taskMetadata matching:
  if (pane.taskMetadata || (pane.title && !isGenericCliTitle(pane.title))) {
    const metaParts = [
      pane.taskMetadata?.description,
      pane.taskMetadata?.earlierWork,
      ...(pane.taskMetadata?.steps ?? [])
    ].filter(Boolean);
    const normMetaText = normalizeTitle(metaParts.join(" "));
    const normPaneTitle = normalizeTitle(pane.title);
    const hasSpecificTitle = !isGenericCliTitle(pane.title);

    const uncompletedPlans = plans.filter((p) => !p.isCompleted && p.executionStatus !== "COMPLETED");

    let bestCandidate: ClipboardItem | null = null;
    let highestScore = 0;

    for (const p of uncompletedPlans) {
      const normPlanTitle = normalizeTitle(p.title);
      if (!normPlanTitle || normPlanTitle.length < 6) continue;

      let score = 0;

      // Exact plan title in task description/meta text (e.g. Andy description has "spaceapp first setup — implementation + 3-vm acceptance")
      if (normMetaText.length > 0 && normMetaText.includes(normPlanTitle)) {
        score = 100 + normPlanTitle.length;
      } else {
        // Check prefix before separator:
        const planPrefix = normPlanTitle.split(/\s*[-—:]\s*/)[0]?.trim();
        if (planPrefix && planPrefix.length >= 8) {
          if (hasSpecificTitle && normPaneTitle === planPrefix) {
            score = 80 + planPrefix.length;
          } else if (normMetaText.includes(planPrefix) && hasSpecificTitle && (normPlanTitle.startsWith(normPaneTitle) || normPaneTitle.startsWith(planPrefix))) {
            score = 60 + planPrefix.length;
          }
        } else if (hasSpecificTitle && normPaneTitle.length >= 8 && normPlanTitle === normPaneTitle) {
          score = 70;
        }
      }

      if (score > highestScore) {
        highestScore = score;
        bestCandidate = p;
      } else if (score > 0 && score === highestScore && bestCandidate) {
        const timeA = new Date(p.lastProgressAt || p.lastUsedAt || p.createdAt || 0).getTime();
        const timeB = new Date(bestCandidate.lastProgressAt || bestCandidate.lastUsedAt || bestCandidate.createdAt || 0).getTime();
        if (timeA > timeB) {
          bestCandidate = p;
        }
      }
    }

    if (bestCandidate && highestScore >= 50) {
      return guess(bestCandidate);
    }
  }

  // 7. Match by CWD / Worktree: only for isolated worktree slugs (wt-...), never generic roots
  if (pane.cwd) {
    const rawCwd = pane.cwd.trim().toLowerCase();
    const worktreeSlug = rawCwd.split("/").pop();
    if (worktreeSlug && worktreeSlug.startsWith("wt-") && worktreeSlug.length > 5) {
      const cwdMatch = plans.find((p) => {
        if (p.isCompleted || p.executionStatus === "COMPLETED") return false;
        const textLower = (p.text || "").toLowerCase();
        const titleLower = (p.title || "").toLowerCase();
        return textLower.includes(worktreeSlug) || titleLower.includes(worktreeSlug);
      });
      if (cwdMatch) return guess(cwdMatch);
    }
  }

  return null;
}

// Every CLI pane mounts its own plans menu. They share one in-flight or recently
// settled read of the open PLAN list, so N panes cost one request. Explicit refreshes
// and clipboard updates start a new read that the other menus then join.
const OPEN_PLANS_CACHE_TTL_MS = 3_000;

interface OpenPlansRequest {
  promise: Promise<ClipboardItem[]>;
  settledAt: number | null;
}

let openPlansRequest: OpenPlansRequest | null = null;
let lastOpenPlansInvalidation: Event | null = null;
let mountedPlansMenus = 0;

const OPEN_PLANS_PAGE_SIZE = 100;
const OPEN_PLANS_MAX_PAGES = 5;

async function readOpenPlans(): Promise<ClipboardItem[]> {
  const items: ClipboardItem[] = [];
  for (let page = 1; page <= OPEN_PLANS_MAX_PAGES; page += 1) {
    const response = await api.clipboardItems({
      source: "PLAN",
      includeCompleted: false,
      page,
      pageSize: OPEN_PLANS_PAGE_SIZE
    });
    items.push(...(response?.data ?? []));
    if (page >= (response?.pagination?.totalPages ?? 1)) break;
  }
  const openPlans = items.filter(
    (item) => !item.isCompleted && item.executionStatus !== "COMPLETED"
  );
  // Newest to oldest
  openPlans.sort((a, b) => {
    const timeA = new Date(a.createdAt || a.lastUsedAt || 0).getTime();
    const timeB = new Date(b.createdAt || b.lastUsedAt || 0).getTime();
    return timeB - timeA;
  });
  return openPlans;
}

function requestOpenPlans(fresh: boolean): Promise<ClipboardItem[]> {
  const cached = openPlansRequest;
  if (!fresh && cached && (cached.settledAt === null || Date.now() - cached.settledAt < OPEN_PLANS_CACHE_TTL_MS)) {
    return cached.promise;
  }
  const request: OpenPlansRequest = {
    settledAt: null,
    promise: readOpenPlans().then(
      (plans) => {
        request.settledAt = Date.now();
        return plans;
      },
      (error: unknown) => {
        // Failures are never cached.
        if (openPlansRequest === request) openPlansRequest = null;
        throw error;
      }
    )
  };
  openPlansRequest = request;
  return request.promise;
}

function invalidateOpenPlans(event: Event) {
  // Every mounted menu receives the same event; only the first one drops the cache.
  if (event === lastOpenPlansInvalidation) return;
  lastOpenPlansInvalidation = event;
  openPlansRequest = null;
}

export function CliPlansMenu({
  pane,
  disabled = false,
  active,
  onSelectPlan,
  onInsertPlan,
  draftWillBeCleared,
  canSend = true,
  managedExecution = null, managedSettings = null, managedError = null, managedPending = false,
  canControlManaged = false, onManagedOverride, onManagedControl, onManagedRefresh
}: CliPlansMenuProps) {
  const id = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [plans, setPlans] = useState<ClipboardItem[]>([]);
  const [plansLoaded, setPlansLoaded] = useState(false);
  const [completedPanePlan, setCompletedPanePlan] = useState<ClipboardItem | null>(null);
  const [loading, setLoading] = useState(false);
  const loadSequenceRef = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [position, setPosition] = useState<{
    right: number;
    bottom: number;
    maxHeight: number;
    maxWidth: number;
    width: number;
  } | null>(null);
  const [userViewMode, setUserViewMode] = useState<"active_plan" | "all_plans" | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "in_progress" | "not_in_progress">("all");
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const modelDropdownRef = useRef<HTMLDivElement>(null);
  const [expandedStepIds, setExpandedStepIds] = useState<Record<string, boolean>>({});
  const [themeContext, setThemeContext] = useState<{
    uiTheme?: string;
    interfaceTheme?: string;
    roomTheme?: string;
    colorMode?: string;
  }>({});

  const resetFilters = useCallback(() => {
    setSearchQuery("");
    setStatusFilter("all");
    setSelectedModels([]);
    setModelDropdownOpen(false);
  }, []);

  const open = Boolean(position && active && !disabled);

  // Room names for the plans' "Linked to" line, read each time the list opens.
  const roomNames = useRoomNames(open);

  const loadPlans = useCallback(async (fresh = false) => {
    if (typeof api?.clipboardItems !== "function") {
      return;
    }
    // Only the latest load may publish, so an older shared read cannot overwrite a refresh.
    const sequence = ++loadSequenceRef.current;
    setLoading(true);
    setError(null);
    try {
      const openPlans = await requestOpenPlans(fresh);
      if (sequence === loadSequenceRef.current) {
        setPlans(openPlans);
        setPlansLoaded(true);
      }
    } catch (err) {
      if (sequence === loadSequenceRef.current) setError(err instanceof Error ? err.message : "Failed to load open plans.");
    } finally {
      if (sequence === loadSequenceRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedPlansMenus += 1;
    return () => {
      mountedPlansMenus -= 1;
      // With no menu left to share it, the next mount starts from a fresh read.
      if (mountedPlansMenus === 0) openPlansRequest = null;
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    void loadPlans();
    const handleClipboardUpdated = (event: Event) => {
      invalidateOpenPlans(event);
      void loadPlans();
    };
    window.addEventListener(SPACE_CLIPBOARD_UPDATED_EVENT, handleClipboardUpdated);
    return () => {
      window.removeEventListener(SPACE_CLIPBOARD_UPDATED_EVENT, handleClipboardUpdated);
    };
  }, [active, loadPlans]);

  useEffect(() => {
    if (!active || disabled) {
      setPosition(null);
      setUserViewMode(null);
      resetFilters();
    }
  }, [active, disabled, resetFilters]);

  // Keyed on opening only: toggling the model filter must not reload plans or move focus.
  useEffect(() => {
    if (!open) return;
    void loadPlans();
    panelRef.current?.querySelector("button")?.focus();
  }, [open, loadPlans]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (shouldPreserveForSnipTool(event)) return;
      if (
        event.target instanceof Node &&
        !panelRef.current?.contains(event.target) &&
        !buttonRef.current?.contains(event.target)
      ) {
        setPosition(null);
        setUserViewMode(null);
        resetFilters();
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (modelDropdownOpen) {
        setModelDropdownOpen(false);
        return;
      }
      setPosition(null);
      setUserViewMode(null);
      resetFilters();
      buttonRef.current?.focus();
    };
    const close = () => {
      setPosition(null);
      setUserViewMode(null);
      resetFilters();
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape, true);
      window.removeEventListener("resize", close);
    };
  }, [open, resetFilters, modelDropdownOpen]);

  useEffect(() => {
    if (!modelDropdownOpen) return;
    const handleOutsideModelDropdown = (e: MouseEvent | PointerEvent) => {
      if (
        modelDropdownRef.current &&
        !modelDropdownRef.current.contains(e.target as Node)
      ) {
        setModelDropdownOpen(false);
      }
    };
    document.addEventListener("pointerdown", handleOutsideModelDropdown, true);
    return () => {
      document.removeEventListener("pointerdown", handleOutsideModelDropdown, true);
    };
  }, [modelDropdownOpen]);

  // Auto-dismiss if pane maximization or minimization state changes (e.g. unmaximize/restore)
  useEffect(() => {
    if (open) {
      setPosition(null);
      setUserViewMode(null);
      resetFilters();
    }
  }, [pane?.isMaximized, pane?.isMinimized, resetFilters]);

  // Observe pane element resize: if pane size changes (unmaximize/restore, layout changes, drag resize), close popover
  useEffect(() => {
    if (!open) return;
    const paneCard =
      buttonRef.current?.closest<HTMLElement>(".pane-card, [data-space-pane-id]") ||
      buttonRef.current?.closest<HTMLElement>(".terminal-pane");
    if (!paneCard || typeof ResizeObserver === "undefined") return;

    let initialCall = true;
    const observer = new ResizeObserver(() => {
      if (initialCall) {
        initialCall = false;
        return;
      }
      setPosition(null);
      setUserViewMode(null);
      resetFilters();
    });

    observer.observe(paneCard);
    return () => {
      observer.disconnect();
    };
  }, [open, resetFilters]);

  useLayoutEffect(() => {
    if (!open || !panelRef.current) return;
    const paneCard =
      buttonRef.current?.closest<HTMLElement>(".pane-card, [data-space-pane-id]") ||
      buttonRef.current?.closest<HTMLElement>(".terminal-pane");
    const minLeft = paneCard ? paneCard.getBoundingClientRect().left + 8 : 8;
    const rect = panelRef.current.getBoundingClientRect();
    if (rect.left < minLeft) {
      const overflow = minLeft - rect.left;
      setPosition((current) => {
        if (!current) return current;
        return {
          ...current,
          right: Math.max(8, current.right - overflow)
        };
      });
    }
  }, [open]);

  const activeMatch = useMemo(() => resolveActivePlan(plans, pane), [plans, pane]);
  const activePlan = activeMatch?.plan ?? null;
  // Only a plan the pane's own task names, and no other pane holds, is bound here without a click.
  const selfHealPlanId =
    activeMatch?.basis === "explicit" && !activeMatch.plan.paneId && managedExecution?.planId !== activeMatch.plan.id
      ? activeMatch.plan.id
      : null;
  const isSuggestedMatch = Boolean(activeMatch && activeMatch.basis !== "linked" && !selfHealPlanId);
  const [linkPending, setLinkPending] = useState(false);
  const [previewPlanId, setPreviewPlanId] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const previewPlan = previewPlanId ? plans.find((plan) => plan.id === previewPlanId) ?? null : null;

  useEffect(() => {
    if (!open) setPreviewPlanId(null);
  }, [open]);

  const linkPlanToPane = useCallback(async (plan: ClipboardItem) => {
    if (!pane?.id || typeof api?.updatePlanProgress !== "function") return;
    try {
      localStorage.setItem(`space_active_plan_${pane.id}`, plan.id);
    } catch {}
    await api.updatePlanProgress(plan.id, {
      paneId: pane.id,
      roomId: pane.roomId ?? undefined,
      paneTitle: pane.paneName ?? pane.title ?? undefined
    } as any);
  }, [pane?.id, pane?.roomId, pane?.paneName, pane?.title]);

  // Remember only real bindings; a heuristic guess must not become sticky for this pane.
  useEffect(() => {
    if (!activeMatch || activeMatch.basis === "guess" || !pane?.id) return;
    try {
      localStorage.setItem(`space_active_plan_${pane.id}`, activeMatch.plan.id);
    } catch {}
  }, [activeMatch, pane?.id]);

  useEffect(() => {
    if (!selfHealPlanId || !activePlan) return;
    void linkPlanToPane(activePlan).catch(() => {});
  }, [selfHealPlanId, activePlan, linkPlanToPane]);

  const linkSuggestedPlan = (plan: ClipboardItem) => {
    setLinkPending(true);
    setError(null);
    void linkPlanToPane(plan)
      .then(() => loadPlans(true))
      .catch(() => setError("The plan could not be linked to this pane. Try again."))
      .finally(() => setLinkPending(false));
  };

  const closeMenu = () => {
    setPosition(null);
    setUserViewMode(null);
    resetFilters();
  };

  const [confirmDonePlanId, setConfirmDonePlanId] = useState<string | null>(null);
  const [planActionPending, setPlanActionPending] = useState(false);
  useEffect(() => {
    setConfirmDonePlanId(null);
  }, [previewPlanId]);

  const finishPlanAction = async (action: () => Promise<unknown>, failure: string) => {
    setPlanActionPending(true);
    setError(null);
    try {
      await action();
      setPreviewPlanId(null);
      await loadPlans(true);
    } catch {
      setError(failure);
    } finally {
      setPlanActionPending(false);
    }
  };

  const markPlanDone = (plan: ClipboardItem) => {
    if (confirmDonePlanId !== plan.id) {
      setConfirmDonePlanId(plan.id);
      return;
    }
    void finishPlanAction(() => api.setClipboardItemCompleted(plan.id, true), "The plan could not be marked done. Try again.");
  };

  const detachPlan = (plan: ClipboardItem) => {
    if (pane?.id) {
      try {
        if (localStorage.getItem(`space_active_plan_${pane.id}`) === plan.id) localStorage.removeItem(`space_active_plan_${pane.id}`);
      } catch {}
    }
    void finishPlanAction(
      () => api.updatePlanProgress(plan.id, { paneId: null, roomId: null, paneTitle: null } as any),
      "The plan could not be detached from this pane. Try again."
    );
  };

  const copyPlanText = async (plan: ClipboardItem) => {
    try {
      const clipboard = getSpaceRuntime().platform.clipboard;
      if (!clipboard?.writeText) throw new Error("Clipboard unavailable");
      await clipboard.writeText(plan.text);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  // A pane keeps showing the plan it finished until another plan is attached,
  // instead of falling back to the global open-plan count.
  const paneId = pane?.id ?? null;
  const needsCompletedPanePlan = active && plansLoaded && Boolean(paneId) && !managedExecution && !activePlan;
  useEffect(() => {
    if (!needsCompletedPanePlan || !paneId || typeof api?.clipboardItems !== "function") {
      setCompletedPanePlan(null);
      return;
    }
    let cancelled = false;
    void api
      .clipboardItems({ source: "PLAN", includeCompleted: true, paneId, page: 1, pageSize: 1 })
      .then((response) => {
        if (cancelled) return;
        const latest = (response?.data ?? []).find((item) => item.paneId === paneId) ?? null;
        setCompletedPanePlan(
          latest && (latest.isCompleted || latest.executionStatus === "COMPLETED") ? latest : null
        );
      })
      .catch(() => {
        if (!cancelled) setCompletedPanePlan(null);
      });
    return () => {
      cancelled = true;
    };
  }, [needsCompletedPanePlan, paneId, plans]);

  const displayPlan = activePlan ?? completedPanePlan;
  const isDisplayPlanCompleted = !activePlan && Boolean(completedPanePlan);

  const effectiveViewMode = userViewMode ?? (managedExecution || displayPlan ? "active_plan" : "all_plans");

  const toggleOpen = () => {
    if (open) {
      setPosition(null);
      setUserViewMode(null);
      resetFilters();
      return;
    }
    const box = buttonRef.current?.getBoundingClientRect();
    if (!box) return;
    const container =
      buttonRef.current?.closest(".terminal-floating-controls, .codex-composer-toolbar") ??
      buttonRef.current;
    const anchorBox = container ? container.getBoundingClientRect() : box;
    const rootFontSize =
      typeof window !== "undefined"
        ? Number.parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 16
        : 16;

    const paneCard =
      buttonRef.current?.closest<HTMLElement>(".pane-card, [data-space-pane-id]") ||
      buttonRef.current?.closest<HTMLElement>(".terminal-pane");
    const paneRect = paneCard
      ? paneCard.getBoundingClientRect()
      : {
          left: 0,
          right: window.innerWidth,
          top: 0,
          bottom: window.innerHeight,
          width: window.innerWidth,
          height: window.innerHeight
        };

    // Keep popover completely bounded within the pane horizontally
    const maxWidth = Math.max(
      200,
      Math.min(32 * rootFontSize, paneRect.width - 16, window.innerWidth - 16)
    );
    const idealRight = window.innerWidth - anchorBox.right;
    const minRight = Math.max(8, window.innerWidth - paneRect.right + 8);
    const maxRight = Math.max(minRight, window.innerWidth - paneRect.left - 8 - maxWidth);
    const chosenRight = Math.max(minRight, Math.min(idealRight, maxRight));

    // Vertical positioning: above the button, never covering the pane header or exceeding pane top
    const paneTopLimit = paneCard ? paneRect.top + 38 : 16;
    const availableHeightInsidePane = box.top - 8 - paneTopLimit;
    const availableHeightViewport = box.top - 8 - 16;
    // Utilize all available pane height without arbitrary 600px caps so full plans are visible
    const maxHeight = Math.max(
      160,
      Math.min(availableHeightInsidePane, availableHeightViewport, window.innerHeight - 32)
    );

    const targetHost = buttonRef.current?.closest<HTMLElement>(
      "[data-shell-mode], .space-shell, [data-room-theme], [data-ui-theme]"
    );
    setThemeContext({
      uiTheme:
        targetHost?.dataset.uiTheme ||
        (typeof document !== "undefined" ? document.body.dataset.uiTheme : undefined),
      interfaceTheme:
        targetHost?.dataset.interfaceTheme ||
        (typeof document !== "undefined" ? document.documentElement.dataset.interfaceTheme : undefined),
      roomTheme:
        targetHost?.dataset.roomTheme ||
        (typeof document !== "undefined" ? document.body.dataset.roomTheme : undefined),
      colorMode:
        targetHost?.dataset.colorMode ||
        (typeof document !== "undefined" ? document.body.dataset.colorMode : undefined)
    });
    setUserViewMode(null);
    resetFilters();
    setPosition({
      right: chosenRight,
      bottom: Math.max(8, window.innerHeight - box.top + 8),
      maxHeight,
      maxWidth,
      width: maxWidth
    });
  };

  const currentUiTheme =
    themeContext.uiTheme ??
    buttonRef.current?.closest<HTMLElement>("[data-shell-mode], .space-shell, [data-room-theme], [data-ui-theme]")
      ?.dataset.uiTheme ??
    (typeof document !== "undefined" ? document.body.dataset.uiTheme : undefined);
  const currentInterfaceTheme =
    themeContext.interfaceTheme ??
    buttonRef.current?.closest<HTMLElement>("[data-shell-mode], .space-shell, [data-room-theme], [data-ui-theme]")
      ?.dataset.interfaceTheme ??
    (typeof document !== "undefined" ? document.documentElement.dataset.interfaceTheme : undefined);
  const currentRoomTheme =
    themeContext.roomTheme ??
    buttonRef.current?.closest<HTMLElement>("[data-shell-mode], .space-shell, [data-room-theme], [data-ui-theme]")
      ?.dataset.roomTheme ??
    (typeof document !== "undefined" ? document.body.dataset.roomTheme : undefined);
  const currentColorMode =
    themeContext.colorMode ??
    buttonRef.current?.closest<HTMLElement>("[data-shell-mode], .space-shell, [data-room-theme], [data-ui-theme]")
      ?.dataset.colorMode ??
    (typeof document !== "undefined" ? document.body.dataset.colorMode : undefined);

  const titleText = managedExecution
    ? `Plan Progress: ${managedExecution.snapshot.title || "Plan"}`
    : activePlan
    ? `Active plan: ${activePlan.title || "Plan"} (${activePlan.progressPercentage}%)`
    : completedPanePlan
    ? `Completed plan: ${completedPanePlan.title || "Plan"}`
    : plans.length > 0
      ? `Open plans (${plans.length})`
      : "Open plans";

  const { availableModels, hasPlansWithoutModel, plansWithoutModelCount, modelCounts } = useMemo(() => {
    const modelsSet = new Set<string>();
    const counts: Record<string, number> = {};
    let withoutModel = 0;

    for (const p of plans) {
      const model = p.minimumModel?.trim();
      if (model) {
        modelsSet.add(model);
        counts[model] = (counts[model] || 0) + 1;
      } else {
        withoutModel += 1;
      }
    }

    return {
      availableModels: Array.from(modelsSet).sort((a, b) => a.localeCompare(b)),
      hasPlansWithoutModel: withoutModel > 0,
      plansWithoutModelCount: withoutModel,
      modelCounts: counts
    };
  }, [plans]);

  const inProgressCount = useMemo(() => {
    return plans.filter((p) => p.executionStatus === "IN_PROGRESS").length;
  }, [plans]);

  const notInProgressCount = useMemo(() => {
    return plans.filter((p) => p.executionStatus !== "IN_PROGRESS").length;
  }, [plans]);

  const toggleModel = (model: string) => {
    setSelectedModels((prev) => {
      if (prev.includes(model)) {
        return prev.filter((m) => m !== model);
      }
      return [...prev, model];
    });
  };

  const selectAllModels = () => {
    const all = [...availableModels];
    if (hasPlansWithoutModel) {
      all.push("__none__");
    }
    setSelectedModels(all);
  };

  const clearModels = () => {
    setSelectedModels([]);
  };

  const filteredPlans = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return plans.filter((p) => {
      // Status filter: In Progress vs Not in Progress
      if (statusFilter === "in_progress" && p.executionStatus !== "IN_PROGRESS") {
        return false;
      }
      if (statusFilter === "not_in_progress" && p.executionStatus === "IN_PROGRESS") {
        return false;
      }

      // Model filter: Multi-select
      if (selectedModels.length > 0) {
        const planModel = p.minimumModel?.trim();
        if (!planModel) {
          if (!selectedModels.includes("__none__")) {
            return false;
          }
        } else if (!selectedModels.includes(planModel)) {
          return false;
        }
      }

      // Search query
      if (q) {
        const matchTitle = (p.title ?? "").toLowerCase().includes(q);
        const matchText = (p.text ?? "").toLowerCase().includes(q);
        const matchModel = (p.minimumModel ?? "").toLowerCase().includes(q);
        if (!matchTitle && !matchText && !matchModel) {
          return false;
        }
      }

      return true;
    });
  }, [plans, searchQuery, statusFilter, selectedModels]);

  const hasActiveFilters =
    statusFilter !== "all" || selectedModels.length > 0 || Boolean(searchQuery.trim());

  const activePlanSteps = useMemo(() => {
    return displayPlan ? resolvePlanDisplaySteps(displayPlan) : [];
  }, [displayPlan]);

  const activePlanCompletedSteps = useMemo(() => {
    return activePlanSteps.filter((s) => s.status === "COMPLETED").length;
  }, [activePlanSteps]);

  const activePlanCurrentStep = useMemo(() => {
    return activePlanSteps.find((s) => s.status === "IN_PROGRESS") || activePlanSteps.find((s) => s.status === "PENDING");
  }, [activePlanSteps]);

  const toggleStepExpanded = (stepId: string) => {
    setExpandedStepIds((prev) => ({
      ...prev,
      [stepId]: !prev[stepId]
    }));
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`terminal-shortcuts-button terminal-plans-button ${managedExecution || activePlan ? "is-plan-active" : isDisplayPlanCompleted ? "is-plan-completed" : ""}`}
        aria-label={titleText}
        title={titleText}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        disabled={disabled}
        onClick={toggleOpen}
      >
        <ClipboardList aria-hidden="true" />
        {managedExecution ? (
          <span className="terminal-plans-button-badge is-active-badge" aria-hidden="true">{managedExecution.snapshot.stages.length ? Math.round(managedExecution.completedStageIds.length / managedExecution.snapshot.stages.length * 100) : 0}%</span>
        ) : activePlan ? (
          <span className="terminal-plans-button-badge is-active-badge" aria-hidden="true" title={`${activePlan.progressPercentage}% complete`}>
            {activePlan.progressPercentage}%
          </span>
        ) : completedPanePlan ? (
          <span className="terminal-plans-button-badge is-active-badge is-completed-badge" aria-hidden="true" title="Plan completed">
            ✓ 100%
          </span>
        ) : plans.length > 0 ? (
          <span className="terminal-plans-button-badge" aria-hidden="true">
            {plans.length > 9 ? "9+" : plans.length}
          </span>
        ) : null}
      </button>

      {open && position
        ? createPortal(
            <div
              ref={panelRef}
              id={id}
              className={`terminal-plans-popover ${effectiveViewMode === "active_plan" ? "is-active-view" : ""}`}
              role="dialog"
              aria-label={effectiveViewMode === "active_plan" ? "Active plan progress" : "Open plans"}
              data-ui-theme={currentUiTheme}
              data-interface-theme={currentInterfaceTheme}
              data-room-theme={currentRoomTheme}
              data-color-mode={currentColorMode}
              style={position}
              onBlur={(event) => {
                if (shouldPreserveForSnipTool(event)) return;
                if (
                  event.relatedTarget &&
                  event.relatedTarget !== buttonRef.current &&
                  !event.currentTarget.contains(event.relatedTarget as Node | null)
                ) {
                  setPosition(null);
                  setUserViewMode(null);
                  setSearchQuery("");
                }
              }}
            >
              {previewPlan ? (
                <>
                  <div className="terminal-plans-header">
                    <div className="terminal-plans-header-title">
                      <button
                        type="button"
                        className="terminal-plans-action-btn"
                        aria-label="Back to plans"
                        title="Back to plans"
                        onClick={() => setPreviewPlanId(null)}
                      >
                        <ArrowLeft aria-hidden="true" style={{ width: 14, height: 14 }} />
                      </button>
                      <span className="terminal-plans-title-text">Plan preview</span>
                    </div>
                    <div className="terminal-plans-header-actions">
                      <button
                        type="button"
                        className="terminal-plans-action-btn terminal-plans-close-btn"
                        aria-label="Close"
                        title="Close"
                        onClick={(event) => {
                          event.stopPropagation();
                          closeMenu();
                        }}
                      >
                        <X aria-hidden="true" style={{ width: 14, height: 14 }} />
                      </button>
                    </div>
                  </div>
                  <div className="terminal-plan-preview" aria-label={`Preview of ${previewPlan.title?.trim() || "Untitled Plan"}`}>
                    <div className="terminal-plan-overview-top">
                      <div className="terminal-plan-active-title" title={previewPlan.title || "Untitled Plan"}>
                        {previewPlan.title?.trim() || "Untitled Plan"}
                      </div>
                      <div className="terminal-plan-overview-tags">
                        {previewPlan.minimumModel ? (
                          <span className="terminal-plan-min-model-tag">
                            {previewPlan.minimumModel}{previewPlan.minimumReasoning ? ` · ${previewPlan.minimumReasoning}` : ""}
                          </span>
                        ) : null}
                        <span className="terminal-plan-status-tag" data-status={previewPlan.executionStatus}>
                          {previewPlan.executionStatus}{previewPlan.progressPercentage ? ` ${previewPlan.progressPercentage}%` : ""}
                        </span>
                      </div>
                    </div>
                    <div className="terminal-plan-item-meta">
                      <Clock3 aria-hidden="true" style={{ width: 11, height: 11 }} />
                      <span>{formatPlanDate(previewPlan.createdAt || previewPlan.lastUsedAt)}</span>
                      {previewPlan.characterCount ? <span>· {previewPlan.characterCount.toLocaleString()} chars</span> : null}
                      {Array.isArray(previewPlan.steps) && previewPlan.steps.length > 0 ? <span>· {previewPlan.steps.length} stages</span> : null}
                    </div>
                    {previewPlan.paneId && previewPlan.paneId !== pane?.id ? (
                      <div className="terminal-plan-preview-note" role="note">
                        Linked to {planAssignee(previewPlan, pane?.id, roomNames)}. Sending it here links it to this pane.
                      </div>
                    ) : null}
                    <pre className="terminal-plan-preview-text" tabIndex={0}>{previewPlan.text}</pre>
                    {error ? <div className="terminal-plans-error" role="alert">{error}</div> : null}
                    {!canSend ? (
                      <div className="terminal-plan-preview-note" role="note">
                        Attach a running CLI to send or insert this plan.
                      </div>
                    ) : null}
                    {canSend && draftWillBeCleared?.(previewPlan) ? (
                      <div className="terminal-plan-preview-note is-warning" role="note">
                        Send to CLI clears the text you have typed in this CLI. Use Insert without sending to keep it.
                      </div>
                    ) : null}
                    <div className="terminal-plan-preview-actions">
                      <button
                        type="button"
                        className="terminal-plan-preview-button is-primary"
                        disabled={!canSend}
                        onClick={() => {
                          const plan = previewPlan;
                          closeMenu();
                          onSelectPlan(plan);
                        }}
                      >
                        Send to CLI
                      </button>
                      {onInsertPlan ? (
                        <button
                          type="button"
                          className="terminal-plan-preview-button"
                          disabled={!canSend}
                          onClick={() => {
                            const plan = previewPlan;
                            closeMenu();
                            onInsertPlan(plan);
                          }}
                        >
                          Insert without sending
                        </button>
                      ) : null}
                      {previewPlan.paneId !== pane?.id && canOpenPlanPane(previewPlan) ? (
                        <button
                          type="button"
                          className="terminal-plan-preview-button terminal-plan-open-pane"
                          title={`Open ${previewPlan.paneTitle || "the pane that runs this plan"}`}
                          onClick={() => {
                            const plan = previewPlan;
                            closeMenu();
                            openPlanPane(plan);
                          }}
                        >
                          <ExternalLink aria-hidden="true" />
                          Open pane
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="terminal-plan-preview-button"
                        onClick={() => void copyPlanText(previewPlan)}
                      >
                        {copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy plan"}
                      </button>
                      <button
                        type="button"
                        className="terminal-plan-preview-button"
                        data-confirming={confirmDonePlanId === previewPlan.id ? "true" : undefined}
                        disabled={planActionPending || typeof api?.setClipboardItemCompleted !== "function"}
                        onClick={() => markPlanDone(previewPlan)}
                      >
                        {confirmDonePlanId === previewPlan.id ? "Confirm done" : "Mark done"}
                      </button>
                      {previewPlan.paneId && previewPlan.paneId === pane?.id ? (
                        <button
                          type="button"
                          className="terminal-plan-preview-button"
                          disabled={planActionPending}
                          onClick={() => detachPlan(previewPlan)}
                        >
                          Detach from pane
                        </button>
                      ) : null}
                    </div>
                  </div>
                </>
              ) : effectiveViewMode === "active_plan" && managedExecution ? (
                <>
                  <div className="terminal-plans-header">
                    <div className="terminal-plans-header-title"><ClipboardList aria-hidden="true" style={{ width: 16, height: 16 }} /><span className="terminal-plans-title-text">Plan Progress</span></div>
                    <div className="terminal-plans-header-actions">
                      <button type="button" className="terminal-plans-nav-btn" onClick={() => setUserViewMode("all_plans")}>All plans ({plans.length})</button>
                      <button type="button" className="terminal-plans-action-btn" aria-label="Refresh plan execution" disabled={managedPending} onClick={() => { void onManagedRefresh?.().catch(() => {}); }}><RotateCw className={managedPending ? "is-spinning" : ""} aria-hidden="true" style={{ width: 13, height: 13 }} /></button>
                      <button type="button" className="terminal-plans-action-btn terminal-plans-close-btn" aria-label="Close" title="Close" onClick={(event) => { event.stopPropagation(); setPosition(null); setUserViewMode(null); resetFilters(); }}><X aria-hidden="true" style={{ width: 14, height: 14 }} /></button>
                    </div>
                  </div>
                  <ManagedPlanProgress key={`${managedExecution.id}:${managedExecution.sessionId}`} execution={managedExecution} settings={managedSettings} error={managedError} pending={managedPending} canControl={canControlManaged}
                    onOverride={onManagedOverride ?? (async () => { throw new Error("Stage model controls are unavailable."); })}
                    onControl={onManagedControl ?? (async () => { throw new Error("Plan controls are unavailable."); })} />
                </>
              ) : effectiveViewMode === "active_plan" && displayPlan ? (
                <>
                  {/* Active Plan Header */}
                  <div className="terminal-plans-header">
                    <div className="terminal-plans-header-title">
                      <ClipboardList aria-hidden="true" style={{ width: 16, height: 16 }} />
                      <span className="terminal-plans-title-text">Plan Progress</span>
                      <span className="terminal-plan-progress-pill" data-status={displayPlan.executionStatus}>
                        {displayPlan.progressPercentage}%
                      </span>
                    </div>
                    <div className="terminal-plans-header-actions">
                      <button
                        type="button"
                        className="terminal-plans-nav-btn"
                        onClick={() => setUserViewMode("all_plans")}
                        title="View all open plans"
                      >
                        All plans ({plans.length})
                      </button>
                      <button
                        type="button"
                        className="terminal-plans-action-btn"
                        aria-label="Refresh plans"
                        title="Refresh plan progress"
                        onClick={(e) => {
                          e.stopPropagation();
                          void loadPlans(true);
                        }}
                      >
                        <RotateCw
                          className={loading ? "is-spinning" : ""}
                          aria-hidden="true"
                          style={{ width: 13, height: 13 }}
                        />
                      </button>
                      <button
                        type="button"
                        className="terminal-plans-action-btn terminal-plans-close-btn"
                        aria-label="Close"
                        title="Close"
                        onClick={(e) => {
                          e.stopPropagation();
                          setPosition(null);
                          setUserViewMode(null);
                        }}
                      >
                        <X aria-hidden="true" style={{ width: 14, height: 14 }} />
                      </button>
                    </div>
                  </div>

                  {/* Active Plan Content */}
                  <div className="terminal-plan-active-body">
                    {/* Overview Card */}
                    <div className="terminal-plan-overview-card">
                      <div className="terminal-plan-overview-top">
                        <div className="terminal-plan-active-title" title={displayPlan.title || "Active Plan"}>
                          {displayPlan.title || "Active Plan"}
                        </div>
                        <div className="terminal-plan-overview-tags">
                          {displayPlan.minimumModel ? (
                            <span
                              className="terminal-plan-min-model-tag"
                              title={`Minimum capable model: ${displayPlan.minimumModel}${displayPlan.minimumReasoning ? `; Recommended reasoning: ${displayPlan.minimumReasoning}` : ""}`}
                            >
                              {displayPlan.minimumModel}{displayPlan.minimumReasoning ? ` · ${displayPlan.minimumReasoning}` : ""}
                            </span>
                          ) : null}
                          <span
                            className="terminal-plan-status-tag"
                            data-status={displayPlan.executionStatus}
                          >
                            {displayPlan.executionStatus}
                          </span>
                        </div>
                      </div>

                      {isSuggestedMatch && activePlan && displayPlan.id === activePlan.id ? (
                        <div className="terminal-plan-suggested-link" role="note">
                          <span>Suggested match for this pane. It is not linked yet.</span>
                          <button
                            type="button"
                            className="terminal-plans-nav-btn"
                            disabled={linkPending}
                            onClick={(event) => {
                              event.stopPropagation();
                              linkSuggestedPlan(activePlan);
                            }}
                          >
                            {linkPending ? "Linking…" : "Link to this pane"}
                          </button>
                        </div>
                      ) : null}

                      {/* Graphic Progress Bar */}
                      <div className="terminal-plan-graphic-progress">
                        <div className="terminal-plan-graphic-progress-header">
                          <span className="terminal-plan-graphic-progress-title">
                            Overall Progress: <strong>{displayPlan.progressPercentage}%</strong>
                          </span>
                          <span className="terminal-plan-graphic-progress-sub">
                            {activePlanSteps.length > 0
                              ? `${activePlanCompletedSteps} of ${activePlanSteps.length} stages completed${activePlanSteps.some((step) => step.estimated) ? " (estimated from overall progress)" : ""}`
                              : formatPlanDate(displayPlan.createdAt || displayPlan.lastUsedAt)}
                          </span>
                        </div>
                        <div className="terminal-plan-progress-track" role="progressbar" aria-valuenow={displayPlan.progressPercentage} aria-valuemin={0} aria-valuemax={100}>
                          <div
                            className="terminal-plan-progress-fill"
                            style={{ width: `${Math.max(4, Math.min(100, displayPlan.progressPercentage))}%` }}
                          />
                        </div>
                        {activePlanCurrentStep ? (
                          <div className="terminal-plan-current-stage-callout">
                            <span className="terminal-plan-current-stage-label">Current Stage:</span>
                            <span className="terminal-plan-current-stage-name">
                              Stage {activePlanCurrentStep.order}: {activePlanCurrentStep.title}
                            </span>
                            {activePlanCurrentStep.progress > 0 && activePlanCurrentStep.progress < 100 ? (
                              <span className="terminal-plan-current-stage-progress">
                                ({activePlanCurrentStep.progress}%)
                              </span>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    </div>

                    {/* Stepper Timeline */}
                    {activePlanSteps.length > 0 ? (
                      <div className="terminal-plan-stepper-container" role="list" aria-label="Plan stages">
                        <div className="terminal-plan-stepper-title">
                          <span>Stages & Milestones</span>
                          <span className="terminal-plan-stepper-badge">{activePlanSteps.length}</span>
                        </div>
                        <div className="terminal-plan-stepper">
                          {activePlanSteps.map((step, index) => {
                            const isCompleted = step.status === "COMPLETED";
                            const isInProgress = step.status === "IN_PROGRESS";
                            const isPending = step.status === "PENDING";
                            const isExpanded = expandedStepIds[step.id] ?? false;
                            const hasDetails = Boolean(step.notes || step.proof);
                            const stepModel = resolveStepModel(step, displayPlan);
                            const showModelTag = Boolean(
                              stepModel &&
                                (!step.agent ||
                                  step.agent.toLowerCase().includes("unavailable") ||
                                  !isSameModel(step.agent, stepModel))
                            );

                            return (
                              <div
                                key={step.id || index}
                                role="listitem"
                                className={`terminal-plan-step-item ${isCompleted ? "is-completed" : ""} ${isInProgress ? "is-in-progress" : ""} ${isPending ? "is-pending" : ""}`}
                              >
                                {/* Left Graphic Node */}
                                <div className="terminal-plan-step-node-col">
                                  <div className={`terminal-plan-step-node ${isCompleted ? "node-completed" : ""} ${isInProgress ? "node-in-progress" : ""} ${isPending ? "node-pending" : ""}`}>
                                    {isCompleted ? (
                                      <Check aria-hidden="true" style={{ width: 11, height: 11, strokeWidth: 3 }} />
                                    ) : isInProgress ? (
                                      <span className="terminal-plan-step-pulse-dot" />
                                    ) : (
                                      <span>{step.order}</span>
                                    )}
                                  </div>
                                  {index < activePlanSteps.length - 1 ? (
                                    <div className={`terminal-plan-step-line ${isCompleted ? "line-completed" : ""}`} />
                                  ) : null}
                                </div>

                                {/* Right Content Card */}
                                <div
                                  className={`terminal-plan-step-content ${hasDetails ? "is-clickable" : ""}`}
                                  role={hasDetails ? "button" : undefined}
                                  tabIndex={hasDetails ? 0 : undefined}
                                  aria-expanded={hasDetails ? isExpanded : undefined}
                                  onClick={() => {
                                    if (hasDetails) toggleStepExpanded(step.id);
                                  }}
                                  onKeyDown={(event) => {
                                    if (!hasDetails || (event.key !== "Enter" && event.key !== " ")) return;
                                    event.preventDefault();
                                    toggleStepExpanded(step.id);
                                  }}
                                  title={hasDetails ? (isExpanded ? "Click to collapse details" : "Click to view notes and proof") : undefined}
                                >
                                  <div className="terminal-plan-step-header">
                                    <span className="terminal-plan-step-title">
                                      Stage {step.order}: {step.title}
                                    </span>
                                    <div className="terminal-plan-step-tags">
                                      {showModelTag && stepModel ? (
                                        <span className="terminal-plan-step-model-tag" title={`Designated model for stage: ${stepModel}`}>
                                          {stepModel}
                                        </span>
                                      ) : null}
                                      {step.agent ? (
                                        <span className="terminal-plan-step-agent-tag" title={`Assigned agent/model: ${step.agent}`}>
                                          {step.agent}
                                        </span>
                                      ) : null}
                                      <span
                                        className={`terminal-plan-step-badge ${isCompleted ? "badge-completed" : isInProgress ? "badge-in-progress" : "badge-pending"}`}
                                      >
                                        {isCompleted ? "Completed" : isInProgress ? `In Progress ${step.progress > 0 ? `${step.progress}%` : ""}` : "Pending"}
                                      </span>
                                    </div>
                                  </div>

                                  {isInProgress && step.progress > 0 ? (
                                    <div className="terminal-plan-step-progress-mini">
                                      <div
                                        className="terminal-plan-step-progress-fill"
                                        style={{ width: `${Math.max(5, Math.min(100, step.progress))}%` }}
                                      />
                                    </div>
                                  ) : null}

                                  {hasDetails ? (
                                    <div className="terminal-plan-step-expand-hint">
                                      <span>{isExpanded ? "Hide details ▲" : "View notes & proof ▼"}</span>
                                    </div>
                                  ) : null}

                                  {isExpanded && step.notes ? (
                                    <div className="terminal-plan-step-notes">
                                      <div className="terminal-plan-step-notes-label">Notes:</div>
                                      <div className="terminal-plan-step-notes-text">{step.notes}</div>
                                    </div>
                                  ) : null}

                                  {isExpanded && step.proof ? (
                                    <div className="terminal-plan-step-proof">
                                      <div className="terminal-plan-step-proof-label">Proof:</div>
                                      <div className="terminal-plan-step-proof-text">{step.proof}</div>
                                    </div>
                                  ) : null}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ) : (
                      <div className="terminal-plan-snippet-card">
                        <div className="terminal-plan-snippet-label">Plan Description</div>
                        <div className="terminal-plan-snippet-text">{displayPlan.text.slice(0, 400)}…</div>
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <>
                  {managedExecution ? <button type="button" className="terminal-plans-nav-btn" onClick={() => setUserViewMode("active_plan")}>View managed plan progress and history</button> : null}
                  {managedError ? <p className="terminal-plans-error" role="alert">{managedError}</p> : null}

                  {/* All Plans View Header */}
                  <div className="terminal-plans-header">
                    <div className="terminal-plans-header-title">
                      {displayPlan ? (
                        <button
                          type="button"
                          className="terminal-plans-back-btn"
                          onClick={() => setUserViewMode("active_plan")}
                          title={isDisplayPlanCompleted ? "Back to completed plan progress" : "Back to active plan progress"}
                          aria-label={isDisplayPlanCompleted ? "Back to completed plan progress" : "Back to active plan progress"}
                        >
                          <ChevronLeft aria-hidden="true" style={{ width: 15, height: 15 }} />
                          <span>{isDisplayPlanCompleted ? "Completed Plan" : "Active Plan"}</span>
                        </button>
                      ) : (
                        <>
                          <ClipboardList aria-hidden="true" style={{ width: 16, height: 16 }} />
                          <span>Open plans</span>
                          {plans.length > 0 ? (
                            <span className="terminal-plans-count-badge">{plans.length}</span>
                          ) : null}
                        </>
                      )}
                    </div>
                    <div className="terminal-plans-header-actions">
                      <button
                        type="button"
                        className="terminal-plans-action-btn"
                        aria-label="Refresh plans"
                        title="Refresh plans"
                        onClick={(e) => {
                          e.stopPropagation();
                          void loadPlans(true);
                        }}
                      >
                        <RotateCw
                          className={loading ? "is-spinning" : ""}
                          aria-hidden="true"
                          style={{ width: 13, height: 13 }}
                        />
                      </button>
                      <button
                        type="button"
                        className="terminal-plans-action-btn terminal-plans-close-btn"
                        aria-label="Close"
                        title="Close"
                        onClick={(e) => {
                          e.stopPropagation();
                          setPosition(null);
                          setUserViewMode(null);
                        }}
                      >
                        <X aria-hidden="true" style={{ width: 14, height: 14 }} />
                      </button>
                    </div>
                  </div>

                  {/* Active Plan Callout Banner if available */}
                  {displayPlan ? (
                    <div className="terminal-plans-active-banner">
                      <div className="terminal-plans-active-banner-info">
                        {isDisplayPlanCompleted ? (
                          <Check aria-hidden="true" style={{ width: 14, height: 14 }} />
                        ) : (
                          <Activity aria-hidden="true" style={{ width: 14, height: 14 }} />
                        )}
                        <span className="terminal-plans-active-banner-title">
                          {isDisplayPlanCompleted ? "Completed" : "Currently Running"}: <strong>{displayPlan.title || "Plan"}</strong>
                        </span>
                        <span className="terminal-plan-progress-pill">{displayPlan.progressPercentage}%</span>
                      </div>
                      <button
                        type="button"
                        className="terminal-plans-active-banner-btn"
                        onClick={() => setUserViewMode("active_plan")}
                      >
                        View Progress →
                      </button>
                    </div>
                  ) : null}

                  {/* Search Bar */}
                  {plans.length > 0 ? (
                    <div className="terminal-plans-search-container">
                      <Search aria-hidden="true" style={{ width: 13, height: 13 }} />
                      <input
                        type="text"
                        className="terminal-plans-search-input"
                        placeholder="Filter plans…"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        aria-label="Filter plans"
                      />
                      {searchQuery ? (
                        <button
                          type="button"
                          className="terminal-plans-search-clear"
                          onClick={() => setSearchQuery("")}
                          aria-label="Clear filter"
                        >
                          <X aria-hidden="true" style={{ width: 12, height: 12 }} />
                        </button>
                      ) : null}
                    </div>
                  ) : null}

                  {/* Filter Bar: Status & Models */}
                  {plans.length > 0 ? (
                    <div className="terminal-plans-filters-bar">
                      {/* Status Filter */}
                      <div className="terminal-plans-status-filters" role="group" aria-label="Filter plans by status">
                        <button
                          type="button"
                          className={`terminal-plans-filter-chip ${statusFilter === "all" ? "is-active" : ""}`}
                          onClick={() => setStatusFilter("all")}
                          aria-pressed={statusFilter === "all"}
                        >
                          All ({plans.length})
                        </button>
                        <button
                          type="button"
                          className={`terminal-plans-filter-chip ${statusFilter === "in_progress" ? "is-active" : ""}`}
                          onClick={() => setStatusFilter("in_progress")}
                          aria-pressed={statusFilter === "in_progress"}
                        >
                          In Progress ({inProgressCount})
                        </button>
                        <button
                          type="button"
                          className={`terminal-plans-filter-chip ${statusFilter === "not_in_progress" ? "is-active" : ""}`}
                          onClick={() => setStatusFilter("not_in_progress")}
                          aria-pressed={statusFilter === "not_in_progress"}
                        >
                          Not in Progress ({notInProgressCount})
                        </button>
                      </div>

                      {/* Model Multi-Select Filter */}
                      {availableModels.length > 0 || hasPlansWithoutModel ? (
                        <div className="terminal-plans-models-filter-container" ref={modelDropdownRef}>
                          <button
                            type="button"
                            className={`terminal-plans-models-btn ${selectedModels.length > 0 ? "is-active" : ""}`}
                            onClick={() => setModelDropdownOpen((prev) => !prev)}
                            aria-expanded={modelDropdownOpen}
                            aria-label="Filter plans by model"
                            title="Filter plans by model"
                          >
                            <ListFilter aria-hidden="true" style={{ width: 11, height: 11 }} />
                            <span>
                              {selectedModels.length > 0
                                ? `Models (${selectedModels.length})`
                                : "Models"}
                            </span>
                            <ChevronDown aria-hidden="true" style={{ width: 11, height: 11 }} />
                          </button>

                          {modelDropdownOpen ? (
                            <div className="terminal-plans-models-menu" role="group" aria-label="Model options">
                              <div className="terminal-plans-models-menu-header">
                                <span>Select models</span>
                                <div className="terminal-plans-models-menu-actions">
                                  <button
                                    type="button"
                                    className="terminal-plans-models-action-btn"
                                    onClick={selectAllModels}
                                  >
                                    Select all
                                  </button>
                                  <button
                                    type="button"
                                    className="terminal-plans-models-action-btn"
                                    onClick={clearModels}
                                  >
                                    Clear
                                  </button>
                                </div>
                              </div>
                              <div className="terminal-plans-models-menu-list">
                                {availableModels.map((model) => (
                                  <SpaceToggle
                                    key={model}
                                    className="terminal-plans-model-option"
                                    ariaLabel={`Filter plans by ${model}`}
                                    checked={selectedModels.includes(model)}
                                    onChange={() => toggleModel(model)}
                                    label={
                                      <>
                                        <span className="terminal-plans-model-option-name" title={model}>
                                          {model}
                                        </span>
                                        <span className="terminal-plans-model-option-count">
                                          {modelCounts[model] || 0}
                                        </span>
                                      </>
                                    }
                                  />
                                ))}
                                {hasPlansWithoutModel ? (
                                  <SpaceToggle
                                    className="terminal-plans-model-option"
                                    ariaLabel="Filter plans with no model specified"
                                    checked={selectedModels.includes("__none__")}
                                    onChange={() => toggleModel("__none__")}
                                    label={
                                      <>
                                        <span className="terminal-plans-model-option-name">
                                          No model specified
                                        </span>
                                        <span className="terminal-plans-model-option-count">
                                          {plansWithoutModelCount}
                                        </span>
                                      </>
                                    }
                                  />
                                ) : null}
                              </div>
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  {/* Active Selected Model Chips */}
                  {selectedModels.length > 0 ? (
                    <div className="terminal-plans-active-model-chips">
                      <span className="terminal-plans-active-chips-label">Models:</span>
                      {selectedModels.map((m) => {
                        const label = m === "__none__" ? "No model" : m;
                        return (
                          <span key={m} className="terminal-plans-selected-chip">
                            <span>{label}</span>
                            <button
                              type="button"
                              className="terminal-plans-chip-remove"
                              onClick={() => toggleModel(m)}
                              aria-label={`Remove filter for ${label}`}
                              title={`Remove filter for ${label}`}
                            >
                              <X aria-hidden="true" style={{ width: 10, height: 10 }} />
                            </button>
                          </span>
                        );
                      })}
                      <button
                        type="button"
                        className="terminal-plans-clear-models-btn"
                        onClick={clearModels}
                        title="Clear model filters"
                      >
                        Reset
                      </button>
                    </div>
                  ) : null}

                  {/* Loading / Error / Empty States */}
                  {loading && plans.length === 0 ? (
                    <div className="terminal-plans-loading" role="status">
                      <Loader2 className="is-spinning" aria-hidden="true" style={{ width: 16, height: 16 }} />
                      <span>Loading open plans…</span>
                    </div>
                  ) : null}

                  {error ? (
                    <div className="terminal-plans-error" role="alert">
                      {error}{plans.length > 0 ? " Showing the plans loaded before." : ""}
                    </div>
                  ) : null}

                  {!loading && plans.length === 0 && !error ? (
                    <div className="terminal-plans-empty" role="status">
                      No open plans
                    </div>
                  ) : null}

                  {filteredPlans.length === 0 && plans.length > 0 ? (
                    <div className="terminal-plans-empty" role="status">
                      <span>
                        {hasActiveFilters
                          ? searchQuery
                            ? `No plans match "${searchQuery}"`
                            : "No plans match the selected filters"
                          : "No open plans"}
                      </span>
                      {hasActiveFilters ? (
                        <button
                          type="button"
                          className="terminal-plans-clear-all-btn"
                          onClick={resetFilters}
                        >
                          Clear all filters
                        </button>
                      ) : null}
                    </div>
                  ) : null}

                  {/* Plans List */}
                  {filteredPlans.length > 0 ? (
                    <div className="terminal-plans-list" role="list" aria-label="Open plans list">
                      {filteredPlans.map((plan) => {
                        const planTitle = plan.title?.trim() || "Untitled Plan";
                        const dateLabel = formatPlanDate(plan.createdAt || plan.lastUsedAt);
                        const snippet = formatPlanSnippet(plan.text);
                        const isProgressActive =
                          plan.executionStatus && plan.executionStatus !== "PLANNED";
                        const isThisPaneActive = Boolean(activePlan && activePlan.id === plan.id);
                        const stepsCount = Array.isArray(plan.steps) ? plan.steps.length : 0;
                        const assignee = planAssignee(plan, pane?.id, roomNames);

                        return (
                          <div key={plan.id} role="listitem" className="terminal-plan-item-row">
                          <button
                            type="button"
                            className={`terminal-plan-item ${isThisPaneActive ? "is-current-active" : ""}`}
                            onClick={() => {
                              setCopyState("idle");
                              setPreviewPlanId(plan.id);
                            }}
                            title={`Preview plan: ${planTitle}`}
                          >
                            <div className="terminal-plan-item-top">
                              <span className="terminal-plan-item-title">{planTitle}</span>
                              <div className="terminal-plan-item-badges">
                                {plan.minimumModel ? (
                                  <span
                                    className="terminal-plan-min-model-tag"
                                    title={`Minimum capable model: ${plan.minimumModel}${plan.minimumReasoning ? `; Recommended reasoning: ${plan.minimumReasoning}` : ""}`}
                                  >
                                    {plan.minimumModel}{plan.minimumReasoning ? ` · ${plan.minimumReasoning}` : ""}
                                  </span>
                                ) : null}
                                {isProgressActive ? (
                                  <span
                                    className="terminal-plan-status-tag"
                                    data-status={plan.executionStatus}
                                  >
                                    {plan.executionStatus}{" "}
                                    {plan.progressPercentage ? `${plan.progressPercentage}%` : ""}
                                  </span>
                                ) : null}
                              </div>
                            </div>

                            {/* Graphic Mini Progress Bar on Card */}
                            {plan.progressPercentage > 0 ? (
                              <div className="terminal-plan-card-progress">
                                <div className="terminal-plan-card-progress-bar">
                                  <div
                                    className="terminal-plan-card-progress-fill"
                                    style={{ width: `${Math.max(4, Math.min(100, plan.progressPercentage))}%` }}
                                  />
                                </div>
                                <span className="terminal-plan-card-progress-text">
                                  {plan.progressPercentage}% complete {stepsCount > 0 ? `· ${stepsCount} stages` : ""}
                                </span>
                              </div>
                            ) : null}

                            <div className="terminal-plan-item-meta">
                              <Clock3 aria-hidden="true" style={{ width: 11, height: 11 }} />
                              <span>{dateLabel}</span>
                              {plan.characterCount ? (
                                <span>· {plan.characterCount.toLocaleString()} chars</span>
                              ) : null}
                              {stepsCount > 0 && plan.progressPercentage === 0 ? (
                                <span>· {stepsCount} stages</span>
                              ) : null}
                              {assignee ? <span>· Linked to {assignee}</span> : null}
                            </div>
                            {snippet ? (
                              <div className="terminal-plan-item-snippet">{snippet}</div>
                            ) : null}
                          </button>
                          </div>
                        );
                      })}
                    </div>
                  ) : null}
                </>
              )}
            </div>,
            document.body
          )
        : null}
    </>
  );
}
