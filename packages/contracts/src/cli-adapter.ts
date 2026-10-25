import { z } from "zod";

/**
 * An operation the adapter cannot provide in full for one runtime. A runtime
 * declares the limitation instead of silently treating a weaker behavior (a
 * provider picker, a fresh restart, an unobserved completion) as equivalent.
 */
export const cliAdapterLimitationSchema = z.object({
  operation: z.enum([
    "start", "send", "interrupt", "inspect", "events", "reconnect", "nativeResume", "completion", "login"
  ]),
  code: z.enum([
    // A fresh start needs a resolved model and reasoning effort; the launcher refuses a bare start.
    "START_REQUIRES_RESOLVED_MODEL",
    // No native resume form exists at the Space boundary.
    "NATIVE_RESUME_UNSUPPORTED",
    // Recovery reaches only the provider's continue/latest/picker selection, not a recorded task.
    "PROVIDER_SELECTION_ONLY",
    // The provider-selection form opens an interactive picker instead of resuming.
    "PROVIDER_SELECTION_INTERACTIVE_PICKER",
    // The launcher passes a recorded reference, but REFERENCE is withheld until a live proof.
    "REFERENCE_PENDING_LIVE_PROOF",
    // The reference travels in a kept environment variable and the wrapper steers a continue flag to it.
    "REFERENCE_STEERED_BY_WRAPPER",
    // After a pane-host loss the session restarts fresh instead of resuming.
    "HOST_LOSS_RESTARTS_FRESH",
    // A PTY exit does not establish task success; completion is not observed.
    "COMPLETION_UNOBSERVED",
    // Authentication happens inside the CLI or through managed credentials, not a terminal login.
    "LOGIN_NOT_IN_TERMINAL"
  ]),
  detail: z.string().min(1).max(300)
}).strict();

export type CliAdapterLimitation = z.infer<typeof cliAdapterLimitationSchema>;

/**
 * Versioned declaration of the Space CLI boundary, not launch authorization or
 * proof that an installed upstream executable works. Runtime status/auth and
 * the existing lease checks remain authoritative for admitting operations.
 */
export const cliAdapterContractSchema = z.object({
  contractVersion: z.literal(1),
  operations: z.object({
    start: z.literal("PTY_SPAWN"),
    send: z.literal("PTY_INPUT"),
    interrupt: z.literal("PROCESS_TERMINATE"),
    inspect: z.literal("HOST_PROCESS"),
    events: z.literal("PTY_OUTPUT_AND_PROCESS_EXIT"),
    reconnect: z.literal("LIVE_HOST_PROCESS")
  }).strict(),
  // Empty means unsupported. A provider picker/continue flag does not establish
  // that the same native task will be selected.
  nativeResumeModes: z.array(z.enum(["REFERENCE", "PROVIDER_SELECTION"])).max(2),
  completion: z.enum(["CODEX_ROLLOUT", "OPENCODE_NATIVE_STATUS", "UNAVAILABLE_FAIL_CLOSED"]),
  context: z.object({
    owner: z.literal("PROVIDER_NATIVE"),
    spaceCompaction: z.literal("NONE"),
    // No normalized per-turn usage report exists at this PTY boundary. Other
    // account/rollout surfaces may contain usage; missing usage is not zero.
    usageReporting: z.literal("UNAVAILABLE")
  }).strict(),
  // Optional so registry records written before limitations were declared stay valid.
  limitations: z.array(cliAdapterLimitationSchema).max(16).optional(),
  evidence: z.literal("DECLARED_ONLY")
}).strict();

export type CliAdapterContract = z.infer<typeof cliAdapterContractSchema>;
