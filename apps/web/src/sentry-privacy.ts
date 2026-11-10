import { scrubSentryEvent } from "@space/contracts/sentry";

// Includes hidden/kept-alive panes and docks. Never start again on this document after one appears.
export const SENTRY_PRIVATE_SURFACES = '[data-pane-mode="TERMINAL"], [data-pane-mode="T3CODE"], [data-pane-mode="MAIL_COPILOT"], [data-dock-id*="vault"], [data-dock-id*="mail"], .vault-dock, .xterm, .mail-copilot-pane, .mc-client';
const privatePath = /(?:^|[/?#=&_-])(?:terminal|vault|mail|gmail|inbox|t3code)(?:[/?#=&_-]|$)/i;
export function replayForbidden(location: Pick<Location, "pathname" | "search" | "hash"> = window.location, root: ParentNode = document): boolean {
  return privatePath.test(location.pathname + location.search + location.hash) || Boolean(root.querySelector(SENTRY_PRIVATE_SURFACES));
}

export function createReplayGuard(onForbidden: () => void): { allowed(): boolean; close(): void } {
  let forbidden = replayForbidden();
  const deny = () => { if (!forbidden) { forbidden = true; onForbidden(); } };
  const allowed = () => { if (replayForbidden()) deny(); return !forbidden; };
  const observer = new MutationObserver((records) => {
    if (!allowed()) return;
    // Also catch a sensitive surface inserted and removed in the same render batch.
    for (const record of records) for (const node of [...record.addedNodes, ...record.removedNodes]) {
      if (node instanceof Element && (node.matches(SENTRY_PRIVATE_SURFACES) || node.querySelector(SENTRY_PRIVATE_SURFACES))) deny();
    }
  });
  if (!forbidden) observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-pane-mode", "data-dock-id"] });
  return { allowed, close: () => observer.disconnect() };
}

// Every navigation (plan clipboard:vK0t_Fa5yrBR step 11): one span each, spans stripped, against the sponsored plan's 1B spans.
export function webTraceSampleRate(name: string): number {
  return /health|readyz|livez|metrics|websocket|(?:^|\/)ws(?:\/|$)|poll|events|heartbeat/i.test(name) ? 0 : 1;
}

export function scrubWebTransaction<T extends object>(event: T): T | null {
  const raw = event as Record<string, unknown>;
  if (typeof raw.transaction !== "string" || webTraceSampleRate(raw.transaction) === 0) return null;
  const clean = scrubSentryEvent(event);
  return { ...clean, type: "transaction", transaction: "web.navigation", message: undefined,
    start_timestamp: typeof raw.start_timestamp === "number" ? raw.start_timestamp : undefined,
    transaction_info: { source: "custom" }, spans: [] };
}

/** Replay bypasses beforeSend. Keep structural DOM/timing only; never attribute values, URLs or text. */
export function scrubReplayRecording(value: unknown, key = ""): unknown {
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (typeof value === "string") {
    if (key === "tagName" && /^[a-z][a-z0-9-]*$/.test(value)) return value;
    return key === "href" ? "about:blank" : "[Filtered]";
  }
  if (Array.isArray(value)) return value.map((entry) => scrubReplayRecording(entry, key));
  if (typeof value !== "object" || !value) return undefined;
  const clean: Record<string, unknown> = {};
  for (const [field, entry] of Object.entries(value)) {
    if (field === "attributes") { clean[field] = {}; continue; }
    clean[field] = scrubReplayRecording(entry, field);
  }
  return clean;
}
