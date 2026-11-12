import { createHmac, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SPACE_AGENT_HOME, SPACE_INSTALL_ROOT, type ClipboardItem } from "@space/contracts";
import type { SpaceStore } from "@space/runtime";

// Outbound events SpaceApp → Make (plan clipboard:F1nJVLcoWdd- step 3). Off unless SPACE_MAKE_WEBHOOKS_ENABLED=true on this instance AND the
// scenario's URL file and the signing secret are in the secrets folder (installed from the Vault, see nous-programs.md); a missing file sends nothing.
// Each of the plan's three first scenarios has its own Make webhook: the job-applications sheet, the programs registry, the phone push.
export type MakeEvent = "done" | "plan.completed" | "program.approved" | "job_application.status" | "appointment";
export const makeEventTarget: Record<MakeEvent, "jobs" | "programs" | "push"> = {
  "job_application.status": "jobs", "program.approved": "programs", done: "push", "plan.completed": "push", appointment: "push"
};
// A webhook file can only point at a Make hook host, so a planted file cannot send the operator's events elsewhere.
const makeHookUrl = /^https:\/\/hook\.(eu|us)[12]\.make\.(com|celonis\.com)\/[A-Za-z0-9]+$/;
const DAY = 24 * 60 * 60_000;

export type MakeWebhookDeps = {
  instance: string;
  /** Only the operator's (ADMIN) events leave the server; another account's never do. */
  allow: (owner: string) => Promise<boolean>;
  /** Tests only; by default `${SPACE_INSTALL_ROOT}/secrets/space-<name>`, then `${SPACE_AGENT_HOME}/.config/space/<name>` (as the Make relay). */
  dir?: string;
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Waits before each retry of a network error, 429 or 5xx; another 4xx is not retried. */
  retryDelays?: number[];
  log?: (message: string) => void;
};

export function createMakeWebhooks(deps: MakeWebhookDeps) {
  const { dir, fetch = globalThis.fetch, retryDelays = [2_000, 10_000, 60_000, 300_000], log = () => undefined } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref()));
  // shortcut: dedupe and retries live in memory (several writers report the same plan, status or appointment; a restart drops pending retries),
  // move them to a durable outbox if Make must never miss an event. 24 h is the dedupe window.
  const sent = new Map<string, number>();
  // The API runs as `space`, whose home is the install root and who cannot read the agent's ~/.config: the secrets folder is the one it reads.
  const read = async (name: string) => {
    for (const file of dir ? [join(dir, name)] : [join(SPACE_INSTALL_ROOT, "secrets", `space-${name}`), join(SPACE_AGENT_HOME, ".config/space", name)]) {
      const text = (await readFile(file, "utf8").catch(() => "")).trim();
      if (text) return text;
    }
    return "";
  };

  /** Sends one event once per key; never throws. Resolves when delivered, refused or given up. */
  return async function emit(owner: string, event: MakeEvent, key: string, data: Record<string, unknown>): Promise<void> {
    try {
      const now = Date.now();
      for (const [seen, at] of sent) if (now - at > DAY) sent.delete(seen);
      const dedupe = `${owner}:${event}:${key}`;
      if (sent.has(dedupe) || !await deps.allow(owner)) return;
      const [url, secret] = await Promise.all([read(`make-webhook-${makeEventTarget[event]}.url`), read("make-webhook.secret")]);
      if (!url || !secret) return;
      if (!makeHookUrl.test(url)) return log(`Make webhook ${makeEventTarget[event]}: the URL file is not a Make hook address; nothing sent.`);
      sent.set(dedupe, now);
      const id = randomUUID();
      const timestamp = String(Math.floor(now / 1000));
      const body = JSON.stringify({ event, id, occurredAt: new Date(now).toISOString(), instance: deps.instance, data });
      const headers = {
        "content-type": "application/json", "x-space-event": event, "x-space-delivery": id, "x-space-timestamp": timestamp,
        // Make checks it with sha256(timestamp + "." + body; "hex"; secret) in a filter.
        "x-space-signature": `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`
      };
      for (let attempt = 0; ; attempt += 1) {
        const status = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(30_000) }).then((response) => response.status, () => 0);
        if (status >= 200 && status < 300) return;
        const retry = status === 0 || status === 429 || status >= 500;
        if (!retry || attempt >= retryDelays.length) return log(`Make webhook ${event} ${id}: ${status || "network error"}, ${retry ? "gave up" : "refused"}.`);
        await sleep(retryDelays[attempt]!);
      }
    } catch (error) {
      log(`Make webhook ${event}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}

type Emit = ReturnType<typeof createMakeWebhooks>;
let current: Emit | null = null;
const enabled = () => process.env.SPACE_MAKE_WEBHOOKS_ENABLED === "true";
/** Set once the instance turns the bridge on; until then every emit is a no-op. */
export function setMakeWebhooks(emit: Emit | null) { current = emit; }
/** Fire and forget: a writer never waits on Make or sees its failure. */
export function emitMakeEvent(owner: string, event: MakeEvent, key: string, data: Record<string, unknown>) {
  if (current) void current(owner, event, key, data);
}

/** Wraps one method of a repository or store object in place, so every caller holding it reports what it wrote. */
export function afterWrite<T extends object, K extends keyof T>(target: T, method: K, report: (result: Awaited<ReturnType<Extract<T[K], (...args: never[]) => unknown>>>, args: Parameters<Extract<T[K], (...args: never[]) => unknown>>) => void) {
  if (!enabled()) return; // the bridge is off: leave the object as it is
  const original = (target[method] as (...args: unknown[]) => Promise<unknown>).bind(target);
  (target as Record<K, unknown>)[method] = async (...args: unknown[]) => {
    const result = await original(...args);
    try { report(result as never, args as never); } catch { /* reporting never fails the write */ }
    return result;
  };
}

/** The instance's sender (off unless SPACE_MAKE_WEBHOOKS_ENABLED=true), and PLAN completion through its checkbox or its progress reaching
 * 100 % (every route, Nous and Space Control call these two store methods). */
export function startMakeWebhooks(store: SpaceStore, instance: string) {
  setMakeWebhooks(enabled() ? createMakeWebhooks({
    instance, allow: async (owner) => (await Promise.resolve(store.getControlActor(owner)).catch(() => null))?.role === "ADMIN"
  }) : null);
  const planCompleted = (item: ClipboardItem | null, owner: string) => {
    if (item?.source === "PLAN" && item.isCompleted) emitMakeEvent(owner, "plan.completed", item.id, { planId: item.id, title: item.title });
  };
  afterWrite(store, "setClipboardItemCompleted", (item, [owner]) => planCompleted(item, owner));
  afterWrite(store, "updateClipboardItemProgress", (item, [owner]) => planCompleted(item, owner));
}
