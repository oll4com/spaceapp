import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginsSettingsCard } from "../src/features/plugins/PluginsSettingsCard.js";
import { repositoryProviderRegistry, type PluginWithState, type RepositoryProviderState } from "@space/contracts";

function providerStates(): RepositoryProviderState[] {
  return repositoryProviderRegistry.map(descriptor => ({ ...descriptor, enabled: descriptor.defaultEnabled,
    connection: { provider: descriptor.id, serverUrl: descriptor.defaultServerUrl, status: "NOT_CONNECTED", accountLogin: null, connectedAt: null, checkedAt: null, error: null } }));
}

const mockPlugins: PluginWithState[] = [
  {
    id: "superpowers",
    displayName: "Superpowers",
    description: "Systematic agent development skills: brainstorming, TDD, debugging.",
    overview: "Core agent engineering toolkit by Jesse Vincent. Contains 15 battle-tested agent skills.",
    category: "developer",
    icon: "Zap",
    authType: "none",
    authFields: [],
    preview: false,
    defaultEnabled: true,
    websiteUrl: "https://github.com/obra/superpowers",
    docsUrl: "https://github.com/obra/superpowers#readme",
    githubUrl: "https://github.com/obra/superpowers",
    installedVersion: "2.4.0",
    latestVersion: "2.4.0",
    hasUpdate: false,
    mcpCommand: null,
    mcpArgs: [],
    connection: {
      pluginId: "superpowers",
      status: "CONNECTED",
      connectedAt: "2026-10-02T09:38:58.249Z",
      lastHealthCheckAt: null,
      accountLabel: "Built-in (Active)",
      toolCount: 15,
      installedVersion: "2.4.0",
      latestVersion: "2.4.0",
      hasUpdate: false,
      error: null
    }
  },
  {
    id: "x",
    displayName: "X",
    description: "Post, reply, inspect timelines, and search public posts.",
    overview: "X (Twitter) Developer API integration for posting and searching.",
    category: "communication",
    icon: "Share2",
    authType: "api_key",
    authFields: [
      {
        key: "bearerToken",
        label: "Bearer Token",
        type: "password",
        required: true,
        placeholder: "...",
        description: "X Developer portal Bearer Token."
      }
    ],
    preview: true,
    defaultEnabled: false,
    websiteUrl: "https://x.com",
    docsUrl: "https://developer.x.com",
    githubUrl: "https://github.com/xdevplatform",
    installedVersion: "0.1.0",
    latestVersion: "0.1.0",
    hasUpdate: false,
    mcpCommand: null,
    mcpArgs: [],
    connection: {
      pluginId: "x",
      status: "NOT_CONNECTED",
      connectedAt: null,
      lastHealthCheckAt: null,
      accountLabel: null,
      toolCount: 0,
      installedVersion: "0.1.0",
      latestVersion: "0.1.0",
      hasUpdate: false,
      error: null
    }
  },
  {
    id: "github",
    displayName: "GitHub",
    description: "Search issues, open PRs, manage repos, and view CI/CD workflows.",
    overview: "Official Model Context Protocol server for GitHub.",
    category: "developer",
    icon: "GitBranch",
    authType: "api_key",
    authFields: [
      {
        key: "token",
        label: "Personal Access Token",
        type: "password",
        required: true,
        placeholder: "ghp_...",
        description: "GitHub personal access token with repo scope."
      }
    ],
    preview: false,
    defaultEnabled: false,
    websiteUrl: "https://github.com",
    docsUrl: "https://docs.github.com",
    githubUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/github",
    installedVersion: "0.6.2",
    latestVersion: "0.6.2",
    hasUpdate: false,
    mcpCommand: "npx",
    mcpArgs: ["-y", "@modelcontextprotocol/server-github"],
    connection: {
      pluginId: "github",
      status: "NOT_CONNECTED",
      connectedAt: null,
      lastHealthCheckAt: null,
      accountLabel: null,
      toolCount: 0,
      installedVersion: "0.6.2",
      latestVersion: "0.6.2",
      hasUpdate: false,
      error: null
    }
  }
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PluginsSettingsCard", () => {
  it("renders plugin cards with preview, connect, and connected badges correctly", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url === "/api/plugins") {
          return Promise.resolve(new Response(JSON.stringify(mockPlugins), { status: 200 }));
        }
        if (url === "/api/source-control/providers") {
          return Promise.resolve(new Response(JSON.stringify(providerStates()), { status: 200 }));
        }
        return Promise.reject(new Error(`Unhandled: ${url}`));
      })
    );

    const view = render(<PluginsSettingsCard />);

    await waitFor(() => {
      expect(screen.getByText("Superpowers")).toBeTruthy();
      expect(screen.getByText("X")).toBeTruthy();
      expect(screen.getByText("GitHub")).toBeTruthy();
    });
    // Repository providers render once, in their own group with a personal toggle, never in the generic grid.
    expect(view.container.querySelector('.plugin-card[data-plugin-id="github"]')).toBeNull();
    const github = view.container.querySelector('.repository-provider-card[data-provider-id="github"]') as HTMLElement;
    expect(github.textContent).toContain("Setup required");
    expect(view.container.querySelectorAll(".repository-provider-card")).toHaveLength(6);
    expect((screen.getByRole("switch", { name: "Enable GitLab" }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole("switch", { name: "Enable GitHub" }) as HTMLInputElement).checked).toBe(true);

    // Check Connected badge for Superpowers
    const connectedBadge = screen.getByTitle("Connected • Click to inspect or configure");
    expect(connectedBadge).toBeTruthy();
    expect(connectedBadge.textContent).toContain("Connected");

    // Check Preview badge for X
    expect(screen.getByText("Preview")).toBeTruthy();

    // Check Connect button for GitHub
    const connectButtons = screen.getAllByRole("button", { name: /Connect/i });
    expect(connectButtons.length).toBeGreaterThan(0);
  });

  it("displays Overview, GitHub link and the pinned version in the modal, and runs Test Connection", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, options?: RequestInit) => {
      if (url === "/api/plugins") {
        return Promise.resolve(new Response(JSON.stringify(mockPlugins), { status: 200 }));
      }
      if (url === "/api/auth/csrf") {
        return Promise.resolve(
          new Response(JSON.stringify({ csrfToken: "csrf-token-test", headerName: "x-space-csrf-token" }), {
            status: 200
          })
        );
      }
      if (url === "/api/plugins/superpowers/test" && options?.method === "POST") {
        const headers = options.headers as Record<string, string>;
        expect(headers["x-space-csrf-token"]).toBeTruthy();
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ok: true,
              message: "Superpowers: 15 skills installed from /opt/spaceapp/agent-skills/space-superpowers, upstream f5f6953.",
              toolCount: 15
            }),
            { status: 200 }
          )
        );
      }
      return Promise.reject(new Error(`Unhandled: ${url}`));
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<PluginsSettingsCard />);

    await waitFor(() => {
      expect(screen.getByText("Superpowers")).toBeTruthy();
    });

    // Click Superpowers Connected badge to open modal
    const connectedBadge = screen.getByTitle("Connected • Click to inspect or configure");
    fireEvent.click(connectedBadge);

    await waitFor(() => {
      expect(screen.getByText("Superpowers Settings")).toBeTruthy();
      // Overview text should be rendered
      expect(screen.getByText(/Core agent engineering toolkit by Jesse Vincent/i)).toBeTruthy();
      // GitHub link should be rendered
      const githubLink = screen.getByRole("link", { name: /GitHub/i });
      expect(githubLink).toBeTruthy();
      expect(githubLink.getAttribute("href")).toBe("https://github.com/obra/superpowers");
      // The pinned version is shown read-only: built-in plugins update with SpaceApp releases.
      expect(screen.getAllByText("2.4.0").length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText("Updates with SpaceApp releases.")).toBeTruthy();
      expect(screen.queryByTitle("Check for updates")).toBeNull();
      expect(screen.getByRole("button", { name: /Test Connection/i })).toBeTruthy();
    });

    // Click Test Connection
    const testBtn = screen.getByRole("button", { name: /Test Connection/i });
    fireEvent.click(testBtn);

    await waitFor(() => {
      expect(screen.getByText("Superpowers: 15 skills installed from /opt/spaceapp/agent-skills/space-superpowers, upstream f5f6953.")).toBeTruthy();
    });
  });

  it("handles Disconnect with CSRF token and updates plugins list", async () => {
    let pluginsState = [...mockPlugins];
    const fetchMock = vi.fn().mockImplementation((url: string, options?: RequestInit) => {
      if (url === "/api/plugins") {
        return Promise.resolve(new Response(JSON.stringify(pluginsState), { status: 200 }));
      }
      if (url === "/api/auth/csrf") {
        return Promise.resolve(
          new Response(JSON.stringify({ csrfToken: "csrf-token-test", headerName: "x-space-csrf-token" }), {
            status: 200
          })
        );
      }
      if (url === "/api/plugins/superpowers/disconnect" && options?.method === "POST") {
        const headers = options.headers as Record<string, string>;
        expect(headers["x-space-csrf-token"]).toBeTruthy();
        pluginsState = pluginsState.map((p) =>
          p.id === "superpowers"
            ? { ...p, connection: { ...p.connection, status: "NOT_CONNECTED", toolCount: 0 } }
            : p
        );
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      }
      return Promise.reject(new Error(`Unhandled: ${url}`));
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<PluginsSettingsCard />);

    await waitFor(() => {
      expect(screen.getByText("Superpowers")).toBeTruthy();
    });

    // Open Superpowers modal
    const connectedBadge = screen.getByTitle("Connected • Click to inspect or configure");
    fireEvent.click(connectedBadge);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Disconnect/i })).toBeTruthy();
    });

    // Click Disconnect
    const disconnectBtn = screen.getByRole("button", { name: /Disconnect/i });
    fireEvent.click(disconnectBtn);

    await waitFor(() => {
      // Modal should be closed
      expect(screen.queryByText("Superpowers Settings")).toBeNull();
    });
  });

});

describe("PluginsSettingsCard for accounts that cannot manage the installation", () => {
  it("shows plugins read-only: no Upgrade All, Connect, Disconnect or update actions", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url === "/api/plugins") return Promise.resolve(new Response(JSON.stringify(mockPlugins), { status: 200 }));
        if (url === "/api/source-control/providers") return Promise.resolve(new Response(JSON.stringify(providerStates()), { status: 200 }));
        return Promise.reject(new Error(`Unhandled: ${url}`));
      })
    );

    const view = render(<PluginsSettingsCard canManage={false} />);
    await waitFor(() => expect(screen.getByText("Superpowers")).toBeTruthy());
    expect(screen.getByRole("note").textContent).toBe("Only an administrator can change installation plugins.");
    expect(screen.queryByRole("button", { name: /Upgrade All/i })).toBeNull();
    expect(view.container.querySelector(".plugin-connect-btn")).toBeNull();

    fireEvent.click(screen.getByTitle("Connected • Click to inspect or configure"));
    await waitFor(() => expect(screen.getByRole("button", { name: /Test Connection/i })).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
    expect(screen.queryByTitle("Check for updates")).toBeNull();
  });
});
