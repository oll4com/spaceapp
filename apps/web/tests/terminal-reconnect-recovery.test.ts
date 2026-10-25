import { describe, expect, it, vi } from "vitest";
import { SpaceApiError } from "../src/runtime/SpaceRuntime.js";
import {
  createTerminalReconnectCoordinator,
  isRetryableCliReconnectError
} from "../src/features/terminal-pane/TerminalPane.js";
import { api } from "../src/live-api.js";

describe("terminal reconnect recovery and retryability", () => {
  it("treats server restart and gateway failures as retryable", () => {
    expect(isRetryableCliReconnectError(new SpaceApiError("Bad Gateway", { status: 502 }))).toBe(true);
    expect(isRetryableCliReconnectError(new SpaceApiError("Gateway Timeout", { status: 504 }))).toBe(true);
    expect(isRetryableCliReconnectError(new SpaceApiError("Service Unavailable", { status: 503 }))).toBe(true);
    expect(isRetryableCliReconnectError(new SpaceApiError("Too Many Requests", { status: 429 }))).toBe(true);
    expect(isRetryableCliReconnectError(new SpaceApiError("Upstream timeout", { status: 0, code: "REQUEST_TIMEOUT" }))).toBe(true);
    expect(isRetryableCliReconnectError(new SpaceApiError("Upstream unavailable", { status: 0, code: "UPSTREAM_UNAVAILABLE" }))).toBe(true);
    expect(isRetryableCliReconnectError(new TypeError("Failed to fetch"))).toBe(true);
    expect(isRetryableCliReconnectError(new DOMException("The user aborted a request.", "AbortError"))).toBe(true);
    expect(isRetryableCliReconnectError(new Error("Request failed: 502 (received HTML error page from the proxy or web server)."))).toBe(true);
    expect(isRetryableCliReconnectError(new Error("connect ECONNREFUSED 127.0.0.1:4911"))).toBe(true);
    expect(isRetryableCliReconnectError(new Error("Active CLI session request timed out."))).toBe(true);
  });

  it("does not treat authentication revocation or permanent client errors as retryable", () => {
    expect(isRetryableCliReconnectError(new SpaceApiError("Unauthorized", { status: 401 }))).toBe(false);
    expect(isRetryableCliReconnectError(new SpaceApiError("Forbidden", { status: 403 }))).toBe(false);
    expect(isRetryableCliReconnectError(new SpaceApiError("Not Found", { status: 404 }))).toBe(false);
    expect(isRetryableCliReconnectError(new SpaceApiError("Bad Request", { status: 400 }))).toBe(false);
    expect(isRetryableCliReconnectError(new Error("Invalid JSON structure"))).toBe(false);
  });

  it("deduplicates concurrent session requests and frees the flight when completed", async () => {
    const coordinator = createTerminalReconnectCoordinator();
    let invocations = 0;
    const task = () => new Promise<string>((resolve) => {
      invocations += 1;
      setTimeout(() => resolve("done"), 20);
    });

    const [first, second] = await Promise.all([
      coordinator.runSessionRequest(task),
      coordinator.runSessionRequest(task)
    ]);

    expect(first).toBe("done");
    expect(second).toBe("done");
    expect(invocations).toBe(1);

    // After settling, a new request runs afresh
    const third = await coordinator.runSessionRequest(task);
    expect(third).toBe("done");
    expect(invocations).toBe(2);
  });

  it("aborts a hung session request flight and clears the flight lock", async () => {
    vi.useFakeTimers();
    try {
      const coordinator = createTerminalReconnectCoordinator();
      const hungTask = () => new Promise<string>(() => {
        // never resolves
      });

      const flightPromise = coordinator.runSessionRequest(hungTask);
      let errorThrown: unknown = null;
      flightPromise.catch((err) => {
        errorThrown = err;
      });

      // Advance time past the 10s safety timeout
      await vi.advanceTimersByTimeAsync(10_001);

      expect(errorThrown).toBeInstanceOf(SpaceApiError);
      expect((errorThrown as SpaceApiError).code).toBe("REQUEST_TIMEOUT");
      expect(isRetryableCliReconnectError(errorThrown)).toBe(true);

      // Verify the flight lock was cleared so a fresh request can succeed
      const freshTask = () => Promise.resolve("recovered");
      await expect(coordinator.runSessionRequest(freshTask)).resolves.toBe("recovered");
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows clearing stalled session request flights explicitly", async () => {
    const coordinator = createTerminalReconnectCoordinator();
    const hungTask = () => new Promise<string>(() => {});
    void coordinator.runSessionRequest(hungTask);

    coordinator.clearSessionRequestFlight();

    const freshTask = () => Promise.resolve("fresh");
    await expect(coordinator.runSessionRequest(freshTask)).resolves.toBe("fresh");
  });

  it("exposes clearActiveCliSessionFlight on api to clear in-flight session requests", () => {
    expect(typeof api.clearActiveCliSessionFlight).toBe("function");
    expect(() => api.clearActiveCliSessionFlight("pane:sample")).not.toThrow();
  });
});
