import type { SystemServicesResponse, SystemServiceUnit } from "@space/contracts";
import {
  AlertTriangle,
  Boxes,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Clock3,
  Copy,
  Cpu,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  X
} from "../ui-theme/app-icons.js";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent
} from "react";
import { api } from "../../api.js";
import "./service-control.css";

export interface SystemServicesClient {
  listSystemServices(): Promise<SystemServicesResponse>;
  resetFailedSystemServices?: (unit?: string) => Promise<{ success: boolean; reset: string }>;
}

export type ServiceFilter =
  | "all"
  | "active"
  | "inactive"
  | "failed"
  | "services"
  | "timers"
  | "enabled"
  | "disabled";

function stateLabel(unit: SystemServiceUnit): string {
  if (unit.type === "timer") {
    return unit.activeState === "active" ? "scheduled" : unit.activeState;
  }
  return unit.subState === "running" ? "running" : unit.subState;
}

function stateTone(unit: SystemServiceUnit): string {
  if (unit.activeState === "failed" || unit.subState === "failed") {
    return "tone-bad";
  }
  if (unit.type === "timer") {
    return unit.activeState === "active" ? "tone-ok" : "tone-inactive";
  }
  if (unit.activeState === "active") {
    return unit.subState === "running" ? "tone-ok" : "tone-idle";
  }
  return "tone-inactive";
}

function enabledLabel(unit: SystemServiceUnit): string {
  return unit.unitFileState ?? "—";
}

function enabledBadgeTone(state: string | null): string {
  if (!state) return "badge-neutral";
  if (state === "enabled" || state === "enabled-runtime") return "badge-enabled";
  if (state === "disabled") return "badge-disabled";
  if (state === "static") return "badge-static";
  if (state === "masked") return "badge-masked";
  return "badge-neutral";
}

function formatRelativeTime(isoString: string): string {
  const targetMs = new Date(isoString).getTime();
  if (!Number.isFinite(targetMs)) return "";
  const diffMs = targetMs - Date.now();
  if (diffMs < 0) {
    const passedSec = Math.floor(-diffMs / 1000);
    if (passedSec < 60) return `${passedSec}s ago`;
    const passedMin = Math.floor(passedSec / 60);
    if (passedMin < 60) return `${passedMin}m ago`;
    const passedHr = Math.floor(passedMin / 60);
    return `${passedHr}h ago`;
  }
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `in ${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `in ${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  if (hr < 24) return remMin > 0 ? `in ${hr}h ${remMin}m` : `in ${hr}h`;
  const days = Math.floor(hr / 24);
  return `in ${days}d`;
}

function formatNextRun(unit: SystemServiceUnit): { full: string; relative: string } | null {
  if (unit.type !== "timer" || !unit.timerNextElapse) return null;
  const d = new Date(unit.timerNextElapse);
  if (!Number.isFinite(d.getTime())) return null;
  return {
    full: d.toLocaleString(),
    relative: formatRelativeTime(unit.timerNextElapse)
  };
}

function useCurrentTheme() {
  const [themeState, setThemeState] = useState(() => {
    if (typeof document === "undefined") return {};
    const shell = document.querySelector(".space-shell");
    return {
      uiTheme: shell?.getAttribute("data-ui-theme") || document.body?.dataset?.uiTheme || "modern",
      interfaceTheme: shell?.getAttribute("data-interface-theme") || document.documentElement?.dataset?.interfaceTheme || "modern",
      roomTheme: shell?.getAttribute("data-room-theme") || document.body?.dataset?.roomTheme || "graphite",
      colorMode: shell?.getAttribute("data-color-mode") || document.body?.dataset?.colorMode || "dark",
      iconPack: shell?.getAttribute("data-icon-pack") || document.body?.dataset?.iconPack || "lucide"
    };
  });

  useEffect(() => {
    if (typeof document === "undefined") return;
    const update = () => {
      const shell = document.querySelector(".space-shell");
      setThemeState({
        uiTheme: shell?.getAttribute("data-ui-theme") || document.body?.dataset?.uiTheme || "modern",
        interfaceTheme: shell?.getAttribute("data-interface-theme") || document.documentElement?.dataset?.interfaceTheme || "modern",
        roomTheme: shell?.getAttribute("data-room-theme") || document.body?.dataset?.roomTheme || "graphite",
        colorMode: shell?.getAttribute("data-color-mode") || document.body?.dataset?.colorMode || "dark",
        iconPack: shell?.getAttribute("data-icon-pack") || document.body?.dataset?.iconPack || "lucide"
      });
    };

    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-interface-theme", "data-color-mode"] });
    observer.observe(document.body, { attributes: true, attributeFilter: ["data-ui-theme", "data-room-theme", "data-color-mode", "data-icon-pack"] });
    const shell = document.querySelector(".space-shell");
    if (shell) {
      observer.observe(shell, { attributes: true, attributeFilter: ["data-ui-theme", "data-room-theme", "data-color-mode", "data-icon-pack", "data-interface-theme"] });
    }
    return () => observer.disconnect();
  }, []);

  return themeState;
}

export function SystemServicesDialog({
  client = api,
  embedded = false,
  onClose
}: {
  embedded?: boolean;
  client?: SystemServicesClient;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const theme = useCurrentTheme();

  const [snapshot, setSnapshot] = useState<SystemServicesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const [filter, setFilter] = useState<ServiceFilter>("all");
  const [search, setSearch] = useState("");
  const [expandedUnit, setExpandedUnit] = useState<string | null>(null);
  const [copiedUnit, setCopiedUnit] = useState<string | null>(null);

  const load = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      const next = await client.listSystemServices();
      setSnapshot(next);
    } catch (reason) {
      setError(
        reason instanceof Error && reason.message.trim()
          ? reason.message
          : "System services are temporarily unavailable."
      );
    } finally {
      setRefreshing(false);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => closeRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const close = useCallback(() => {
    if (!refreshing) onClose();
  }, [refreshing, onClose]);

  const handleCopy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedUnit(text);
      setTimeout(() => setCopiedUnit(null), 2000);
    } catch {
      // ignore clipboard error
    }
  }, []);

  const handleResetFailed = useCallback(async (unit?: string) => {
    setResetting(true);
    setNotice(null);
    try {
      if (client.resetFailedSystemServices) {
        await client.resetFailedSystemServices(unit);
      } else {
        await api.resetFailedSystemServices(unit);
      }
      setNotice(unit ? `Reset failed state for ${unit}.` : "Reset failed state for all Space services.");
      await load();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "Failed to reset unit status.");
    } finally {
      setResetting(false);
    }
  }, [client, load]);

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      if (!refreshing) {
        event.preventDefault();
        close();
      }
      return;
    }
    if (event.key !== "Tab") return;
    const controls = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(
        "button:not(:disabled), input:not(:disabled), textarea:not(:disabled)"
      ) ?? []
    );
    const first = controls[0];
    const last = controls.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  const units = snapshot?.units ?? [];

  const filteredUnits = useMemo(() => {
    return units.filter((unit) => {
      // Filter category
      if (filter === "active" && unit.activeState !== "active") return false;
      if (filter === "inactive" && unit.activeState === "active") return false;
      if (filter === "failed" && unit.activeState !== "failed" && unit.subState !== "failed") return false;
      if (filter === "services" && unit.type !== "service") return false;
      if (filter === "timers" && unit.type !== "timer") return false;
      if (filter === "enabled" && unit.unitFileState !== "enabled") return false;
      if (filter === "disabled" && unit.unitFileState !== "disabled") return false;

      // Text search
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        const matchesName = unit.unit.toLowerCase().includes(q);
        const matchesDesc = (unit.description ?? "").toLowerCase().includes(q);
        const matchesState = unit.activeState.toLowerCase().includes(q) || unit.subState.toLowerCase().includes(q);
        const matchesFileState = (unit.unitFileState ?? "").toLowerCase().includes(q);
        const matchesActivates = (unit.timerActivates ?? "").toLowerCase().includes(q);
        if (!matchesName && !matchesDesc && !matchesState && !matchesFileState && !matchesActivates) {
          return false;
        }
      }

      return true;
    });
  }, [units, filter, search]);

  const activeUnits = useMemo(() => filteredUnits.filter((u) => u.activeState === "active"), [filteredUnits]);
  const inactiveUnits = useMemo(() => filteredUnits.filter((u) => u.activeState !== "active"), [filteredUnits]);

  // Compute distribution percentages for visual meter
  const totalCount = snapshot?.summary.total || 1;
  const activeCount = snapshot?.summary.active || 0;
  const inactiveCount = snapshot?.summary.inactive || 0;
  const failedCount = snapshot?.summary.failed || 0;

  const activePct = Math.round((activeCount / totalCount) * 100);
  const inactivePct = Math.round((inactiveCount / totalCount) * 100);
  const failedPct = Math.round((failedCount / totalCount) * 100);

  const isFiltered = filter !== "all" || Boolean(search.trim());

  return (
    <div
      className={`service-control-backdrop${embedded ? " manage-embedded" : ""}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <section
        ref={dialogRef}
        className="service-control-dialog"
        role={embedded ? "region" : "dialog"}
        aria-modal={embedded ? undefined : true}
        aria-label="System services"
        aria-busy={refreshing}
        onKeyDown={handleKeyDown}
        data-ui-theme={theme.uiTheme}
        data-interface-theme={theme.interfaceTheme}
        data-room-theme={theme.roomTheme}
        data-color-mode={theme.colorMode}
        data-icon-pack={theme.iconPack}
      >
        <header className="service-control-header">
          <span className="service-control-icon">
            <Boxes aria-hidden="true" />
          </span>
          <div className="service-control-header-text">
            <h2>System services</h2>
            <p>Space and memory systemd services on public-host: status, schedule and enabled state.</p>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="service-control-header-btn"
            aria-label="Refresh services"
            disabled={refreshing}
            onClick={() => void load()}
            title="Refresh"
          >
            <RefreshCw aria-hidden="true" className={refreshing ? "is-spinning" : ""} />
          </button>
          <button
            type="button"
            className="service-control-header-btn"
            aria-label="Close system services"
            disabled={refreshing}
            onClick={close}
            title="Close"
          >
            <X aria-hidden="true" />
          </button>
        </header>

        {snapshot ? (
          <>
            {/* Visual Graphic Distribution Meter ("γραφικά theme") */}
            <div className="service-control-distribution" aria-label="Services distribution breakdown">
              <div className="service-distribution-bar">
                {activeCount > 0 ? (
                  <button
                    type="button"
                    className={`service-bar-segment is-active ${filter === "active" ? "is-selected" : ""}`}
                    style={{ width: `${(activeCount / totalCount) * 100}%` }}
                    onClick={() => setFilter(filter === "active" ? "all" : "active")}
                    title={`Active: ${activeCount} (${activePct}%) - Click to filter`}
                  >
                    <span className="sr-only">{activeCount} active</span>
                  </button>
                ) : null}
                {inactiveCount > 0 ? (
                  <button
                    type="button"
                    className={`service-bar-segment is-inactive ${filter === "inactive" ? "is-selected" : ""}`}
                    style={{ width: `${(inactiveCount / totalCount) * 100}%` }}
                    onClick={() => setFilter(filter === "inactive" ? "all" : "inactive")}
                    title={`Inactive: ${inactiveCount} (${inactivePct}%) - Click to filter`}
                  >
                    <span className="sr-only">{inactiveCount} inactive</span>
                  </button>
                ) : null}
                {failedCount > 0 ? (
                  <button
                    type="button"
                    className={`service-bar-segment is-failed ${filter === "failed" ? "is-selected" : ""}`}
                    style={{ width: `${(failedCount / totalCount) * 100}%` }}
                    onClick={() => setFilter(filter === "failed" ? "all" : "failed")}
                    title={`Failed: ${failedCount} (${failedPct}%) - Click to filter`}
                  >
                    <span className="sr-only">{failedCount} failed</span>
                  </button>
                ) : null}
              </div>
              <div className="service-distribution-legend">
                <span className="legend-item tone-ok">
                  <span className="legend-dot" />
                  <strong>{activeCount}</strong> active ({activePct}%)
                </span>
                <span className="legend-item tone-inactive">
                  <span className="legend-dot" />
                  <strong>{inactiveCount}</strong> inactive ({inactivePct}%)
                </span>
                {failedCount > 0 ? (
                  <span className="legend-item tone-bad">
                    <span className="legend-dot" />
                    <strong>{failedCount}</strong> failed ({failedPct}%)
                  </span>
                ) : null}
                <span className="legend-item type-item">
                  <Cpu aria-hidden="true" />
                  <strong>{snapshot.summary.services}</strong> services
                </span>
                <span className="legend-item type-item">
                  <Clock3 aria-hidden="true" />
                  <strong>{snapshot.summary.timers}</strong> timers
                </span>
              </div>
            </div>

            {/* Interactive Filter Pills ("δεν δουλεύουν οι επιλογές") */}
            <div className="service-control-summary" role="toolbar" aria-label="Filter system services">
              <div className="service-filter-pills" role="radiogroup" aria-label="Service filters">
                <button
                  type="button"
                  className={`service-pill ${filter === "all" ? "is-selected" : ""}`}
                  onClick={() => setFilter("all")}
                  aria-pressed={filter === "all"}
                  title="Show all units"
                >
                  <strong>{snapshot.summary.total}</strong> units
                </button>
                <button
                  type="button"
                  className={`service-pill tone-ok ${filter === "active" ? "is-selected" : ""}`}
                  onClick={() => setFilter("active")}
                  aria-pressed={filter === "active"}
                  title="Filter to active units"
                >
                  <span className="pill-pulse-dot" aria-hidden="true" />
                  <strong>{snapshot.summary.active}</strong> active
                </button>
                <button
                  type="button"
                  className={`service-pill tone-inactive ${filter === "inactive" ? "is-selected" : ""}`}
                  onClick={() => setFilter("inactive")}
                  aria-pressed={filter === "inactive"}
                  title="Filter to inactive units"
                >
                  <strong>{snapshot.summary.inactive}</strong> inactive
                </button>
                {snapshot.summary.failed > 0 ? (
                  <button
                    type="button"
                    className={`service-pill tone-bad ${filter === "failed" ? "is-selected" : ""}`}
                    onClick={() => setFilter("failed")}
                    aria-pressed={filter === "failed"}
                    title="Filter to failed units"
                  >
                    <AlertTriangle aria-hidden="true" />
                    <strong>{snapshot.summary.failed}</strong> failed
                  </button>
                ) : null}
                <button
                  type="button"
                  className={`service-pill ${filter === "services" ? "is-selected" : ""}`}
                  onClick={() => setFilter("services")}
                  aria-pressed={filter === "services"}
                  title="Filter to services"
                >
                  <Cpu aria-hidden="true" />
                  <strong>{snapshot.summary.services}</strong> services
                </button>
                <button
                  type="button"
                  className={`service-pill ${filter === "timers" ? "is-selected" : ""}`}
                  onClick={() => setFilter("timers")}
                  aria-pressed={filter === "timers"}
                  title="Filter to timers"
                >
                  <Clock3 aria-hidden="true" />
                  <strong>{snapshot.summary.timers}</strong> timers
                </button>
                <button
                  type="button"
                  className={`service-pill ${filter === "enabled" ? "is-selected" : ""}`}
                  onClick={() => setFilter("enabled")}
                  aria-pressed={filter === "enabled"}
                  title="Filter to enabled units"
                >
                  <ShieldCheck aria-hidden="true" />
                  <strong>{snapshot.summary.enabled}</strong> enabled
                </button>
                <button
                  type="button"
                  className={`service-pill ${filter === "disabled" ? "is-selected" : ""}`}
                  onClick={() => setFilter("disabled")}
                  aria-pressed={filter === "disabled"}
                  title="Filter to disabled units"
                >
                  <strong>{snapshot.summary.disabled}</strong> disabled
                </button>
              </div>
              <span className="service-control-sampled">
                sampled {new Date(snapshot.sampledAt).toLocaleTimeString()}
              </span>
            </div>

            {/* Quick Search and Meta Bar */}
            <div className="service-control-search-bar">
              <div className="service-search-input-wrap">
                <Search aria-hidden="true" />
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Filter by unit name, description, target..."
                  aria-label="Filter units"
                />
                {search ? (
                  <button
                    type="button"
                    className="service-search-clear"
                    onClick={() => setSearch("")}
                    aria-label="Clear search"
                  >
                    <X aria-hidden="true" />
                  </button>
                ) : null}
              </div>
              <div className="service-search-meta">
                <span>
                  Showing <strong>{filteredUnits.length}</strong> of {units.length}
                </span>
                {isFiltered ? (
                  <button
                    type="button"
                    className="service-clear-filters"
                    onClick={() => {
                      setFilter("all");
                      setSearch("");
                    }}
                  >
                    Clear filters
                  </button>
                ) : null}
              </div>
            </div>

            {/* Notices and Alerts */}
            {notice ? (
              <div className="service-control-notice" role="status">
                <CheckCircle2 aria-hidden="true" />
                <span>{notice}</span>
                <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss">
                  <X aria-hidden="true" />
                </button>
              </div>
            ) : null}

            {error ? (
              <div className="service-control-error" role="alert">
                <CircleAlert aria-hidden="true" />
                <span>{error}</span>
              </div>
            ) : null}

            {/* Failed Services Banner & Action */}
            {failedCount > 0 ? (
              <div className="service-failed-banner" role="alert">
                <div className="service-failed-info">
                  <AlertTriangle aria-hidden="true" />
                  <span>
                    <strong>{failedCount}</strong> unit in failed state.
                  </span>
                </div>
                <button
                  type="button"
                  className="service-failed-reset-btn"
                  disabled={resetting || refreshing}
                  onClick={() => void handleResetFailed()}
                  title="Reset failed units state"
                >
                  <RotateCcw aria-hidden="true" className={resetting ? "is-spinning" : ""} />
                  {resetting ? "Resetting…" : "Reset Failed"}
                </button>
              </div>
            ) : null}

            {/* Main Scrollable Panel */}
            <div className="service-control-panel">
              {filteredUnits.length === 0 ? (
                <div className="service-control-empty" role="status">
                  No system services match the current filter.
                </div>
              ) : (
                <>
                  {filter === "all" && !search.trim() ? (
                    <>
                      {activeUnits.length > 0 ? (
                        <section className="service-control-group">
                          <h3>Active ({activeUnits.length})</h3>
                          <UnitTable
                            units={activeUnits}
                            expandedUnit={expandedUnit}
                            copiedUnit={copiedUnit}
                            onToggleExpand={(unit) =>
                              setExpandedUnit((prev) => (prev === unit ? null : unit))
                            }
                            onCopy={handleCopy}
                            onResetFailed={handleResetFailed}
                            resetting={resetting}
                          />
                        </section>
                      ) : null}

                      {inactiveUnits.length > 0 ? (
                        <section className="service-control-group">
                          <h3>Inactive ({inactiveUnits.length})</h3>
                          <UnitTable
                            units={inactiveUnits}
                            expandedUnit={expandedUnit}
                            copiedUnit={copiedUnit}
                            onToggleExpand={(unit) =>
                              setExpandedUnit((prev) => (prev === unit ? null : unit))
                            }
                            onCopy={handleCopy}
                            onResetFailed={handleResetFailed}
                            resetting={resetting}
                          />
                        </section>
                      ) : null}
                    </>
                  ) : (
                    <section className="service-control-group">
                      <UnitTable
                        units={filteredUnits}
                        expandedUnit={expandedUnit}
                        copiedUnit={copiedUnit}
                        onToggleExpand={(unit) =>
                          setExpandedUnit((prev) => (prev === unit ? null : unit))
                        }
                        onCopy={handleCopy}
                        onResetFailed={handleResetFailed}
                        resetting={resetting}
                      />
                    </section>
                  )}
                </>
              )}
            </div>
          </>
        ) : (
          <div className="service-control-empty" role="status">
            {error ? error : `Loading system services…`}
          </div>
        )}
      </section>
    </div>
  );
}

function UnitTable({
  units,
  expandedUnit,
  copiedUnit,
  onToggleExpand,
  onCopy,
  onResetFailed,
  resetting
}: {
  units: SystemServiceUnit[];
  expandedUnit: string | null;
  copiedUnit: string | null;
  onToggleExpand: (unit: string) => void;
  onCopy: (text: string) => Promise<void>;
  onResetFailed: (unit?: string) => Promise<void>;
  resetting: boolean;
}) {
  return (
    <div className="service-control-table" role="table" aria-label="System services list">
      <div className="service-control-row service-control-row-head" role="row">
        <span role="columnheader">Unit</span>
        <span role="columnheader">Type</span>
        <span role="columnheader">State</span>
        <span role="columnheader">Enabled</span>
        <span role="columnheader">Next run</span>
        <span role="columnheader" className="service-col-actions">Actions</span>
      </div>

      {units.map((unit) => {
        const isExpanded = expandedUnit === unit.unit;
        const nextRun = formatNextRun(unit);
        const isFailed = unit.activeState === "failed" || unit.subState === "failed";

        return (
          <div
            className={`service-unit-item ${isExpanded ? "is-expanded" : ""} ${isFailed ? "is-failed" : ""}`}
            key={unit.unit}
          >
            <div
              className="service-control-row"
              role="row"
              onClick={() => onToggleExpand(unit.unit)}
            >
              <span className="service-control-unit" role="cell">
                <span className="service-unit-title">
                  <span className="service-type-icon" aria-hidden="true">
                    {unit.type === "timer" ? <Clock3 /> : <Cpu />}
                  </span>
                  <span className="service-control-unit-name" title={unit.unit}>
                    {unit.unit}
                  </span>
                </span>
                <span className="service-control-unit-desc" title={unit.description ?? ""}>
                  {unit.description ?? ""}
                </span>
              </span>

              <span role="cell">
                <span className={`service-type-badge ${unit.type}`}>
                  {unit.type}
                </span>
              </span>

              <span role="cell">
                <span className={`service-control-state ${stateTone(unit)}`}>
                  <span className="state-pulse-dot" aria-hidden="true" />
                  {stateLabel(unit)}
                </span>
              </span>

              <span role="cell">
                <span className={`service-enabled-tag ${enabledBadgeTone(unit.unitFileState)}`}>
                  {enabledLabel(unit)}
                </span>
              </span>

              <span role="cell" className="service-next-run-cell">
                {unit.type === "timer" && nextRun ? (
                  <span className="next-run-wrap" title={nextRun.full}>
                    <span className="next-run-relative">{nextRun.relative}</span>
                    <span className="next-run-full">{nextRun.full}</span>
                  </span>
                ) : (
                  <span className="service-text-muted">—</span>
                )}
              </span>

              <span role="cell" className="service-row-actions">
                <button
                  type="button"
                  className="service-row-action-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    void onCopy(unit.unit);
                  }}
                  title={`Copy "${unit.unit}"`}
                  aria-label={`Copy ${unit.unit}`}
                >
                  {copiedUnit === unit.unit ? (
                    <Check aria-hidden="true" className="tone-ok" />
                  ) : (
                    <Copy aria-hidden="true" />
                  )}
                </button>

                {isFailed ? (
                  <button
                    type="button"
                    className="service-row-action-btn service-reset-action"
                    disabled={resetting}
                    onClick={(e) => {
                      e.stopPropagation();
                      void onResetFailed(unit.unit);
                    }}
                    title="Reset failed state"
                    aria-label={`Reset ${unit.unit}`}
                  >
                    <RotateCcw aria-hidden="true" />
                  </button>
                ) : null}

                <button
                  type="button"
                  className="service-row-action-btn service-expand-toggle"
                  aria-expanded={isExpanded}
                  title={isExpanded ? "Collapse details" : "Expand details"}
                  aria-label={`Toggle details for ${unit.unit}`}
                >
                  <ChevronRight aria-hidden="true" className={isExpanded ? "is-expanded" : ""} />
                </button>
              </span>
            </div>

            {/* Expandable Unit Details */}
            {isExpanded ? (
              <div
                className="service-unit-details"
                role="region"
                aria-label={`Details for ${unit.unit}`}
              >
                <div className="service-details-grid">
                  <div className="service-detail-item">
                    <span className="detail-label">Load State</span>
                    <span className="detail-value">{unit.loadState}</span>
                  </div>
                  <div className="service-detail-item">
                    <span className="detail-label">Active State</span>
                    <span className="detail-value">{unit.activeState}</span>
                  </div>
                  <div className="service-detail-item">
                    <span className="detail-label">Sub State</span>
                    <span className="detail-value">{unit.subState}</span>
                  </div>
                  <div className="service-detail-item">
                    <span className="detail-label">Unit File State</span>
                    <span className="detail-value">{unit.unitFileState ?? "—"}</span>
                  </div>

                  {unit.type === "timer" ? (
                    <>
                      <div className="service-detail-item detail-span-2">
                        <span className="detail-label">Activates Unit</span>
                        <span className="detail-value mono">{unit.timerActivates ?? "—"}</span>
                      </div>
                      <div className="service-detail-item">
                        <span className="detail-label">Next Scheduled Run</span>
                        <span className="detail-value">
                          {unit.timerNextElapse
                            ? new Date(unit.timerNextElapse).toLocaleString()
                            : "—"}
                        </span>
                      </div>
                      <div className="service-detail-item">
                        <span className="detail-label">Last Trigger</span>
                        <span className="detail-value">
                          {unit.timerLastTrigger
                            ? new Date(unit.timerLastTrigger).toLocaleString()
                            : "—"}
                        </span>
                      </div>
                    </>
                  ) : null}

                  <div className="service-detail-item detail-span-full service-cli-box">
                    <span className="detail-label">Terminal Status Command</span>
                    <div className="service-cli-snippet">
                      <code>systemctl status {unit.unit}</code>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          void onCopy(`systemctl status ${unit.unit}`);
                        }}
                      >
                        {copiedUnit === `systemctl status ${unit.unit}` ? "Copied" : "Copy"}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
