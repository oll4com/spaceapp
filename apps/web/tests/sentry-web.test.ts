import { afterEach, describe, expect, it, vi } from "vitest";
import * as Sentry from "@sentry/react";
import { createReplayGuard, replayForbidden, scrubWebTransaction, webTraceSampleRate } from "../src/sentry-privacy.js";
import { initializeWebSentry, privateReplayEnvelope } from "../src/sentry-web.js";
import { scrubSentryEvent } from "@space/contracts/sentry";

afterEach(async () => { await Sentry.close(); document.body.innerHTML = ""; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("opt-in web Sentry", () => {
  it("does not request the lazy module without a DSN, and initializes only once with one", async () => {
    const { startWebSentry, captureWebError } = await import("../src/sentry-bootstrap.js");
    const capture = vi.fn();
    const initialize = vi.fn(() => ({ capture }));
    const load = vi.fn(async () => ({ initializeWebSentry: initialize }));
    startWebSentry(undefined, load);
    startWebSentry({ dsn: " ", environment: "dev" }, load);
    captureWebError(new Error("private"));
    expect(load).not.toHaveBeenCalled();
    const config = { dsn: "https://public@example.com/1", environment: "dev" as const };
    startWebSentry(config, load);
    startWebSentry(config, load);
    captureWebError(new Error("synthetic"));
    await Promise.resolve(); await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(1);
    expect(initialize).toHaveBeenCalledWith(config);
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1));
  });

  it("scrubs a synthetic error through the real browser SDK before transport", async () => {
    document.body.innerHTML = '<div data-pane-mode="TERMINAL"></div>';
    const sent: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
      sent.push(String(init.body));
      return { status: 200, headers: new Headers() };
    }));
    const reporter = initializeWebSentry({ dsn: "https://public@example.com/1", release: "a".repeat(40), environment: "dev" });
    const client = Sentry.getClient<Sentry.BrowserClient>()!;
    expect(client.getOptions()).toMatchObject({ sendDefaultPii: false });
    expect(client.getOptions().replaysSessionSampleRate).toBe(0);
    expect(client.getOptions().replaysOnErrorSampleRate).toBe(1);
    expect(client.getIntegrationByName("Replay")).toBeUndefined();
    expect(client.getIntegrationByName("GlobalHandlers")).toBeUndefined();
    const scrubbed = await client.getOptions().beforeSend!({ type: undefined, tags: { replayId: "a".repeat(32), vault: "VAULT_SECRET" } }, {});
    expect(scrubbed?.tags).toEqual({ service: "web" });
    Sentry.setUser({ ip_address: "192.0.2.1", email: "private@example.org" });
    Sentry.setContext("vault", { value: "VAULT_SECRET", prompt: "PROMPT_SECRET", mail: "MAIL_SECRET" });
    Sentry.addBreadcrumb({ category: "http", message: "COOKIE_SECRET", data: { Authorization: "Bearer AUTH_SECRET", token: "TOKEN_SECRET" } });
    const error = new Error("MAIL_SECRET PROMPT_SECRET");
    error.stack = 'Error: MAIL_SECRET\n    at render (https://space.example/assets/app-123.js?token=TOKEN_SECRET:10:4)';
    reporter!.capture(error);
    await Sentry.flush(2000);
    expect(sent.length).toBeGreaterThan(0);
    const payload = sent.join("\n");
    expect(payload).not.toMatch(/VAULT_SECRET|PROMPT_SECRET|MAIL_SECRET|COOKIE_SECRET|AUTH_SECRET|TOKEN_SECRET|192\.0\.2\.1|private@example/);
    expect(payload).toContain('[Filtered]');
    expect(payload).toContain('app:///assets/app-123.js');
  });

  it.each(['data-pane-mode="TERMINAL"', 'data-pane-mode="T3CODE"', 'data-pane-mode="MAIL_COPILOT"', 'data-dock-id="vault"', 'data-dock-id="mail"'])("denies Replay for hidden %s and permanently after removal", async (attribute) => {
    const stop = vi.fn(); const guard = createReplayGuard(stop);
    expect(guard.allowed()).toBe(true);
    document.body.innerHTML = `<section hidden ${attribute}></section>`;
    expect(guard.allowed()).toBe(false);
    document.body.innerHTML = "";
    await Promise.resolve();
    expect(guard.allowed()).toBe(false);
    expect(stop).toHaveBeenCalledTimes(1);
    guard.close();
  });

  it("catches a private pane inserted and removed in one mutation batch", async () => {
    const guard = createReplayGuard(vi.fn());
    const pane = document.createElement("section"); pane.dataset.paneMode = "TERMINAL";
    document.body.append(pane); pane.remove(); await Promise.resolve();
    expect(guard.allowed()).toBe(false); guard.close();
  });

  it.each(["/terminal", "/vault", "/mail/inbox", "/rooms?dock=vault"])("denies private URL %s", (path) => {
    expect(replayForbidden(new URL(path, "https://example.com"))).toBe(true);
  });

  it("scrubs Replay metadata and DOM at transport, fixes length, and drops forbidden recordings", () => {
    type Envelope = Parameters<typeof privateReplayEnvelope>[0];
    const recording = JSON.stringify({ segment_id: 0 }) + '\n' + JSON.stringify([{ type: 2, data: { node: { tagName: "div", attributes: { title: "VAULT_SECRET" }, textContent: "MAIL_SECRET" } } }]);
    const envelope = [{ trace: { transaction: "PROMPT_SECRET" } }, [
      [{ type: "replay_event" }, { replay_id: "a".repeat(32), segment_id: 0, urls: ["https://private"], user: { ip_address: "192.0.2.1" } }],
      [{ type: "replay_recording", length: 1 }, recording]
    ]] as unknown as Envelope;
    expect(privateReplayEnvelope(envelope, false)).toBeNull();
    const clean = privateReplayEnvelope(envelope, true)!;
    expect(JSON.stringify(clean)).not.toMatch(/VAULT_SECRET|MAIL_SECRET|PROMPT_SECRET|https:\/\/private|192\.0\.2\.1/);
    expect(clean[1][1]![0]).toMatchObject({ length: new TextEncoder().encode(String(clean[1][1]![1])).length });
    const corrupt = [envelope[0], [[{ type: "replay_recording" }, new Uint8Array([0, 255])]]] as unknown as Envelope;
    expect(privateReplayEnvelope(corrupt, true)).toBeNull();
  });

  it("samples every navigation, excludes background endpoints and strips transaction spans", () => {
    for (const name of ["/healthz", "/metrics", "/ws", "/websocket", "/poll", "/events", "/heartbeat"]) {
      expect(webTraceSampleRate(name)).toBe(0);
      expect(scrubWebTransaction({ transaction: name })).toBeNull();
    }
    expect(webTraceSampleRate("/rooms")).toBe(1);
    expect(scrubWebTransaction({ transaction: "/rooms?token=secret", spans: [{ description: "mail" }], request: { cookies: "secret" } })).toMatchObject({ transaction: "web.navigation", spans: [] });
  });

  it("preserves only validated sourcemap debug IDs and sanitized code paths", () => {
    const result = scrubSentryEvent({ debug_meta: { images: [
      { debug_id: "11111111-2222-3333-4444-555555555555", code_file: "https://private.example/assets/main-ab.js?token=secret" },
      { debug_id: "secret", code_file: "/assets/main-ab.js" }
    ] } });
    expect(result.debug_meta.images).toEqual([{ type: "sourcemap", debug_id: "11111111-2222-3333-4444-555555555555", code_file: "app:///assets/main-ab.js" }]);
  });
});
