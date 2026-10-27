import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { SourceControlConnection, SourceControlProvider } from "@space/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SourceControlPublishingCard,
  type SourceControlPublishingClient
} from "../src/features/source-control-publishing/SourceControlPublishingCard.js";

const writeOnlyToken = "test_token_123456789012345678901234";

function connection(
  provider: SourceControlProvider,
  status: SourceControlConnection["status"]
): SourceControlConnection {
  const connected = status !== "DISCONNECTED";
  return {
    provider,
    repositoryOwner: "example-org",
    repositoryName: "space-test",
    accountLogin: connected ? "example-org" : null,
    status,
    secretConfigured: connected,
    lastVerifiedAt: connected ? "2026-07-23T08:00:00.000Z" : null,
    lastVerificationCode: connected ? "VERIFIED" : "NOT_VERIFIED",
    updatedAt: "2026-07-23T08:00:00.000Z"
  };
}

function createClient(): SourceControlPublishingClient {
  return {
    listSourceControlConnections: vi.fn(async () => ({
      data: [connection("gitea", "CONNECTED"), connection("github", "DISCONNECTED")]
    })),
    replaceSourceControlConnection: vi.fn(async (provider) => connection(provider, "CONNECTED")),
    verifySourceControlConnection: vi.fn(async (provider) => connection(provider, "CONNECTED")),
    disconnectSourceControlConnection: vi.fn(async (provider) => connection(provider, "DISCONNECTED"))
  };
}

afterEach(cleanup);

describe("SourceControlPublishingCard", () => {
  it("stores write-only credentials, verifies connections, and confirms disconnect", async () => {
    const client = createClient();
    render(<SourceControlPublishingCard canManage client={client} />);

    const card = await screen.findByLabelText("Source control publishing");
    expect(within(card).getAllByText("example-org/space-test")).toHaveLength(2);
    expect(within(card).queryByLabelText("Gitea access token")).toBeNull();
    expect(within(card).queryByLabelText("GitHub access token")).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "Connect GitHub" }));
    const githubToken = within(card).getByLabelText("GitHub access token") as HTMLInputElement;
    expect(githubToken.type).toBe("password");
    expect(githubToken.autocomplete).toBe("new-password");

    fireEvent.change(githubToken, { target: { value: writeOnlyToken } });
    fireEvent.submit(within(card).getByRole("form", { name: "Connect GitHub publishing" }));
    await waitFor(() => expect(client.replaceSourceControlConnection).toHaveBeenCalledWith("github", writeOnlyToken));
    expect(within(card).queryByDisplayValue(writeOnlyToken)).toBeNull();
    expect(card.textContent).not.toContain(writeOnlyToken);

    fireEvent.click(within(card).getByRole("button", { name: "Gitea publishing actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Verify Gitea" }));
    await waitFor(() => expect(client.verifySourceControlConnection).toHaveBeenCalledWith("gitea"));

    fireEvent.click(within(card).getByRole("button", { name: "Gitea publishing actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Disconnect Gitea" }));
    fireEvent.click(within(card).getByRole("button", { name: "Confirm Gitea disconnect" }));
    await waitFor(() => expect(client.disconnectSourceControlConnection).toHaveBeenCalledWith("gitea"));
  });

  it("keeps credential mutations admin-only", () => {
    const client = createClient();
    render(<SourceControlPublishingCard canManage={false} client={client} />);

    expect(screen.queryByLabelText("Source control publishing")).toBeNull();
    expect(client.listSourceControlConnections).not.toHaveBeenCalled();
  });

  it("keeps a verification failure visible after refreshing connection state", async () => {
    const client = createClient();
    vi.mocked(client.verifySourceControlConnection).mockRejectedValue(new Error("Credential verification was rejected."));
    render(<SourceControlPublishingCard canManage client={client} />);

    const card = await screen.findByLabelText("Source control publishing");
    fireEvent.click(within(card).getByRole("button", { name: "Gitea publishing actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Verify Gitea" }));

    expect((await within(card).findByRole("alert")).textContent).toContain("Credential verification was rejected.");
    expect(client.listSourceControlConnections).toHaveBeenCalledTimes(2);
  });
});
