const CLEANUP_SCHEMA = "spaceapp.dev-stack-cleanup-failure.v1";
const SUPERVISOR_EXIT_SCHEMA = "spaceapp.dev-stack-supervisor-exit.v1";

const cleanupStages = new Set([
  "SIGNAL_CHILD_GROUP",
  "WAIT_CHILD_GROUPS",
  "DOCKER_SHUTDOWN",
]);

// These are the only names passed to launch() by dev-stack.mjs. A caller may
// omit childName, but arbitrary names never cross the diagnostic boundary.
const childRoles = new Set([
  "Docker prerequisites",
  "start PostgreSQL and Temporal",
  "build source and workspace packages",
  "database migrations",
  "install pinned state-local OpenCode",
  "cli-host",
  "worker",
  "api",
  "web",
]);

const messageCodesByStage = new Map([
  ["SIGNAL_CHILD_GROUP", new Map([
    ["A launched child's process identity was not established; retain receipts for recovery.",
      "CHILD_IDENTITY_UNOBSERVED"],
    ["Invalid managed process PID.", "INVALID_CHILD_PID"],
    ["Cannot establish process creation identity.", "CHILD_IDENTITY_OBSERVATION_FAILED"],
    ["The dev stack uses Unix process groups; run Windows inside WSL2.", "PROCESS_GROUPS_UNSUPPORTED"],
    ["Unsupported teardown signal.", "UNSUPPORTED_TEARDOWN_SIGNAL"],
    ["Managed process identity changed; refusing to signal it.", "CHILD_IDENTITY_CHANGED"],
  ])],
  ["WAIT_CHILD_GROUPS", new Map([
    ["Invalid managed process group.", "INVALID_CHILD_PROCESS_GROUP"],
    ["Managed process group remains; cleanup is incomplete.", "CHILD_PROCESS_GROUP_REMAINS"],
    ["Timed out waiting for child shutdown.", "CHILD_GROUP_WAIT_TIMEOUT"],
  ])],
  ["DOCKER_SHUTDOWN", new Map([
    ["Owned compose file is not valid JSON; refusing Docker cleanup.", "COMPOSE_INVALID_JSON"],
    ["Owned compose configuration differs from this checkout's expected project/services/volumes; refusing Docker cleanup.",
      "COMPOSE_CONFIGURATION_CHANGED"],
    ["Owned compose file is not a bounded private regular file; refusing Docker cleanup.",
      "COMPOSE_FILE_NOT_OWNED"],
    ["Docker operation failed; resources are not certified clean. Check Docker/Compose and retry down/reset explicitly.",
      "DOCKER_OPERATION_FAILED"],
    ["Owned Docker containers remain; cleanup is incomplete.", "DOCKER_CONTAINERS_REMAIN"],
  ])],
]);

// Only literal Node/POSIX errno values relevant to the bounded cleanup paths
// are translated. The original code is never copied into a record.
const errnoCodes = new Map([
  ["EACCES", "CLEANUP_ACCESS_DENIED"],
  ["EPERM", "CLEANUP_OPERATION_NOT_PERMITTED"],
  ["ENOENT", "CLEANUP_RESOURCE_NOT_FOUND"],
  ["ESRCH", "CLEANUP_PROCESS_NOT_FOUND"],
  ["EBUSY", "CLEANUP_RESOURCE_BUSY"],
  ["ETIMEDOUT", "CLEANUP_OPERATION_TIMED_OUT"],
]);

const knownSignals = new Set(["SIGTERM", "SIGINT", "SIGKILL"]);

function ownData(object, key) {
  if (object === null || (typeof object !== "object" && typeof object !== "function")) {
    return { present: false, readable: false, value: undefined };
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor) return { present: false, readable: false, value: undefined };
    // Accessors are deliberately not invoked at this serialization boundary.
    return Object.hasOwn(descriptor, "value")
      ? { present: true, readable: true, value: descriptor.value }
      : { present: true, readable: false, value: undefined };
  } catch {
    // A hostile Proxy is treated as unreadable, never allowed to supply text.
    return { present: true, readable: false, value: undefined };
  }
}

function cleanupCode(stage, error) {
  const message = ownData(error, "message").value;
  if (typeof message === "string") {
    const mapped = messageCodesByStage.get(stage).get(message);
    if (mapped) return mapped;
  }
  const errno = ownData(error, "code").value;
  return typeof errno === "string" ? (errnoCodes.get(errno) ?? "CLEANUP_ERROR") : "CLEANUP_ERROR";
}

/** Serialize one wrapper-level cleanup failure without traversing causes or AggregateError.errors. */
export function cleanupFailureRecord(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Invalid cleanup failure input.");
  }
  const stage = ownData(input, "stage").value;
  if (typeof stage !== "string" || !cleanupStages.has(stage)) {
    throw new Error("Invalid cleanup failure stage.");
  }
  const childName = ownData(input, "childName");
  if (childName.present && (!childName.readable || (childName.value !== undefined &&
      (typeof childName.value !== "string" || !childRoles.has(childName.value))))) {
    throw new Error("Invalid cleanup child role.");
  }
  const record = {
    schema: CLEANUP_SCHEMA,
    stage,
    code: cleanupCode(stage, ownData(input, "error").value),
  };
  if (typeof childName.value === "string") record.role = childName.value;
  return record;
}

/** Reduce a child-process exit observation to fixed scalar fields only. */
export function supervisorExitRecord(exit) {
  const code = ownData(exit, "code").value;
  const signal = ownData(exit, "signal").value;
  return {
    schema: SUPERVISOR_EXIT_SCHEMA,
    code: Number.isSafeInteger(code) && code >= 0 && code <= 255 ? code : null,
    signal: signal === null ? null : (typeof signal === "string" && knownSignals.has(signal) ? signal : "UNKNOWN"),
  };
}
