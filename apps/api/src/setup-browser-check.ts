import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { Pane } from "@space/contracts";
import type { SpaceStore } from "@space/runtime";
import type { BrowserSessionManagerWithHostHealth } from "./browser-host-proxy.js";
import type { SetupFunctionalChecks } from "./setup-production-actions.js";
import { browserProfilePathFor } from "./browser-sessions.js";

/** Owns one temporary proof room; uses existing bounded host actions, never shared-session shutdown. */
export function createSetupBrowserCheck(options: {
  store: SpaceStore; manager: BrowserSessionManagerWithHostHealth; origin: string; profileRoot: string;
}): NonNullable<SetupFunctionalChecks["pane:browser"]> {
  const origin = new URL(options.origin);
  if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password) {
    throw new Error("The configured Browser fixture origin is invalid.");
  }
  const actor = async (ownerId: string) => {
    const current = await options.store.getControlActor(ownerId);
    if (!current || !["ADMIN", "OPERATOR"].includes(current.role)) throw new Error("Browser setup requires an authorized owner.");
    return current;
  };
  return {
    fingerprint: async (ownerId) => {
      const current = await actor(ownerId);
      const health = await options.manager.browserHostHealth?.();
      if (!(health?.status ?? options.manager.status()).enabled) throw new Error("The Browser runtime is unavailable.");
      return createHash("sha256").update(JSON.stringify(["browser-fixture:v1", origin.origin, options.profileRoot,
        current.id, current.role, health?.buildCommit ?? null, health?.startedAt ?? null])).digest("hex");
    },
    exercise: async (ownerId) => {
      await actor(ownerId);
      const traceId = `setup-browser:${randomUUID()}`;
      const context = { holderType: "OPERATOR" as const, holderId: ownerId };
      const room = await options.store.createRoom({ name: "Agent Proof — Browser setup", kind: "AGENT_PROOF", initialPaneCount: 0 }, traceId, ownerId);
      let pane: Pane | undefined;
      try {
        pane = await options.store.createPane({ roomId: room.id, title: "Browser setup check", mode: "BROWSER" }, traceId);
        // Public, fixed, content-free fixture works through the existing web proxy. No login or workspace data.
        const target = new URL("/healthz", origin.origin);
        target.searchParams.set("setup-check", randomUUID());
        const started = await options.manager.startOrRestore({ pane, targetUrl: target.href, traceId,
          viewport: "desktop", includeInitialFrame: false }, context);
        const result = await options.manager.action(pane, { type: "extract_text", sessionId: started.session.sessionId }, traceId, context);
        if (result.session.paneId !== pane.id || result.session.roomId !== room.id || result.session.status !== "READY" ||
          result.session.currentUrl !== target.href || result.frame?.paneId !== pane.id ||
          result.frame.currentUrl !== target.href || !result.frame.screenshotDataUrl ||
          typeof result.text !== "string" || result.text.length > 1024) throw new Error("The Browser fixture did not render in its owned runtime.");
        let body: unknown;
        try { body = JSON.parse(result.text); } catch { throw new Error("The Browser fixture content is invalid."); }
        if (!body || typeof body !== "object" || Array.isArray(body) ||
          (body as { ok?: unknown }).ok !== true || (body as { service?: unknown }).service !== "space-api" ||
          Object.keys(body).length !== 2) throw new Error("The Browser fixture content did not match.");
      } finally {
        // Await the owned launch/stop before removing its profile; failed cleanup cannot produce a receipt.
        if (pane) {
          await options.manager.stopPane(pane.id, traceId, context);
          await rm(dirname(browserProfilePathFor(options.profileRoot, room.id, pane.id)), { recursive: true, force: true });
        }
        await options.store.deleteRoom(room.id);
      }
    }
  };
}
