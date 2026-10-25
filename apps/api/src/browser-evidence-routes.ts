import type {} from "./request-context.js";
import type { FastifyInstance, RouteShorthandOptions } from "fastify";
import { browserEvidenceCaptureSchema, createBrowserEvidenceInputSchema } from "@space/contracts";
import type { SpaceEventBus, SpaceStore } from "@space/runtime";
import {
  type BrowserEvidenceCaptureHandler, buildBrowserEvidenceTargetUrl, requireEvidenceArtifactKinds
} from "./browser-evidence.js";
import type { SpaceApiConfig } from "./config.js";
import { recordAudit } from "./request-audit.js";
import { parseBody } from "./route-parsing.js";

/**
 * Browser evidence capability and the evidence smoke check; the parent retains authentication, CSRF, errors and
 * rate limits.
 */
export function registerBrowserEvidenceRoutes(app: FastifyInstance, options: {
  config: SpaceApiConfig;
  store: SpaceStore;
  eventBus: SpaceEventBus;
  browserEvidenceCapture: BrowserEvidenceCaptureHandler;
  routeOptions: Pick<RouteShorthandOptions, "config">;
}) {
  const { config, store, eventBus, browserEvidenceCapture, routeOptions: defaultRouteRateLimitOptions } = options;
  app.get("/api/browser", defaultRouteRateLimitOptions, async () => {
    const capabilities = (await store.listCapabilities()).filter((item) => item.kind === "BROWSER_POOL");
    return { data: capabilities, pagination: { page: 1, pageSize: 100, totalItems: capabilities.length, totalPages: capabilities.length ? 1 : 0 } };
  });
  app.post("/api/browser/evidence-smoke", defaultRouteRateLimitOptions, async (request) => {
    const input = parseBody(createBrowserEvidenceInputSchema, request.body);
    const targetUrl = buildBrowserEvidenceTargetUrl(config.browserEvidenceTargetOrigin);
    const capture = await browserEvidenceCapture({
      ...input,
      paneId: input.paneId ?? null,
      targetUrl,
      traceId: request.requestIdForSpace
    });
    const artifacts = [];
    for (const artifactInput of capture.artifacts) {
      const record = await store.createArtifact(
        {
          roomId: input.roomId,
          paneId: input.paneId ?? null,
          ...artifactInput,
          metadata: {
            ...artifactInput.metadata,
            browserCaptureId: capture.captureId,
            browserTargetUrl: targetUrl
          }
        },
        request.requestIdForSpace
      );
      eventBus.publish(record.event);
      artifacts.push(record.artifact);
    }
    requireEvidenceArtifactKinds(artifacts);
    await recordAudit(store, request, {
      action: "browser.evidence_smoke",
      targetType: "room",
      targetId: input.roomId,
      metadata: {
        roomId: input.roomId,
        paneId: input.paneId ?? null,
        viewport: input.viewport,
        targetUrl,
        captureId: capture.captureId,
        artifactCount: artifacts.length,
        artifactIds: artifacts.map((artifact) => artifact.id)
      }
    });
    return browserEvidenceCaptureSchema.parse({
      ...capture,
      paneId: input.paneId ?? null,
      targetUrl,
      artifacts
    });
  });
}
