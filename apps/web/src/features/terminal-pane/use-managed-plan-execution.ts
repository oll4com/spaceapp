import { useEffect, useRef, useState } from "react";
import type { ManagedPlanExecution } from "@space/contracts";
import { ManagedPlanClient, type ManagedPlanApi } from "./managed-plan-client.js";
import { PLAN_EXECUTION_UPDATED_EVENT, type PlanExecutionUpdate } from "./plan-execution-events.js";

type ManagedPlanState = { execution: ManagedPlanExecution | null; error: string | null; pending: boolean };
const EMPTY_STATE: ManagedPlanState = { execution: null, error: null, pending: false };
// A room switch flips `enabled` on every pane of both rooms; an equal new object would render each pane once more.
const keepIfEqual = (next: ManagedPlanState) => (previous: ManagedPlanState) =>
  previous.execution === next.execution && previous.error === next.error && previous.pending === next.pending ? previous : next;

export function useManagedPlanExecution(input: { api: ManagedPlanApi; paneId: string; sessionId: string | null; enabled: boolean }) {
  const [state, setState] = useState<ManagedPlanState>(EMPTY_STATE);
  const clientRef = useRef<ManagedPlanClient | null>(null);
  const identityRef = useRef(input); identityRef.current = input;
  useEffect(() => {
    setState(keepIfEqual(EMPTY_STATE));
    if (!input.enabled || !input.sessionId) return;
    const client: ManagedPlanClient = new ManagedPlanClient(input.api, input.paneId, input.sessionId, () => {
      const latest = identityRef.current;
      if (clientRef.current !== client || !latest.enabled || latest.paneId !== client.paneId || latest.sessionId !== client.sessionId) return;
      setState(keepIfEqual({ execution: client.current, error: client.error, pending: client.pending > 0 }));
    }, () => {
      const latest = identityRef.current;
      return document.visibilityState !== "hidden" && latest.enabled && latest.paneId === client.paneId && latest.sessionId === client.sessionId;
    });
    clientRef.current = client;
    const refresh = (id?: string) => { if (document.visibilityState !== "hidden") void client.refresh(id).catch(() => {}); };
    // Warm W2: a room switch enables 16 panes at once; their first refetch waits for idle, off the switch frame.
    const idle = typeof window.requestIdleCallback === "function" ? window.requestIdleCallback(() => refresh(), { timeout: 1000 }) : undefined;
    const timer = idle === undefined ? window.setTimeout(() => refresh(), 250) : undefined;
    const updated = (event: Event) => {
      const detail = (event as CustomEvent<PlanExecutionUpdate>).detail;
      if (detail.paneId !== client.paneId) return;
      if (client.current?.id === detail.executionId && client.current.revision >= detail.revision) return;
      refresh(client.current?.id === detail.executionId ? detail.executionId : undefined);
    };
    const visible = () => { if (document.visibilityState !== "hidden") refresh(); };
    window.addEventListener(PLAN_EXECUTION_UPDATED_EVENT, updated);
    document.addEventListener("visibilitychange", visible);
    return () => {
      if (idle !== undefined) window.cancelIdleCallback(idle); else window.clearTimeout(timer);
      client.dispose(); if (clientRef.current === client) clientRef.current = null;
      window.removeEventListener(PLAN_EXECUTION_UPDATED_EVENT, updated);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [input.api, input.enabled, input.paneId, input.sessionId]);
  const getClient = () => {
    const client = clientRef.current;
    if (!client || !input.enabled || client.paneId !== input.paneId || client.sessionId !== input.sessionId) throw new Error("A visible current Codex or Claude Code session is required for managed plan controls.");
    return client;
  };
  return { ...state, getClient, refresh: () => getClient().refresh(),
    start: (plan: Parameters<ManagedPlanClient["start"]>[0]) => getClient().start(plan),
    override: (stage: string, selection: Parameters<ManagedPlanClient["override"]>[1]) => getClient().override(stage, selection),
    control: (action: "pause" | "resume") => getClient().control(action) };
}
