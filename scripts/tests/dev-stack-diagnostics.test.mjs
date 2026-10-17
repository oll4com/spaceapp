import test from "node:test";
import assert from "node:assert/strict";
import { cleanupFailureRecord, supervisorExitRecord } from "../dev-stack-diagnostics.mjs";

const cleanupSchema = "spaceapp.dev-stack-cleanup-failure.v1";
const exitSchema = "spaceapp.dev-stack-supervisor-exit.v1";

test("cleanup diagnostics map only exact internal messages for their fixed stage", () => {
  const cases = [
    ["SIGNAL_CHILD_GROUP",
      "A launched child's process identity was not established; retain receipts for recovery.",
      "CHILD_IDENTITY_UNOBSERVED"],
    ["WAIT_CHILD_GROUPS", "Timed out waiting for child shutdown.", "CHILD_GROUP_WAIT_TIMEOUT"],
    ["DOCKER_SHUTDOWN", "Owned Docker containers remain; cleanup is incomplete.", "DOCKER_CONTAINERS_REMAIN"],
  ];
  for (const [stage, message, code] of cases) {
    assert.deepEqual(cleanupFailureRecord({ stage, error: new Error(message) }), {
      schema: cleanupSchema, stage, code,
    });
  }
  assert.equal(cleanupFailureRecord({
    stage: "SIGNAL_CHILD_GROUP",
    error: new Error("Owned Docker containers remain; cleanup is incomplete."),
  }).code, "CLEANUP_ERROR");
});

test("cleanup diagnostics translate known errno without copying arbitrary fields", () => {
  const error = Object.assign(new Error("private-message"), {
    code: "EPERM", stack: "private-stack", command: "private-command", env: "private-env",
    url: "private-url", secret: "private-secret",
  });
  const record = cleanupFailureRecord({ stage: "SIGNAL_CHILD_GROUP", error, childName: "api" });
  assert.deepEqual(record, {
    schema: cleanupSchema,
    stage: "SIGNAL_CHILD_GROUP",
    code: "CLEANUP_OPERATION_NOT_PERMITTED",
    role: "api",
  });
  const serialized = JSON.stringify(record);
  for (const value of [error.message, error.stack, error.command, error.env, error.url, error.secret, error.code]) {
    assert.equal(serialized.includes(value), false);
  }
});

test("unknown cyclic and nested failures collapse to CLEANUP_ERROR", () => {
  const nested = { message: "nested-private-message", code: "PRIVATE_NESTED_CODE" };
  const error = {
    message: "outer-private-message",
    code: "PRIVATE_OUTER_CODE",
    stack: "private-stack",
    cause: nested,
    command: "private-command",
    env: { PRIVATE_TOKEN: "private-token" },
    url: "https://private.invalid/secret",
    secret: "private-secret",
  };
  error.self = error;
  nested.cause = error;
  const record = cleanupFailureRecord({ stage: "WAIT_CHILD_GROUPS", error, childName: "worker" });
  assert.deepEqual(record, {
    schema: cleanupSchema,
    stage: "WAIT_CHILD_GROUPS",
    code: "CLEANUP_ERROR",
    role: "worker",
  });
  const serialized = JSON.stringify(record);
  for (const value of [error.message, error.code, error.stack, error.command, error.url, error.secret,
    nested.message, nested.code, error.env.PRIVATE_TOKEN]) {
    assert.equal(serialized.includes(value), false);
  }
  for (const code of ["constructor", "__proto__", "PRIVATE_UNKNOWN_CODE"]) {
    assert.equal(cleanupFailureRecord({
      stage: "WAIT_CHILD_GROUPS", error: { code, message: "private-message" },
    }).code, "CLEANUP_ERROR");
  }
});

test("AggregateError details are not traversed", () => {
  const aggregate = new AggregateError([
    Object.assign(new Error("private-inner-message"), { code: "EPERM" }),
  ], "private-aggregate-message");
  aggregate.cause = aggregate;
  assert.deepEqual(cleanupFailureRecord({ stage: "DOCKER_SHUTDOWN", error: aggregate }), {
    schema: cleanupSchema,
    stage: "DOCKER_SHUTDOWN",
    code: "CLEANUP_ERROR",
  });
});

test("non-object errors and hostile error properties remain opaque", () => {
  const hostile = {};
  for (const key of ["message", "code", "cause", "stack", "command", "env", "url", "secret"]) {
    Object.defineProperty(hostile, key, { get() { throw new Error(`private-${key}`); } });
  }
  const hostileProxy = new Proxy({}, {
    getOwnPropertyDescriptor() { throw new Error("private-proxy-value"); },
  });
  for (const error of [null, "private-string-error", hostile, hostileProxy]) {
    assert.equal(cleanupFailureRecord({ stage: "DOCKER_SHUTDOWN", error }).code, "CLEANUP_ERROR");
  }
});

test("invalid cleanup inputs and stages fail with fixed messages", () => {
  for (const input of [null, undefined, "private-input", [], 7]) {
    assert.throws(() => cleanupFailureRecord(input), error => {
      assert.equal(error.message, "Invalid cleanup failure input.");
      return true;
    });
  }
  for (const stage of [undefined, null, "constructor", "__proto__", "PRIVATE_STAGE"]) {
    assert.throws(() => cleanupFailureRecord({ stage, error: new Error("private") }), error => {
      assert.equal(error.message, "Invalid cleanup failure stage.");
      assert.equal(error.message.includes(String(stage)), false);
      return true;
    });
  }
});

test("only literal dev-stack child roles may enter cleanup records", () => {
  const roles = [
    "Docker prerequisites",
    "start PostgreSQL and Temporal",
    "build source and workspace packages",
    "database migrations",
    "install pinned state-local OpenCode",
    "cli-host", "worker", "api", "web",
  ];
  for (const role of roles) {
    assert.equal(cleanupFailureRecord({
      stage: "SIGNAL_CHILD_GROUP", error: null, childName: role,
    }).role, role);
  }
  assert.equal(Object.hasOwn(cleanupFailureRecord({
    stage: "SIGNAL_CHILD_GROUP", error: null,
  }), "role"), false);
  assert.equal(Object.hasOwn(cleanupFailureRecord({
    stage: "SIGNAL_CHILD_GROUP", error: null, childName: undefined,
  }), "role"), false);
});

test("arbitrary and accessor child roles are rejected without echo", () => {
  for (const childName of [null, 1, "constructor", "__proto__", "private-child-secret"]) {
    assert.throws(() => cleanupFailureRecord({
      stage: "SIGNAL_CHILD_GROUP", error: null, childName,
    }), error => {
      assert.equal(error.message, "Invalid cleanup child role.");
      assert.equal(error.message.includes(String(childName)), false);
      return true;
    });
  }
  const input = { stage: "SIGNAL_CHILD_GROUP", error: null };
  Object.defineProperty(input, "childName", { get() { throw new Error("private-role-getter"); } });
  assert.throws(() => cleanupFailureRecord(input), /Invalid cleanup child role\./);
});

test("supervisor exit records preserve bounded exit zero and no other fields", () => {
  assert.deepEqual(supervisorExitRecord({ code: 0, signal: null, pid: 123,
    message: "private-message", env: "private-env" }), {
    schema: exitSchema,
    code: 0,
    signal: null,
  });
});

test("supervisor exit records preserve only known signals", () => {
  for (const signal of ["SIGTERM", "SIGINT", "SIGKILL"]) {
    assert.deepEqual(supervisorExitRecord({ code: null, signal }), {
      schema: exitSchema,
      code: null,
      signal,
    });
  }
});

test("supervisor exit rejects invalid codes and unknown signal text by reduction", () => {
  const cases = [
    [{ code: -1, signal: "PRIVATE_SIGNAL" }, null],
    [{ code: 256, signal: "constructor" }, null],
    [{ code: 1.5, signal: "__proto__" }, null],
    [{ code: "1", signal: "private-secret" }, null],
    [{ code: 1, signal: undefined }, 1],
    [null, null],
  ];
  for (const [exit, code] of cases) {
    assert.deepEqual(supervisorExitRecord(exit), {
      schema: exitSchema,
      code,
      signal: "UNKNOWN",
    });
  }
});

test("supervisor exit does not invoke hostile getters or proxy traps beyond safe inspection", () => {
  const hostile = {};
  Object.defineProperties(hostile, {
    code: { get() { throw new Error("private-code-getter"); } },
    signal: { get() { throw new Error("private-signal-getter"); } },
  });
  const hostileProxy = new Proxy({}, {
    getOwnPropertyDescriptor() { throw new Error("private-exit-proxy"); },
  });
  for (const exit of [hostile, hostileProxy]) {
    assert.deepEqual(supervisorExitRecord(exit), {
      schema: exitSchema,
      code: null,
      signal: "UNKNOWN",
    });
  }
});
