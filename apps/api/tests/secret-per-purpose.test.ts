import { afterEach, describe, expect, it } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { issueCliBrowserBridgeToken, verifyCliBrowserBridgeToken } from "../src/cli-browser-bridge.js";
import { getApiConfig } from "../src/config.js";
import { decryptSecret, encryptSecret } from "../src/databases/crypto.js";
import { issueControlToken, verifyControlToken } from "../src/space-control-token.js";
import { loadGatewayConfig } from "../../../packages/gateway/src/config.js";

const context = { roomId: "room:aaaaaaaa", paneId: "pane:bbbbbbbb", cliSessionId: "cli_session:cccccccc" };
const savedEnv = { session: process.env.SPACE_SESSION_SECRET, connector: process.env.SPACE_CONNECTOR_SECRET };
afterEach(() => {
  for (const [key, value] of [["SPACE_SESSION_SECRET", savedEnv.session], ["SPACE_CONNECTOR_SECRET", savedEnv.connector]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

describe("one secret per purpose (security addendum step 9)", () => {
  it("signs agent tokens with their own secret, and with the internal token only while that is unset", () => {
    const own = { browserToolBridgeEnabled: true, internalApiToken: "internal-1", agentTokenSecret: "agents-1" };
    const token = issueCliBrowserBridgeToken(own, context)!;
    expect(verifyCliBrowserBridgeToken(own, token)).toMatchObject(context);
    // Knowing the internal token alone no longer forges an agent token.
    expect(verifyCliBrowserBridgeToken({ internalApiToken: "internal-1" }, token)).toBeNull();
    const legacy = { browserToolBridgeEnabled: true, internalApiToken: "internal-1" };
    expect(verifyCliBrowserBridgeToken(legacy, issueCliBrowserBridgeToken(legacy, context))).toMatchObject(context);
    expect(verifyControlToken("agents-1", issueControlToken("agents-1", context))).toMatchObject(context);
    expect(verifyControlToken("internal-1", issueControlToken("agents-1", context))).toBeNull();
    expect(getApiConfig({ SPACE_AGENT_TOKEN_SECRET: "agents-2", SPACE_GATEWAY_ADMIN_TOKEN: "gw-2" })).toMatchObject({ agentTokenSecret: "agents-2", gatewayAdminToken: "gw-2" });
  });

  it("gives the gateway admin its own token, falling back to the internal token", () => {
    expect(loadGatewayConfig({ SPACE_INTERNAL_API_TOKEN: "internal-1" }).internalToken).toBe("internal-1");
    expect(loadGatewayConfig({ SPACE_INTERNAL_API_TOKEN: "internal-1", SPACE_GATEWAY_ADMIN_TOKEN: "gw-1" }).internalToken).toBe("gw-1");
  });

  it("keeps stored database passwords readable across a session-secret rotation once the connector secret is pinned", () => {
    process.env.SPACE_SESSION_SECRET = "session-before-rotation";
    delete process.env.SPACE_CONNECTOR_SECRET;
    const sealed = encryptSecret("db-password");
    // The operator pins the connector secret to the old session secret, then rotates the session secret.
    process.env.SPACE_CONNECTOR_SECRET = "session-before-rotation";
    process.env.SPACE_SESSION_SECRET = "session-after-rotation";
    expect(decryptSecret(sealed)).toBe("db-password");
  });

  it("opens /api/internal/* to the internal token only from this host", async () => {
    const app = await createApp({ store: new InMemorySpaceStore(), config: getApiConfig({ SPACE_INTERNAL_API_TOKEN: "test-internal-token", SPACE_LOG_LEVEL: "silent" }),
      auth: { sessionSecret: "secret-per-purpose-test", devLogin: false, secureCookies: false } });
    try {
      const call = (remoteAddress: string, headers: Record<string, string> = {}) => app.inject({ method: "POST", url: "/api/internal/agent/browser-actions",
        remoteAddress, headers: { "x-space-internal-token": "test-internal-token", ...headers }, payload: {} });
      expect((await call("203.0.113.10")).json().error.code).toBe("INTERNAL_AUTH_REQUIRED");
      // Through the web proxy or nginx the real client counts, not the proxy's loopback address.
      expect((await call("127.0.0.1", { "x-forwarded-for": "203.0.113.10" })).json().error?.code).toBe("INTERNAL_AUTH_REQUIRED");
      expect((await call("127.0.0.1")).json().error?.code).not.toBe("INTERNAL_AUTH_REQUIRED");
    } finally {
      await app.close();
    }
  });
});
