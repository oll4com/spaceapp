import { describe, expect, it } from "vitest";
import {
  isAllowedAppDiagnosticsAutomationMutation, isCliBrowserBridgeRequest, isInternalApiRequest, publicPaths, requiresCsrf
} from "../src/api-request-classes.js";

const request = (method: string, url: string) => ({ method, url, routeOptions: { url } }) as any;

describe("API request classes", () => {
  it("needs a CSRF token only for API writes outside the sign-in and telemetry exceptions", () => {
    expect(requiresCsrf(request("GET", "/api/rooms"))).toBe(false);
    expect(requiresCsrf(request("POST", "/api/rooms"))).toBe(true);
    expect(requiresCsrf(request("delete", "/api/rooms/:id"))).toBe(true);
    expect(requiresCsrf(request("POST", "/api/auth/login"))).toBe(false);
    expect(requiresCsrf(request("POST", "/api/asteroids/benchmark/run"))).toBe(false);
    expect(requiresCsrf(request("POST", "/healthz"))).toBe(false);
  });

  it("tells the internal API, the CLI bridge and public routes apart", () => {
    expect(isInternalApiRequest(request("POST", "/api/internal/anything"))).toBe(true);
    expect(isInternalApiRequest(request("POST", "/api/rooms"))).toBe(false);
    expect(isCliBrowserBridgeRequest(request("POST", "/api/rooms"))).toBe(false);
    expect(publicPaths.has("/api/auth/login")).toBe(true);
    expect(publicPaths.has("/api/rooms")).toBe(false);
  });

  it("lets app-diagnostics automation read anything but write only its own routes", () => {
    expect(isAllowedAppDiagnosticsAutomationMutation(request("GET", "/api/rooms"))).toBe(true);
    expect(isAllowedAppDiagnosticsAutomationMutation(request("POST", "/api/app-diagnostics/event-batches"))).toBe(true);
    expect(isAllowedAppDiagnosticsAutomationMutation(request("POST", "/api/rooms"))).toBe(false);
  });
});
