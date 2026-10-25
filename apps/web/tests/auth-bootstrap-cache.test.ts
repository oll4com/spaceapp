import { afterEach, describe, expect, it } from "vitest";
import type { AuthMe } from "@space/contracts";
import {
  cacheAuthBootstrap,
  clearAuthBootstrapCache,
  consumeAuthBootstrap
} from "../src/auth-bootstrap-cache.js";

const authenticatedOwner: AuthMe = {
  user: { id: "user:owner", email: "owner@example.com", role: "ADMIN" },
  isAuthenticated: true,
  isSetupRequired: false
};

afterEach(() => clearAuthBootstrapCache());

describe("auth bootstrap cache", () => {
  it("hands the validated bootstrap response to the app exactly once", () => {
    cacheAuthBootstrap(authenticatedOwner);

    expect(consumeAuthBootstrap()).toEqual(authenticatedOwner);
    expect(consumeAuthBootstrap()).toBeNull();
  });
});
