import { useEffect, useRef, useState } from "react";
import type {
  CliSessionStats,
  CodexEnvironment,
  CodexUsageAccountList,
  SystemAnalyticsModelsResponse,
  SystemHealthMetric,
  SystemHealthSeries,
  SystemHealthSnapshot,
} from "@space/contracts";
import { api } from "../../api.js";
import { getSpaceRuntimeKind } from "../../runtime/SpaceRuntime.js";
import {
  advanceHealthTone,
  computeCodexCooldown,
  numericHealthTone,
  type HealthThresholds,
  type ToneState,
  type HealthTone,
} from "./health-model.js";

export function useHealthTelemetry(
  active: boolean,
  detailed: boolean,
  initialEnvironment: CodexEnvironment | null,
  thresholds: HealthThresholds,
) {
  const [snapshot, setSnapshot] = useState<SystemHealthSnapshot | null>(null);
  const [environment, setEnvironment] = useState(initialEnvironment);
  const [models, setModels] = useState<SystemAnalyticsModelsResponse | null>(
    null,
  );
  const [accounts, setAccounts] = useState<CodexUsageAccountList | null>(null);
  const [sessions, setSessions] = useState<CliSessionStats | null>(null);
  const [rtt, setRtt] = useState<{
    value: number | null;
    failed: boolean;
    at: string;
  } | null>(null);
  const [error, setError] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const [history, setHistory] = useState<SystemHealthSeries[]>([]);
  const resourcesRef = useRef(
    new Map<string, { at: number; inFlight: boolean }>(),
  );
  const localSeries = useRef(new Map<string, SystemHealthSeries>());
  const mounted = useRef(false);
  const detailedRef = useRef(detailed);
  detailedRef.current = detailed;
  const accountsRef = useRef<CodexUsageAccountList | null>(null);
  accountsRef.current = accounts;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    setEnvironment(initialEnvironment);
  }, [initialEnvironment]);
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    const load = <T>(
      key: string,
      ttl: number,
      loader: () => Promise<T>,
      consume: (value: T) => void,
      failed?: () => void,
    ) => {
      const state = resourcesRef.current.get(key) ?? { at: 0, inFlight: false };
      if (state.inFlight || Date.now() - state.at < ttl) return;
      state.inFlight = true;
      resourcesRef.current.set(key, state);
      void loader()
        .then((value) => {
          if (mounted.current) consume(value);
        })
        .catch(() => {
          if (mounted.current) failed?.();
        })
        .finally(() => {
          state.inFlight = false;
          state.at = Date.now();
        });
    };
    const record = (metrics: SystemHealthMetric[]) => {
      const cutoff = Date.now() - 10 * 60_000;
      for (const metric of metrics) {
        const series = localSeries.current.get(metric.id) ?? {
          id: metric.id,
          label: metric.label,
          unit: metric.unit,
          points: [],
        };
        series.points = series.points.filter((p) => Date.parse(p.at) >= cutoff);
        if (
          metric.value !== null &&
          series.points.at(-1)?.at !== metric.sampledAt
        )
          series.points.push({
            at: metric.sampledAt,
            min: metric.value,
            avg: metric.value,
            max: metric.value,
          });
        localSeries.current.set(metric.id, {
          ...series,
          points: series.points.slice(-300),
        });
      }
      setHistory(
        [...localSeries.current.values()].map((s) => ({
          ...s,
          points: [...s.points],
        })),
      );
    };
    const sample = () => {
      if (disposed || document.visibilityState === "hidden") return;
      setClock(Date.now());
      load(
        "health",
        detailedRef.current ? 1500 : 9000,
        () => api.systemHealth(),
        (next) => {
          setSnapshot(next);
          setError(false);
          record(next.metrics);
        },
        () => setError(true),
      );
      load(
        "rtt",
        detailedRef.current ? 1500 : 9000,
        async () => {
          if (getSpaceRuntimeKind() === "demo") return 42;
          const start = performance.now();
          await api.healthPing();
          return Math.round(performance.now() - start);
        },
        (value) => {
          const at = new Date().toISOString();
          setRtt({ value, at, failed: false });
          record([
            {
              id: "rtt",
              label: "Connection latency",
              group: "network",
              unit: "MILLISECONDS",
              value,
              sampledAt: at,
              detail: "Browser to Space HTTP round trip",
            },
          ]);
        },
        () =>
          setRtt({ value: null, at: new Date().toISOString(), failed: true }),
      );
      load("sessions", 9000, () => api.toolbarCliSessions(), setSessions);
      load("models", 29_000, () => api.systemAnalyticsModels("10m"), setModels);
      const cooldown = computeCodexCooldown(accountsRef.current, environment, Date.now());
      if (cooldown && cooldown.secondsRemaining <= 0) {
        resourcesRef.current.delete("accounts");
      }
      const accountsTtl = cooldown ? 12_000 : 59_000;
      load("accounts", accountsTtl, () => api.toolbarUsageAccounts(), setAccounts);
      load("environment", 59_000, () => api.codexEnvironment(), setEnvironment);
    };
    sample();
    const timer = window.setInterval(sample, 2000);
    document.addEventListener("visibilitychange", sample);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", sample);
    };
  }, [active]);

  const tones = useRef(new Map<string, ToneState>());
  const previousThresholds = useRef(thresholds);
  if (previousThresholds.current !== thresholds) {
    tones.current.clear();
    previousThresholds.current = thresholds;
  }
  const metrics = [...(snapshot?.metrics ?? [])];
  if (rtt)
    metrics.push({
      id: "rtt",
      label: "Connection latency",
      group: "network",
      unit: "MILLISECONDS",
      value: rtt.value,
      sampledAt: rtt.at,
      detail: "Browser–Space HTTP round trip, including transport overhead",
    });
  const remaining = environment?.lbUsage?.allAccountsRemainingPercent ?? null;
  if (environment)
    metrics.push({
      id: "accounts",
      label: "Account remaining",
      group: "requests",
      unit: "PERCENT",
      value: remaining,
      sampledAt: environment.lbUsage?.checkedAt ?? environment.checkedAt,
      detail: "Remaining account capacity; low values trigger alerts",
      total: 100,
    });
  const stateFor = (metric: SystemHealthMetric): ToneState => {
    const ttl = metric.id === "accounts" ? 180_000 : 30_000;
    const isStale =
      clock - Date.parse(metric.sampledAt) > ttl ||
      (metric.id === "accounts" && Boolean(environment?.lbUsage?.error));
    const next =
      metric.id === "accounts" && environment?.isCodexEnabled === false
        ? "disabled"
        : isStale
          ? "stale"
          : numericHealthTone(metric.id, metric.value, thresholds);
    const state = advanceHealthTone(
      tones.current.get(metric.id),
      next,
      isStale ? `stale:${metric.sampledAt}` : metric.sampledAt,
    );
    tones.current.set(metric.id, state);
    return state;
  };
  const states = new Map(metrics.map((m) => [m.id, stateFor(m)]));
  const toneFor = (id: string): HealthTone =>
    id === "rtt" && rtt?.failed
      ? "critical"
      : (states.get(id)?.tone ?? "unavailable");
  return {
    snapshot,
    environment,
    models,
    accounts,
    sessions,
    rtt,
    error,
    clock,
    history,
    metrics,
    states,
    toneFor,
  };
}
export type HealthTelemetry = ReturnType<typeof useHealthTelemetry>;
