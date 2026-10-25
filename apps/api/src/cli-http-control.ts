/**
 * CLI pane HTTP control authority (lease and browser/tab identity headers) shared by the CLI routes and composition
 * (moved verbatim from the composition root).
 */
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { idSchema } from "@space/contracts";
import { SpaceConflictError } from "@space/runtime";
import { headerString } from "./request-helpers.js";

const cliHttpControlHeaderNames = {
  leaseId: "x-space-cli-control-lease-id",
  browserClientId: "x-space-cli-browser-client-id",
  tabLineageId: "x-space-cli-tab-lineage-id",
  pageClientId: "x-space-cli-page-client-id"
} as const;

const cliHttpControlAuthoritySchema = z.object({
  leaseId: idSchema,
  browserClientId: z.string().uuid(),
  tabLineageId: z.string().uuid(),
  pageClientId: z.string().uuid()
});

export class CliTerminalControlRequiredError extends SpaceConflictError {
  readonly errorCode = "CLI_CONTROL_REQUIRED";

  constructor() {
    super("Take control of this CLI pane before changing its active session.");
    this.name = "CliTerminalControlRequiredError";
  }
}

export function parseCliHttpControlAuthority(request: FastifyRequest) {
  const input = {
    leaseId: headerString(request.headers[cliHttpControlHeaderNames.leaseId]),
    browserClientId: headerString(request.headers[cliHttpControlHeaderNames.browserClientId]),
    tabLineageId: headerString(request.headers[cliHttpControlHeaderNames.tabLineageId]),
    pageClientId: headerString(request.headers[cliHttpControlHeaderNames.pageClientId])
  };
  return Object.values(input).every((value) => value === null)
    ? null
    : cliHttpControlAuthoritySchema.parse(input);
}
