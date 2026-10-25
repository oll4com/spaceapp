import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

// Fail-fast, typed validation of the core API environment with the T3 Env
// library (@t3-oss/env-core). This is unrelated to the T3 Code application.
// getApiConfig consumes the normalized result, so validation and use agree.

const text = () => z.string().trim().min(1, "must not be blank");
const integer = (min: number, max: number) =>
  z.string().trim().regex(/^[0-9]{1,9}$/, "must be a whole number").transform(Number).pipe(z.number().int().min(min).max(max));
// Each flag keeps exactly the spellings it historically understood.
const flag = (...accepted: [string, ...string[]]) => z.enum(accepted);
const strictBoolean = () => flag("true", "false");
const absolutePath = () => text().refine((value) => value.startsWith("/"), "must be an absolute path");
const httpOrigin = () => text().refine((value) => {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
  } catch {
    return false;
  }
}, "must be an http(s) URL");
const postgresUrl = () => text().refine((value) => /^postgres(?:ql)?:\/\/[^\s]+$/.test(value), "must be a postgres:// URL");

export const t3ApiEnvServerSchema = {
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  SPACE_INSTANCE: z.enum(["stable", "dev"]).default("stable"),
  SPACE_API_HOST: text().default("127.0.0.1"),
  SPACE_API_PORT: integer(1, 65535).default(4910),
  SPACE_RUNTIME_STORE: z.enum(["memory", "postgres"]).default("memory"),
  SPACE_DATABASE_URL: postgresUrl().optional(),
  SPACE_DATABASE_POOL_MAX: integer(1, 100_000).optional(),
  SPACE_DATABASE_POOL_IDLE_TIMEOUT_MS: integer(1, 86_400_000).optional(),
  SPACE_DATABASE_POOL_CONNECTION_TIMEOUT_MS: integer(1, 86_400_000).optional(),
  SPACE_ENABLE_DB_SWEEP: flag("true", "false", "1", "0").optional(),
  SPACE_TEMPORAL_ADDRESS: text().optional(),
  SPACE_TEMPORAL_NAMESPACE: text().optional(),
  SPACE_TEMPORAL_TASK_QUEUE: text().optional(),
  SPACE_ENABLE_DUMMY_TURNS: strictBoolean().optional(),
  SPACE_ENABLE_CODEX_TURNS: strictBoolean().optional(),
  SPACE_AGENT_PANE_ENABLED: strictBoolean().optional(),
  SPACE_CLI_ENABLED: strictBoolean().optional(),
  SPACE_CLI_COMMAND_PATH: absolutePath().optional(),
  SPACE_CLI_WORKSPACE_ROOT: absolutePath().optional(),
  SPACE_CLI_TOKEN_TTL_MS: integer(1, 86_400_000).optional(),
  SPACE_CLI_HOST_SOCKET: absolutePath().optional(),
  SPACE_CLI_MAX_RUNNING_SESSIONS: integer(1, 1000).optional(),
  SPACE_CLI_ROOT_ENABLED: strictBoolean().optional(),
  SPACE_CLI_ADMIN_HOST_SOCKET: absolutePath().optional(),
  SPACE_CLI_VPN_ENABLED: strictBoolean().optional(),
  SPACE_CLI_MAINTENANCE_REPAIR_ENABLED: strictBoolean().optional(),
  SPACE_DEMO_PROJECTS_ENABLED: strictBoolean().optional(),
  SPACE_DEMO_PROJECTS_ROOT: absolutePath().optional(),
  SPACE_DEMO_PROJECTS_VAR_ROOT: absolutePath().optional(),
  SPACE_PROJECTS_ROOT: absolutePath().optional(),
  SPACE_INSTALL_ROOT: absolutePath().optional(),
  SPACE_FILES_HOST_MODE: flag("enabled", "disabled").optional(),
  SPACE_DEMO_PROJECTS_PORT_START: integer(1, 65535).optional(),
  SPACE_DEMO_PROJECTS_PORT_END: integer(1, 65535).optional(),
  SPACE_DEMO_PROJECTS_HEALTH_TIMEOUT_MS: integer(1, 86_400_000).optional(),
  SPACE_DEMO_PROJECTS_PUBLIC_ORIGIN: httpOrigin().optional(),
  SPACE_T3CODE_ENABLED: strictBoolean().optional(),
  SPACE_T3CODE_SOCKET: absolutePath().default("/run/space-t3code/transport.sock"),
  SPACE_T3CODE_PROXY_TIMEOUT_MS: integer(1000, 300_000).default(30_000),
  SPACE_T3CODE_HEALTH_TIMEOUT_MS: integer(500, 60_000).default(10_000),
  SPACE_PLAN_STAGE_MAX_ATTEMPTS: integer(1, 1000).optional(),
  SPACE_SESSION_SECRET: text().optional()
};

export type ValidatedT3ApiEnv = ReturnType<typeof validateT3ApiEnv>;

export class T3EnvValidationError extends Error {
  constructor(readonly fields: string[], details: string[]) {
    // Names and rule descriptions only: never echo a configured value.
    super(`T3 Env validation error: invalid environment (${details.join("; ")}).`);
    this.name = "T3EnvValidationError";
  }
}

type Issue = { path?: ReadonlyArray<PropertyKey | { key: PropertyKey }>; message?: string; code?: string };
function fieldOf(issue: Issue) {
  const segment = issue.path?.[0];
  return String(typeof segment === "object" && segment !== null ? segment.key : segment ?? "environment");
}

function safeReason(issue: Issue) {
  // Library messages for enums/types describe the rule, not the input value.
  if (issue.code === "invalid_value") return "unsupported value";
  if (issue.code === "invalid_type") return "required";
  return issue.message && issue.message.length <= 80 ? issue.message : "invalid value";
}

// No validation bypass: an operator setting SKIP_ENV_VALIDATION must not believe
// a malformed production configuration is being tolerated.
function rejectBypass(runtimeEnv: NodeJS.ProcessEnv) {
  if (runtimeEnv.SKIP_ENV_VALIDATION !== undefined && runtimeEnv.SKIP_ENV_VALIDATION !== "") {
    throw new T3EnvValidationError(["SKIP_ENV_VALIDATION"], ["SKIP_ENV_VALIDATION: not supported; validation always runs"]);
  }
}

export function validateT3ApiEnv(runtimeEnv: NodeJS.ProcessEnv = process.env) {
  rejectBypass(runtimeEnv);
  const env = createEnv({
    server: t3ApiEnvServerSchema,
    runtimeEnv,
    emptyStringAsUndefined: true,
    onValidationError: (issues: readonly Issue[]) => {
      const fields = [...new Set(issues.map(fieldOf))];
      throw new T3EnvValidationError(fields, issues.map((issue) => `${fieldOf(issue)}: ${safeReason(issue)}`));
    }
  });

  if (env.SPACE_RUNTIME_STORE === "postgres" && !env.SPACE_DATABASE_URL) {
    throw new T3EnvValidationError(["SPACE_DATABASE_URL"], ["SPACE_DATABASE_URL is required when SPACE_RUNTIME_STORE=postgres"]);
  }
  return env;
}
