// This entire module (including the SDK) is a separate chunk, requested only after an explicit DSN.
import * as Sentry from "@sentry/react";
import { initSpaceSentry, type SpaceSentryConfig } from "@space/contracts/sentry";
import { createReplayGuard, replayForbidden, scrubReplayRecording, scrubWebTransaction, SENTRY_PRIVATE_SURFACES, webTraceSampleRate } from "./sentry-privacy.js";

type Envelope = Parameters<ReturnType<typeof Sentry.makeFetchTransport>["send"]>[0];

/** An independent final gate: Replay envelopes do not pass the error beforeSend hook. */
export function privateReplayEnvelope(envelope: Envelope, allowed: boolean): Envelope | null {
  // Dynamic sampling headers can carry the unsanitized page/transaction name.
  const headers = { ...envelope[0] };
  delete headers.trace;
  if (!envelope[1].some(([header]) => header.type === "replay_event" || header.type === "replay_recording")) return [headers, envelope[1]] as Envelope;
  if (!allowed) return null;
  const items: Array<Envelope[1][number]> = [];
  for (const [header, data] of envelope[1]) {
    if (header.type === "replay_event") {
      const raw = data as Record<string, unknown>;
      const clean: Record<string, unknown> = { type: "replay_event", urls: [], replay_type: "buffer" };
      for (const key of ["replay_id", "event_id"]) if (typeof raw[key] === "string" && /^[a-f0-9]{32}$/.test(raw[key])) clean[key] = raw[key];
      for (const key of ["timestamp", "replay_start_timestamp", "segment_id"]) if (typeof raw[key] === "number") clean[key] = raw[key];
      clean.error_ids = Array.isArray(raw.error_ids) ? raw.error_ids.filter((id) => typeof id === "string" && /^[a-f0-9]{32}$/.test(id)) : [];
      items.push([header, clean] as Envelope[1][number]);
    } else if (header.type === "replay_recording") {
      try {
        const text = typeof data === "string" ? data : data instanceof Uint8Array ? new TextDecoder().decode(data) : "";
        const split = text.indexOf("\n");
        const recordingHeader = JSON.parse(text.slice(0, split)) as { segment_id?: number };
        const recording = scrubReplayRecording(JSON.parse(text.slice(split + 1)));
        const payload = JSON.stringify({ segment_id: recordingHeader.segment_id }) + "\n" + JSON.stringify(recording);
        items.push([{ type: "replay_recording", length: new TextEncoder().encode(payload).length }, payload] as Envelope[1][number]);
      } catch { return null; } // Unknown/compressed payloads never bypass the privacy policy.
    }
  }
  return [headers, items] as Envelope;
}

export function initializeWebSentry(config: Omit<SpaceSentryConfig, "service">) {
  let replay: ReturnType<typeof Sentry.replayIntegration> | undefined;
  const guard = createReplayGuard(() => { void replay?.stop(); });
  const enabled = initSpaceSentry((base) => {
    if (!replayForbidden()) replay = Sentry.replayIntegration({
      maskAllText: true, maskAllInputs: true, blockAllMedia: true, block: [SENTRY_PRIVATE_SURFACES],
      useCompression: false, stickySession: false, networkCaptureBodies: false, networkDetailAllowUrls: [],
      beforeAddRecordingEvent: () => null, beforeErrorSampling: () => guard.allowed()
    });
    Sentry.init({ ...base,
      beforeSend: (event, hint) => {
        const clean = base.beforeSend(event, hint);
        // Replay's error-only trigger requires its generated ID after beforeSend.
        const replayId = event.tags?.replayId;
        return guard.allowed() && typeof replayId === "string" && /^[a-f0-9]{32}$/.test(replayId)
          ? { ...clean, tags: { service: "web", replayId } } : clean;
      },
      tracesSampler: (context) => webTraceSampleRate(context.name),
      tracePropagationTargets: [], replaysSessionSampleRate: 0, replaysOnErrorSampleRate: 1,
      beforeSendTransaction: (event) => {
        const clean = scrubWebTransaction(event);
        return clean ? { ...clean, release: base.release, environment: base.environment, tags: { service: "web" } } : null;
      },
      integrations: [Sentry.browserTracingIntegration({ traceFetch: false, traceXHR: false,
        enableLongTask: false, enableLongAnimationFrame: false, enableInp: false, enableHTTPTimings: false }), ...(replay ? [replay] : [])],
      transport: (options) => {
        const transport = Sentry.makeFetchTransport(options);
        return { flush: transport.flush, send: (envelope) => {
          const clean = privateReplayEnvelope(envelope, guard.allowed());
          return clean ? transport.send(clean) : Promise.resolve({ statusCode: 200 });
        } };
      }
    });
  }, { ...config, service: "web" });
  if (!enabled) { guard.close(); return undefined; }
  return { capture: (error: unknown) => { Sentry.captureException(error); } };
}
