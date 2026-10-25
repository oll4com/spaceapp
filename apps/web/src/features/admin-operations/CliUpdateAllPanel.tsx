import {
  type CliUpdateAllDetection,
  type CliUpdateAllEndpoint,
  type CliUpdateAllRequest,
  type CliUpdateAllResult
} from "@space/contracts";
import {
  AlertTriangle,
  ArrowRight,
  ArrowUp,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Loader2,
  Minus,
  RefreshCw,
  Search,
  ShieldCheck,
  Wrench,
  Zap
} from "../ui-theme/app-icons.js";
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import { errorMessage } from "./admin-operation-utils.js";
import { startCliUpdateRun, useCliUpdatePanelOpen, useCliUpdateRun } from "./cli-update-run.js";

export interface CliUpdateAllClient {
  detectCliUpdateAll(): Promise<CliUpdateAllDetection>;
  runCliUpdateAll(input: CliUpdateAllRequest): Promise<CliUpdateAllResult>;
}

type FilterTab = "all" | "updates" | "custom" | "managed";
type CheckStatus = CliUpdateAllResult["overallStatus"];

const FILTERS: ReadonlyArray<{ id: FilterTab; label: string; match: (entry: CliUpdateAllEndpoint) => boolean }> = [
  { id: "all", label: "All", match: () => true },
  { id: "updates", label: "Updates", match: (entry) => entry.updateAvailable === true },
  { id: "custom", label: "Custom", match: (entry) => entry.hasCustom },
  { id: "managed", label: "Managed", match: (entry) => entry.managed }
];

const statusTone: Record<CheckStatus, string> = { PASS: "ok", WARN: "warn", FAIL: "fail", SKIPPED: "muted" };
const statusIcon: Record<CheckStatus, typeof CheckCircle2> = {
  PASS: CheckCircle2,
  WARN: AlertTriangle,
  FAIL: CircleAlert,
  SKIPPED: Minus
};

function presentCustom(entry: { custom: CliUpdateAllEndpoint["custom"] }) {
  return entry.custom.filter((item) => item.present);
}

function versionState(entry: CliUpdateAllEndpoint): { tone: string; label: string } {
  if (entry.updateAvailable) return { tone: "warn", label: "Update available" };
  if (!entry.managed) return { tone: "muted", label: "Standalone" };
  if (!entry.installedVersion) return { tone: "muted", label: "Not installed" };
  if (!entry.availableVersion) return { tone: "muted", label: "Latest unknown" };
  return { tone: "ok", label: "Up to date" };
}

function toggled(set: ReadonlySet<string>, key: string): ReadonlySet<string> {
  const next = new Set(set);
  if (!next.delete(key)) next.add(key);
  return next;
}

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function clock(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function StatusIcon({ status }: { status: CheckStatus }) {
  const Icon = statusIcon[status];
  return <Icon className={`cli-upd-status-icon ${statusTone[status]}`} aria-hidden="true" />;
}

export function CliUpdateAllPanel({
  client,
  onBusyChange,
  onMinimize
}: {
  client: CliUpdateAllClient;
  onBusyChange: (busy: boolean) => void;
  /** Hides the window while the run goes on; the minimized bar brings it back. */
  onMinimize?: () => void;
}) {
  useCliUpdatePanelOpen();
  const run = useCliUpdateRun();
  const running = run && !run.finished ? run : null;
  const result = run?.result ?? null;
  const [detection, setDetection] = useState<CliUpdateAllDetection | null>(null);
  const [loading, setLoading] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [loadError, setLoadError] = useState<string | null>(null);
  const error = loadError ?? (run?.finished ? run.error : null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [reinstall, setReinstall] = useState(true);
  const [filterTab, setFilterTab] = useState<FilterTab>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const mountedRef = useRef(true);
  const loadingRef = useRef(false);
  const resultRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (result && resultRef.current && typeof resultRef.current.scrollIntoView === "function") {
      resultRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [result]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    setLoadError(null);
    try {
      const detectionValue = await client.detectCliUpdateAll();
      if (!Array.isArray(detectionValue?.cliTypes)) throw new Error("Update detection returned no CLI list.");
      if (mountedRef.current) setDetection(detectionValue);
    } catch (reason) {
      if (mountedRef.current) setLoadError(errorMessage(reason, "Custom procedure detection could not be loaded."));
    } finally {
      loadingRef.current = false;
      if (mountedRef.current) setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  // A finished update changes the installed versions.
  useEffect(() => {
    if (run?.finished) void load();
  }, [load, run?.finished]);

  useEffect(() => {
    onBusyChange(running !== null);
  }, [onBusyChange, running]);

  // Updates take minutes and the API answers only at the end: a live elapsed time shows the run is alive.
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  const cliTypes = useMemo(() => detection?.cliTypes ?? [], [detection]);
  const managedTypes = useMemo(() => cliTypes.filter((entry) => entry.managed), [cliTypes]);
  const customTypes = useMemo(() => cliTypes.filter((entry) => entry.hasCustom), [cliTypes]);
  const presentCustomCount = useMemo(
    () => customTypes.reduce((total, entry) => total + presentCustom(entry).length, 0),
    [customTypes]
  );
  // What the one-click update installs: managed, already installed, newer version available.
  const pendingUpdates = useMemo(
    () => cliTypes.filter((entry) => entry.updateAvailable && entry.managed && entry.installedVersion),
    [cliTypes]
  );
  const allSelected = managedTypes.length > 0 && managedTypes.every((entry) => selected.has(entry.key));

  const filteredCliTypes = useMemo(() => {
    const filter = FILTERS.find((item) => item.id === filterTab) ?? FILTERS[0]!;
    const query = searchQuery.toLowerCase().trim();
    return cliTypes.filter((entry) =>
      filter.match(entry) &&
      (!query || [entry.displayName, entry.key, entry.cliType].some((value) => value.toLowerCase().includes(query)))
    );
  }, [cliTypes, filterTab, searchQuery]);

  function toggleSelectAll() {
    setSelected(allSelected ? new Set() : new Set(managedTypes.map((entry) => entry.key)));
  }

  function runUpdateAll(keys: string[], label: string, forceReinstall = false) {
    const input: CliUpdateAllRequest = reinstall || forceReinstall ? { reinstall: true } : {};
    if (keys.length > 0) input.keys = keys as NonNullable<CliUpdateAllRequest["keys"]>;
    setNow(Date.now());
    setLoadError(null);
    void startCliUpdateRun((value) => client.runCliUpdateAll(value), input, label);
  }

  const busy = loading || running !== null;
  const elapsedSeconds = running ? Math.max(0, Math.floor((now - running.startedAt) / 1000)) : 0;
  const heroTone = !detection ? (error ? "fail" : "muted") : pendingUpdates.length > 0 ? "warn" : "ok";
  const HeroIcon = !detection ? (error ? CircleAlert : Loader2) : pendingUpdates.length > 0 ? ArrowUp : CheckCircle2;

  return (
    <div className="admin-operation-panel cli-upd">
      <section className={`cli-upd-hero ${heroTone}`} aria-label="Recommended update" aria-busy={running !== null}>
        <span className="cli-upd-hero-icon">
          <HeroIcon className={!detection && !error ? "spin" : undefined} aria-hidden="true" />
        </span>
        <div className="cli-upd-hero-text">
          <strong role={detection ? undefined : "status"}>
            {!detection
              ? loading ? "Checking every CLI for updates…" : "Update status is unavailable."
              : pendingUpdates.length === 0
                ? "All managed CLIs are up to date"
                : `${plural(pendingUpdates.length, "update")} available`}
          </strong>
          {detection ? (
            <small>
              Checked {clock(detection.detectedAt)} · {plural(cliTypes.length, "CLI type")} ·{" "}
              {plural(presentCustomCount, "custom procedure")} protected in {plural(customTypes.length, "CLI")}
            </small>
          ) : null}
        </div>
        <div className="cli-upd-hero-actions">
          <button
            type="button"
            className="cli-upd-icon-button"
            aria-label="Check for updates"
            title="Check every CLI for updates again"
            disabled={busy}
            onClick={() => void load()}
          >
            <RefreshCw className={loading ? "spin" : undefined} aria-hidden="true" />
          </button>
          {pendingUpdates.length > 0 ? (
            <button
              type="button"
              className="cli-upd-button primary"
              disabled={busy}
              onClick={() => runUpdateAll(
                pendingUpdates.map((entry) => entry.key),
                pendingUpdates.map((entry) => entry.displayName).join(", "),
                true
              )}
            >
              {running ? <Loader2 className="spin" aria-hidden="true" /> : <ArrowUp aria-hidden="true" />}
              {running ? "Updating…" : `Update ${plural(pendingUpdates.length, "CLI")}`}
            </button>
          ) : null}
        </div>
        {pendingUpdates.length > 0 ? (
          <ul className="cli-upd-pending" aria-label="Pending updates">
            {pendingUpdates.map((entry) => (
              <li key={entry.key}>
                <strong>{entry.displayName}</strong>
                <span>{entry.installedVersion} → {entry.availableVersion}</span>
              </li>
            ))}
          </ul>
        ) : null}
        <p className="cli-upd-hero-note">
          <ShieldCheck aria-hidden="true" />
          <span>
            Custom code stays: patches, installers and Space config are fingerprinted before and after, Space settings
            and MCP are re-applied, patched CLIs only receive their patched line, and a failed update rolls back.
          </span>
        </p>
      </section>

      {running ? (
        <p className="admin-operation-running" role="status" aria-live="assertive">
          <Loader2 className="spin" aria-hidden="true" />
          <span>
            <strong>
              Updating {running.label} · {Math.floor(elapsedSeconds / 60)}:{String(elapsedSeconds % 60).padStart(2, "0")}
            </strong>
            <small>Each CLI is staged, verified and activated, then its custom procedures are checked. You can minimize this window: the update keeps running and you get a notification when it ends.</small>
          </span>
          {onMinimize ? (
            <button type="button" className="cli-upd-button" title="Keep updating in the background" onClick={onMinimize}>
              <Minus aria-hidden="true" />
              Minimize
            </button>
          ) : null}
        </p>
      ) : null}

      {error ? <p className="admin-operation-alert error" role="alert">{error}</p> : null}

      {result ? <UpdateResult result={result} sectionRef={resultRef} /> : null}

      <section className="cli-upd-catalog" aria-label="All CLI types">
        <div className="cli-upd-toolbar">
          <div className="cli-upd-tabs" role="tablist" aria-label="CLI filter tabs">
            {FILTERS.map((filter) => (
              <button
                key={filter.id}
                type="button"
                role="tab"
                aria-selected={filterTab === filter.id}
                className={filterTab === filter.id ? "active" : undefined}
                onClick={() => setFilterTab(filter.id)}
              >
                {filter.label}
                <span className={filter.id === "updates" && pendingUpdates.length > 0 ? "count warn" : "count"}>
                  {cliTypes.filter(filter.match).length}
                </span>
              </button>
            ))}
          </div>
          {/* A div, not a label: the global "label input" rule would draw a second box. */}
          <div className="cli-upd-search">
            <Search aria-hidden="true" />
            <input
              type="search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Filter CLIs…"
              aria-label="Filter CLIs"
            />
          </div>
        </div>

        {filteredCliTypes.length === 0 ? (
          <p className="cli-upd-empty">{detection ? "No CLI types match the current filter." : "Loading CLI types…"}</p>
        ) : (
          <ul className="cli-upd-list">
            {filteredCliTypes.map((entry) => {
              const customs = presentCustom(entry);
              const state = versionState(entry);
              return (
                <li
                  key={entry.cliType}
                  className={[
                    "cli-upd-row",
                    selected.has(entry.key) ? "is-selected" : "",
                    entry.managed ? "" : "is-unmanaged"
                  ].join(" ").trim()}
                >
                  <SpaceToggle
                    compact
                    id={`cli-update-all-${entry.key}`}
                    className="cli-upd-row-toggle"
                    name={`cli-update-all-${entry.key}`}
                    ariaLabel={entry.displayName}
                    label={
                      <span className="cli-upd-row-name">
                        <strong>{entry.displayName}</strong>
                        <code>{entry.key}</code>
                        {entry.enabled ? null : <span className="cli-upd-tag muted">Disabled</span>}
                      </span>
                    }
                    title={entry.managed ? undefined : "Managed outside Space updates"}
                    checked={selected.has(entry.key)}
                    disabled={running !== null || !entry.managed}
                    onChange={() => setSelected((previous) => toggled(previous, entry.key))}
                  />
                  <span className="cli-upd-row-version">
                    <code>{entry.installedVersion ? `v${entry.installedVersion}` : "—"}</code>
                    {entry.updateAvailable && entry.availableVersion ? (
                      <>
                        <ArrowRight aria-hidden="true" />
                        <code className="next">{`v${entry.availableVersion}`}</code>
                      </>
                    ) : null}
                  </span>
                  <span className={`cli-upd-tag ${state.tone}`}>
                    {state.tone === "ok" ? <Check aria-hidden="true" /> : state.tone === "warn" ? <ArrowUp aria-hidden="true" /> : null}
                    {state.label}
                  </span>
                  {customs.length > 0 ? (
                    <button
                      type="button"
                      className="cli-upd-custom"
                      aria-expanded={expanded.has(entry.key)}
                      aria-controls={`cli-update-all-custom-${entry.key}`}
                      title="Show the custom procedures kept for this CLI"
                      onClick={() => setExpanded((previous) => toggled(previous, entry.key))}
                    >
                      <ShieldCheck aria-hidden="true" />
                      {customs.length} custom
                      <ChevronDown className="chevron" aria-hidden="true" />
                    </button>
                  ) : (
                    <span className="cli-upd-custom none">Standard</span>
                  )}
                  {customs.length > 0 && expanded.has(entry.key) ? (
                    <ul id={`cli-update-all-custom-${entry.key}`} className="cli-upd-custom-list">
                      {customs.map((item) => (
                        <li key={item.path}>
                          <span className="cli-upd-kind">{item.kind}</span>
                          <span>{item.label}</span>
                          <code title={item.path}>{item.path}</code>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <footer className="cli-upd-footer">
        <SpaceToggle
          compact
          id="cli-update-all-select-all"
          name="cli-update-all-select-all"
          ariaLabel="Select all managed CLI types"
          label={`${selected.size} of ${managedTypes.length} selected`}
          checked={allSelected}
          disabled={running !== null || managedTypes.length === 0}
          onChange={toggleSelectAll}
        />
        <SpaceToggle
          compact
          id="cli-update-all-reinstall"
          name="cli-update-all-reinstall"
          ariaLabel="Reinstall custom procedures after update"
          label="Re-apply custom procedures"
          title="Verify each detected patch and safely restore tracked config/MCP overlays after the update."
          checked={reinstall}
          disabled={running !== null}
          onChange={setReinstall}
        />
        <span className="cli-upd-footer-actions">
          <button
            type="button"
            className="cli-upd-button"
            aria-label="Update all"
            title="Run the guarded update for every managed CLI type, including disabled ones"
            disabled={busy || !detection}
            onClick={() => runUpdateAll([], "every managed CLI type")}
          >
            <Zap aria-hidden="true" />
            Update all
          </button>
          <button
            type="button"
            className="cli-upd-button primary"
            aria-label={`Update selected (${selected.size})`}
            disabled={busy || !detection || selected.size === 0}
            onClick={() => runUpdateAll(
              Array.from(selected),
              cliTypes.filter((entry) => selected.has(entry.key)).map((entry) => entry.displayName).join(", ")
            )}
          >
            <Wrench aria-hidden="true" />
            Update selected ({selected.size})
          </button>
        </span>
      </footer>
    </div>
  );
}

function UpdateResult({
  result,
  sectionRef
}: {
  result: CliUpdateAllResult;
  sectionRef: RefObject<HTMLElement | null>;
}) {
  const customCounts = new Map(
    (result.customSummary ?? []).map((entry) => [`cli:${entry.key}`, presentCustom(entry).length])
  );
  let customTotal = 0;
  let customKept = 0;
  for (const runtime of result.runtimes) {
    const count = customCounts.get(runtime.runtimeId) ?? 0;
    customTotal += count;
    if (runtime.customPreserved) customKept += count;
  }
  const updated = result.runtimes.filter((runtime) => runtime.code.startsWith("UPDATED")).length;
  const failed = result.runtimes.filter((runtime) => runtime.status === "FAIL").length;
  const headline = result.overallStatus === "FAIL"
    ? "Update finished with failures"
    : result.overallStatus === "WARN" ? "Update finished with warnings" : "Update finished";

  return (
    <section
      ref={sectionRef}
      className={`cli-upd-result ${statusTone[result.overallStatus]}`}
      aria-label="Update-all result"
    >
      <header>
        <StatusIcon status={result.overallStatus} />
        <span>
          <strong>{headline}</strong>
          <small>
            {updated} updated · {failed} failed · {result.runtimes.length} checked · finished {clock(result.finishedAt)}
          </small>
        </span>
      </header>
      {customTotal > 0 ? (
        <p className={`cli-upd-result-custom ${customKept === customTotal ? "ok" : "fail"}`}>
          {customKept === customTotal ? <ShieldCheck aria-hidden="true" /> : <CircleAlert aria-hidden="true" />}
          {customKept} of {plural(customTotal, "custom procedure")} verified unchanged
          {result.reinstall ? " · Space config and MCP re-applied" : ""}
        </p>
      ) : null}
      <ul>
        {result.runtimes.map((runtime) => {
          const customCount = customCounts.get(runtime.runtimeId) ?? 0;
          const from = runtime.installedVersion;
          const to = runtime.availableVersion;
          return (
            <li key={runtime.runtimeId} className={statusTone[runtime.status]}>
              <StatusIcon status={runtime.status} />
              <strong>{runtime.displayName}</strong>
              {/* Only an update moves the version; a kept or rolled-back CLI shows the version it stays on. */}
              <code>{runtime.code.startsWith("UPDATED") && from && to && from !== to ? `${from} → ${to}` : (from ?? to ?? "")}</code>
              <small>
                {runtime.summary}
                {runtime.errorMessage ? ` ${runtime.errorMessage}` : ""}
              </small>
              {customCount > 0 ? (
                <span className={`cli-upd-tag ${runtime.customPreserved ? "ok" : "fail"}`}>
                  {runtime.customPreserved ? <ShieldCheck aria-hidden="true" /> : <CircleAlert aria-hidden="true" />}
                  {runtime.customPreserved ? `${customCount} custom kept` : "Custom changed"}
                </span>
              ) : null}
              {runtime.reinstallResults?.length ? (
                <details className="cli-upd-checks">
                  <summary>
                    {plural(runtime.reinstallResults.length, "custom check")}
                    <ChevronDown className="chevron" aria-hidden="true" />
                  </summary>
                  <ul>
                    {runtime.reinstallResults.map((check) => (
                      <li key={`${check.kind}:${check.path}`}>
                        <StatusIcon status={check.status} />
                        <span>{check.message}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
