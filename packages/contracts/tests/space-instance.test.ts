import { describe, expect, it } from "vitest";
import {
  assertDevInstanceIsolated,
  devInstanceIsolationProblems,
  instanceBackgroundJobEnabled,
  instanceBackgroundJobs,
  resolveSpaceInstance,
  sessionCookieNameFor
} from "../src/index.js";

const isolatedDevEnv = {
  SPACE_INSTANCE: "dev",
  SPACE_DATABASE_URL: "postgres://space:secret@127.0.0.1:54329/space_dev",
  SPACE_TEMPORAL_NAMESPACE: "space-dev",
  SPACE_TEMPORAL_TASK_QUEUE: "space-dev-agent-turns",
  SPACE_API_PORT: "4941",
  SPACE_CLI_HOST_SOCKET: "/run/space-dev-pane-host/pane-host.sock",
  SPACE_INSTALL_ROOT: "/opt/spaceapp-dev"
};

describe("space instance", () => {
  it("treats a missing or explicit stable value as stable and rejects anything else", () => {
    expect(resolveSpaceInstance({})).toBe("stable");
    expect(resolveSpaceInstance({ SPACE_INSTANCE: " stable " })).toBe("stable");
    expect(resolveSpaceInstance({ SPACE_INSTANCE: "dev" })).toBe("dev");
    expect(() => resolveSpaceInstance({ SPACE_INSTANCE: "prod" })).toThrow(/stable" or "dev/);
  });

  it("keeps the stable cookie name and gives dev its own", () => {
    expect(sessionCookieNameFor("stable")).toBe("space_session");
    expect(sessionCookieNameFor("dev")).toBe("space_session_dev");
  });

  it("isolates two source checkouts on different ports of the same host", () => {
    const first = sessionCookieNameFor("dev", "first-checkout"), second = sessionCookieNameFor("dev", "second-checkout");
    const cookieJar = new Map([[first, "first-session"], [second, "second-session"]]);
    expect(cookieJar.size).toBe(2);
    expect(cookieJar.get(first)).toBe("first-session");
    expect(sessionCookieNameFor("stable", "first-checkout")).toBe("space_session");
    expect(() => sessionCookieNameFor("dev", "bad; Path=/")).toThrow(/namespace/);
  });

  it("runs every background job on stable and none on dev unless listed", () => {
    for (const job of instanceBackgroundJobs) {
      expect(instanceBackgroundJobEnabled({}, job)).toBe(true);
      expect(instanceBackgroundJobEnabled({ SPACE_INSTANCE: "dev" }, job)).toBe(false);
    }
    const env = { SPACE_INSTANCE: "dev", SPACE_INSTANCE_ENABLED_JOBS: " dot-schedules ,streaming-bot" };
    expect(instanceBackgroundJobEnabled(env, "dot-schedules")).toBe(true);
    expect(instanceBackgroundJobEnabled(env, "streaming-bot")).toBe(true);
    expect(instanceBackgroundJobEnabled(env, "telegram-bridge")).toBe(false);
  });

  it("never blocks the stable instance", () => {
    expect(devInstanceIsolationProblems({}, "api")).toEqual([]);
    expect(assertDevInstanceIsolated({ SPACE_DATABASE_URL: "postgres://x@h/space" }, "worker")).toBe("stable");
  });

  it("accepts a fully isolated dev api and worker", () => {
    expect(devInstanceIsolationProblems(isolatedDevEnv, "api")).toEqual([]);
    expect(devInstanceIsolationProblems(isolatedDevEnv, "worker")).toEqual([]);
    expect(assertDevInstanceIsolated(isolatedDevEnv, "api")).toBe("dev");
  });

  it("refuses a dev process that would fall back to stable data or hosts", () => {
    expect(devInstanceIsolationProblems({ SPACE_INSTANCE: "dev" }, "api")).toHaveLength(6);
    const problems = devInstanceIsolationProblems({
      ...isolatedDevEnv,
      SPACE_DATABASE_URL: "postgres://space:secret@127.0.0.1:54329/space",
      SPACE_TEMPORAL_NAMESPACE: "default",
      SPACE_TEMPORAL_TASK_QUEUE: "space-agent-turns",
      SPACE_API_PORT: "4910",
      SPACE_CLI_HOST_SOCKET: "/run/space-codex-pane-host/pane-host.sock",
      SPACE_CLI_ROOT_ENABLED: "true",
      SPACE_CLI_ADMIN_HOST_SOCKET: "/run/space-admin-pane-host/pane-host.sock",
      SPACE_BROWSER_HOST_TRANSPORT: "unix",
      SPACE_INSTALL_ROOT: "/opt/spaceapp"
    }, "api");
    expect(problems.join("\n")).toMatch(/stable database "space"/);
    expect(problems).toHaveLength(9);
    expect(() => assertDevInstanceIsolated({ ...isolatedDevEnv, SPACE_API_PORT: "4910" }, "worker"))
      .toThrow(/Refusing to start the dev worker: SPACE_API_PORT/);
  });

  it("does not require pane host settings from the worker", () => {
    const { SPACE_CLI_HOST_SOCKET: _socket, SPACE_INSTALL_ROOT: _root, ...workerEnv } = isolatedDevEnv;
    expect(devInstanceIsolationProblems(workerEnv, "worker")).toEqual([]);
  });
});
