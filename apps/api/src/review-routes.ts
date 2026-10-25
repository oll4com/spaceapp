import type {} from "./request-context.js";
import type { FastifyInstance, RouteShorthandOptions } from "fastify";
import type { SpaceStore, SpaceEventBus } from "@space/runtime";
import {
  listReviewDecisionsQuerySchema, createReviewDecisionInputSchema, reviewRoomStateSchema,
  listReviewChecksQuerySchema, createReviewCheckInputSchema,
  listReviewDiffSummariesQuerySchema, createReviewDiffSummaryInputSchema
} from "@space/contracts";
import type { AuditRecorder } from "./request-audit.js";

function reviewGateStatus(checks: Array<{ status: string }>): { gateStatus: "EMPTY" | "PASS" | "WARN" | "FAIL"; statusReason: string } {
  if (!checks.length) {
    return { gateStatus: "EMPTY", statusReason: "No review checks have been recorded for this room." };
  }
  if (checks.some((check) => check.status === "FAIL")) {
    return { gateStatus: "FAIL", statusReason: "At least one review check is failing." };
  }
  if (checks.some((check) => ["WARN", "RUNNING", "SKIPPED"].includes(check.status))) {
    return { gateStatus: "WARN", statusReason: "Review checks include warnings, skipped checks, or running work." };
  }
  return { gateStatus: "PASS", statusReason: "All recorded review checks are passing." };
}

/** Review evidence domain; the parent retains authentication, CSRF, errors and rate limits. */
export function registerReviewRoutes(app: FastifyInstance, options: {
  store: Pick<SpaceStore, "listReviewDecisions" | "createReviewDecision" | "listReviewChecks" |
    "createReviewCheck" | "listReviewDiffSummaries" | "createReviewDiffSummary" | "listArtifacts">;
  eventBus: Pick<SpaceEventBus, "publish">;
  recordAudit: AuditRecorder;
  routeOptions: Pick<RouteShorthandOptions, "config">;
}) {
  const { store, eventBus, recordAudit, routeOptions: defaultRouteRateLimitOptions } = options;
  app.get("/api/reviews", defaultRouteRateLimitOptions, async (request) => {
    const page = listReviewDecisionsQuerySchema.parse(request.query);
    const decisions = await store.listReviewDecisions(page);
    const start = (page.page - 1) * page.pageSize;
    return {
      data: decisions.slice(start, start + page.pageSize),
      pagination: {
        page: page.page,
        pageSize: page.pageSize,
        totalItems: decisions.length,
        totalPages: Math.ceil(decisions.length / page.pageSize)
      }
    };
  });
  app.post("/api/reviews", defaultRouteRateLimitOptions, async (request) => {
    const input = createReviewDecisionInputSchema.parse(request.body);
    const record = await store.createReviewDecision(input, request.requestIdForSpace);
    eventBus.publish(record.event);
    await recordAudit(request, {
      action: "review.decision.create",
      targetType: "review_decision",
      targetId: record.decision.id,
      metadata: {
        roomId: record.decision.roomId,
        workflowId: record.decision.workflowId,
        decision: record.decision.decision,
        evidenceArtifactCount: record.decision.evidenceArtifactIds.length
      }
    });
    return record.decision;
  });
  app.get("/api/reviews/state", defaultRouteRateLimitOptions, async (request) => {
    const page = listReviewDecisionsQuerySchema.parse(request.query);
    const [decisions, checks, diffs, artifacts] = await Promise.all([
      store.listReviewDecisions(page),
      store.listReviewChecks({ page: 1, pageSize: 100, sortOrder: "desc", roomId: page.roomId }),
      store.listReviewDiffSummaries({ page: 1, pageSize: 100, sortOrder: "desc", roomId: page.roomId }),
      store.listArtifacts({ page: 1, pageSize: 100, sortOrder: "desc", roomId: page.roomId })
    ]);
    return reviewRoomStateSchema.parse({
      decisions,
      checks,
      diffs,
      artifacts,
      ...reviewGateStatus(checks)
    });
  });
  app.get("/api/review-checks", defaultRouteRateLimitOptions, async (request) => {
    const page = listReviewChecksQuerySchema.parse(request.query);
    const checks = await store.listReviewChecks(page);
    const start = (page.page - 1) * page.pageSize;
    return {
      data: checks.slice(start, start + page.pageSize),
      pagination: {
        page: page.page,
        pageSize: page.pageSize,
        totalItems: checks.length,
        totalPages: Math.ceil(checks.length / page.pageSize)
      }
    };
  });
  app.post("/api/review-checks", defaultRouteRateLimitOptions, async (request) => {
    const input = createReviewCheckInputSchema.parse(request.body);
    const record = await store.createReviewCheck(input, request.requestIdForSpace);
    eventBus.publish(record.event);
    await recordAudit(request, {
      action: "review.check.create",
      targetType: "review_check",
      targetId: record.check.id,
      metadata: {
        roomId: record.check.roomId,
        reviewDecisionId: record.check.reviewDecisionId,
        status: record.check.status,
        artifactCount: record.check.artifactIds.length
      }
    });
    return record.check;
  });
  app.get("/api/review-diffs", defaultRouteRateLimitOptions, async (request) => {
    const page = listReviewDiffSummariesQuerySchema.parse(request.query);
    const diffs = await store.listReviewDiffSummaries(page);
    const start = (page.page - 1) * page.pageSize;
    return {
      data: diffs.slice(start, start + page.pageSize),
      pagination: {
        page: page.page,
        pageSize: page.pageSize,
        totalItems: diffs.length,
        totalPages: Math.ceil(diffs.length / page.pageSize)
      }
    };
  });
  app.post("/api/review-diffs", defaultRouteRateLimitOptions, async (request) => {
    const input = createReviewDiffSummaryInputSchema.parse(request.body);
    const record = await store.createReviewDiffSummary(input, request.requestIdForSpace);
    eventBus.publish(record.event);
    await recordAudit(request, {
      action: "review.diff.create",
      targetType: "review_diff",
      targetId: record.diff.id,
      metadata: {
        roomId: record.diff.roomId,
        reviewDecisionId: record.diff.reviewDecisionId,
        status: record.diff.status,
        additions: record.diff.additions,
        deletions: record.diff.deletions,
        patchArtifactId: record.diff.patchArtifactId
      }
    });
    return record.diff;
  });
}
