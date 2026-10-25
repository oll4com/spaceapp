import { describe, expect, it } from "vitest";
import { auth, selectResourceURL } from "@modelcontextprotocol/sdk/client/auth.js";
import { checkResourceAllowed } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";

describe("MCP OAuth Security - GHSA-6qxp-vccf-f47h regression coverage", () => {
  it("rejects presenting credentials to an authorization server chosen by an untrusted MCP server", async () => {
    const trustedIssuer = "https://trusted-auth.space.local";
    const untrustedServerUrl = "https://mcp-server.example.com";
    const attackerAuthUrl = "https://attacker-auth.evil.com";

    // Mock provider holding client information bound to the trusted authorization server
    const mockProvider: OAuthClientProvider = {
      clientMetadata: {
        client_name: "Space MCP Client",
        redirect_uris: ["https://space.local/oauth/callback"]
      },
      clientInformation: () => ({
        client_id: "space-client-id-123",
        client_secret: "super-secret-credentials",
        issuer: trustedIssuer
      }),
      tokens: () => undefined,
      saveTokens: async () => {},
      redirectUrl: "https://space.local/oauth/callback"
    };

    // The untrusted MCP server advertises an attacker authorization server
    const mockFetch = (async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes(".well-known/oauth-protected-resource")) {
        return new Response(JSON.stringify({
          resource: untrustedServerUrl,
          authorization_servers: [attackerAuthUrl]
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      if (urlStr.includes(".well-known/oauth-authorization-server") || urlStr.includes(".well-known/openid-configuration")) {
        return new Response(JSON.stringify({
          issuer: attackerAuthUrl,
          authorization_endpoint: `${attackerAuthUrl}/authorize`,
          token_endpoint: `${attackerAuthUrl}/token`,
          response_types_supported: ["code"]
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      return new Response("Not Found", { status: 404 });
    }) as typeof fetch;

    await expect(auth(mockProvider, {
      serverUrl: untrustedServerUrl,
      fetchFn: mockFetch
    })).rejects.toThrow(/bound to authorization server https:\/\/trusted-auth\.space\.local and is not presented to https:\/\/attacker-auth\.evil\.com/);
  });

  it("never sends stored secrets to an untrusted authorization server during dynamic registration", async () => {
    const trustedIssuer = "https://trusted-auth.space.local";
    const untrustedServerUrl = "https://mcp-server.example.com";
    const attackerAuthUrl = "https://attacker-auth.evil.com";
    const capturedBodies: string[] = [];

    const mockProvider: OAuthClientProvider = {
      clientMetadata: {
        client_name: "Space MCP Client",
        redirect_uris: ["https://space.local/oauth/callback"]
      },
      clientInformation: () => ({
        client_id: "space-client-id-123",
        client_secret: "super-secret-credentials-never-leak",
        issuer: trustedIssuer
      }),
      saveClientInformation: async () => {},
      tokens: () => undefined,
      saveTokens: async () => {},
      saveCodeVerifier: async () => {},
      codeVerifier: () => "",
      redirectToAuthorization: async () => {},
      redirectUrl: "https://space.local/oauth/callback"
    };

    const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();
      if (init?.body) {
        capturedBodies.push(init.body.toString());
      }
      if (urlStr.includes(".well-known/oauth-protected-resource")) {
        return new Response(JSON.stringify({
          resource: untrustedServerUrl,
          authorization_servers: [attackerAuthUrl]
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (urlStr.includes(".well-known/oauth-authorization-server") || urlStr.includes(".well-known/openid-configuration")) {
        return new Response(JSON.stringify({
          issuer: attackerAuthUrl,
          authorization_endpoint: `${attackerAuthUrl}/authorize`,
          token_endpoint: `${attackerAuthUrl}/token`,
          registration_endpoint: `${attackerAuthUrl}/register`,
          response_types_supported: ["code"]
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (urlStr.includes("/register")) {
        return new Response(JSON.stringify({
          client_id: "attacker-issued-client-id",
          client_secret: "attacker-issued-secret",
          redirect_uris: ["https://space.local/oauth/callback"]
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("Not Found", { status: 404 });
    }) as typeof fetch;

    await auth(mockProvider, {
      serverUrl: untrustedServerUrl,
      fetchFn: mockFetch
    });

    // Ensure the pre-existing secret was NEVER sent to the attacker endpoint
    expect(capturedBodies.some((b) => b.includes("super-secret-credentials-never-leak"))).toBe(false);
  });

  it("enforces checkResourceAllowed to prevent cross-origin resource confusion", () => {
    // Exact match passes
    expect(checkResourceAllowed({
      requestedResource: "https://mcp.space.local/api",
      configuredResource: "https://mcp.space.local/api"
    })).toBe(true);

    // Subpath match passes
    expect(checkResourceAllowed({
      requestedResource: "https://mcp.space.local/api/tools",
      configuredResource: "https://mcp.space.local/api"
    })).toBe(true);

    // Cross-origin must be rejected
    expect(checkResourceAllowed({
      requestedResource: "https://mcp.space.local/api",
      configuredResource: "https://attacker.evil.com/api"
    })).toBe(false);

    // Different scheme must be rejected
    expect(checkResourceAllowed({
      requestedResource: "http://mcp.space.local/api",
      configuredResource: "https://mcp.space.local/api"
    })).toBe(false);

    // Different port must be rejected
    expect(checkResourceAllowed({
      requestedResource: "https://mcp.space.local:8443/api",
      configuredResource: "https://mcp.space.local:443/api"
    })).toBe(false);
  });

  it("selectResourceURL rejects protected resource metadata that fails origin/path constraints", async () => {
    const serverUrl = "https://mcp.space.local/v1";
    const provider: OAuthClientProvider = {
      clientMetadata: {
        client_name: "Space MCP Client",
        redirect_uris: ["https://space.local/oauth/callback"]
      },
      clientInformation: () => undefined,
      tokens: () => undefined,
      saveTokens: async () => {}
    };

    const attackerResourceMetadata = {
      resource: "https://attacker.evil.com/steal-token"
    };

    await expect(selectResourceURL(serverUrl, provider, attackerResourceMetadata)).rejects.toThrow(
      /Protected resource https:\/\/attacker\.evil\.com\/steal-token does not match expected https:\/\/mcp\.space\.local\/v1/
    );
  });
});
