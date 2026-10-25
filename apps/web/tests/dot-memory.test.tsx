import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DotMemory, DotProfile } from "@space/contracts";
import { DotMemoryPanel } from "../src/features/agent-pane/DotMemory.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";

vi.setConfig({ testTimeout: 30_000 });
beforeEach(() => installSpaceRuntime(liveRuntime));
afterEach(cleanup);
const dot = { dotId: `dot:${"1".repeat(32)}`, name: "Luna" } as DotProfile;
const at = "2026-10-11T08:00:00.000Z";
const memory = (overrides: Partial<DotMemory>): DotMemory => ({ memoryId: `dot_memory:${"0".repeat(32)}`, dotId: dot.dotId, scope: "DOT", projectKey: null,
  text: "Prefers short answers", source: "USER", sourceRef: null, createdAt: at, updatedAt: at, ...overrides });

describe("Dot memory panel", () => {
  it("lists memories with scope and source, and filters and searches them", async () => {
    const items = [memory({}), memory({ memoryId: `dot_memory:${"1".repeat(32)}`, scope: "PROJECT", projectKey: "/srv/app", text: "Deploy with npm run ship", source: "DOT" }),
      memory({ memoryId: `dot_memory:${"2".repeat(32)}`, dotId: null, scope: "SHARED", text: "Team time zone is Europe/Athens" })];
    const read = vi.fn(async () => ({ dotId: dot.dotId, items }));
    render(<DotMemoryPanel dot={dot} roomId="room:1" read={read} create={vi.fn()} update={vi.fn()} remove={vi.fn()} />);
    expect(await screen.findByText("Prefers short answers")).toBeTruthy();
    expect(screen.getByText(/Project · \/srv\/app · Saved by Luna/)).toBeTruthy();
    expect(screen.getByText(/Shared with all Dots · Added by you/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Shared" }));
    await waitFor(() => expect(read).toHaveBeenLastCalledWith(dot.dotId, { scope: "SHARED", q: "" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search memories" }), { target: { value: "deploy" } });
    await waitFor(() => expect(read).toHaveBeenLastCalledWith(dot.dotId, { scope: "SHARED", q: "deploy" }));
  });

  it("adds, edits and permanently forgets a memory after confirmation", async () => {
    let items = [memory({})];
    const read = vi.fn(async () => ({ dotId: dot.dotId, items }));
    const create = vi.fn(async (_dot: string, input: { text: string; scope: DotMemory["scope"] }) => {
      const created = memory({ memoryId: `dot_memory:${"3".repeat(32)}`, text: input.text, scope: input.scope, projectKey: "/srv/app" });
      items = [created, ...items]; return { memory: created };
    });
    const update = vi.fn(async (_dot: string, memoryId: string, text: string) => {
      items = items.map((item) => item.memoryId === memoryId ? { ...item, text } : item); return { memory: items[0]! };
    });
    const remove = vi.fn(async (_dot: string, memoryId: string) => { items = items.filter((item) => item.memoryId !== memoryId); return { memoryId, deleted: true }; });
    render(<DotMemoryPanel dot={dot} roomId="room:1" read={read} create={create as never} update={update as never} remove={remove as never} />);
    await screen.findByText("Prefers short answers");
    fireEvent.click(screen.getByRole("button", { name: "Add memory" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Memory text" }), { target: { value: "Invoices go out on the 5th" } });
    fireEvent.click(screen.getByRole("button", { name: "This room's project" }));
    fireEvent.click(screen.getByRole("button", { name: "Save memory" }));
    await waitFor(() => expect(create).toHaveBeenCalledWith(dot.dotId, { text: "Invoices go out on the 5th", scope: "PROJECT", roomId: "room:1" }));
    expect(await screen.findByText("Invoices go out on the 5th")).toBeTruthy();

    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[1]!);
    fireEvent.change(screen.getByRole("textbox", { name: "Edit memory" }), { target: { value: "Prefers bullet lists" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(dot.dotId, `dot_memory:${"0".repeat(32)}`, "Prefers bullet lists"));
    expect(await screen.findByText("Prefers bullet lists")).toBeTruthy();

    fireEvent.click(screen.getAllByRole("button", { name: "Forget" })[1]!);
    expect(screen.getByText("Forget this memory permanently?")).toBeTruthy();
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(screen.queryByText("Forget this memory permanently?")).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: "Forget" })[1]!);
    fireEvent.click(within(screen.getByRole("group", { name: "Confirm forgetting" })).getByRole("button", { name: "Forget" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith(dot.dotId, `dot_memory:${"0".repeat(32)}`));
    await waitFor(() => expect(screen.queryByText("Prefers bullet lists")).toBeNull());
  });

  it("shows save errors and an unavailable state with retry", async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValue({ dotId: dot.dotId, items: [] });
    const create = vi.fn(async () => { throw new Error("This room has no project, so the memory cannot belong to one."); });
    render(<DotMemoryPanel dot={dot} roomId="room:1" read={read} create={create as never} update={vi.fn()} remove={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await screen.findByText("No memories yet.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add memory" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Memory text" }), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Save memory" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/no project/);
  });
});

describe("Connected accounts", () => {
  it("lists accounts, builds a consent link for the chosen permissions and disconnects after confirmation", async () => {
    const { DotConnections } = await import("../src/features/agent-pane/DotConnections.js");
    let accounts = [{ accountId: `connector:${"1".repeat(32)}`, provider: "GOOGLE" as const, email: "owner@example.com",
      capabilities: ["MAIL_READ" as const, "CALENDAR" as const], connectedAt: at }];
    const read = vi.fn(async () => ({ providers: [{ provider: "GOOGLE" as const, configured: true, reason: null },
      { provider: "MICROSOFT" as const, configured: false, reason: "Microsoft needs an app registration on this server." }], accounts }));
    const disconnect = vi.fn(async (accountId: string) => { accounts = []; return { accountId, disconnected: true }; });
    render(<DotConnections read={read} disconnect={disconnect as never} />);
    expect(await screen.findByText("owner@example.com")).toBeTruthy();
    expect(screen.getByText("Google · Read email, Calendar")).toBeTruthy();
    expect(screen.getByText("Microsoft: not set up on this server yet.")).toBeTruthy();
    expect(screen.getByText("How to set it up").closest("details")?.textContent).toContain("Microsoft needs an app registration");
    expect(screen.getByRole("link", { name: "Connect Google" }).getAttribute("href"))
      .toBe("/api/connectors/google/start?capabilities=MAIL_READ%2CMAIL_COMPOSE%2CCALENDAR");
    fireEvent.click(screen.getByRole("button", { name: "Draft and send email" }));
    expect(screen.getByRole("link", { name: "Connect Google" }).getAttribute("href")).toBe("/api/connectors/google/start?capabilities=MAIL_READ%2CCALENDAR");
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(disconnect).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("group", { name: "Confirm disconnecting" })).getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(disconnect).toHaveBeenCalledWith(`connector:${"1".repeat(32)}`));
    expect(await screen.findByText("No accounts connected.")).toBeTruthy();
    expect(screen.getByText("Google says “Access blocked”?")).toBeTruthy();
  });
  it("explains the result of returning from a provider sign-in", async () => {
    const { connectorResultMessage } = await import("../src/features/agent-pane/connector-result.js");
    expect(connectorResultMessage(null)).toBeNull();
    expect(connectorResultMessage("connected")).toMatchObject({ tone: "notice", text: expect.stringMatching(/^Account connected/) });
    expect(connectorResultMessage("cancelled")).toMatchObject({ tone: "error", text: expect.stringMatching(/cancelled or the provider refused it/) });
    expect(connectorResultMessage("connector_sign_in_expired")?.text).toMatch(/expired before it finished/);
    expect(connectorResultMessage("connector_provider_error")).toMatchObject({ tone: "error", text: expect.stringMatching(/could not be connected/) });
    // Job Copilot Setup → Google account starts the flow with source=job-copilot.
    expect(connectorResultMessage("connected", "job-copilot")).toMatchObject({ tone: "notice", text: expect.stringMatching(/^Gmail and Calendar allowed\. Job Copilot/) });
    expect(connectorResultMessage("cancelled", "job-copilot")?.text).toMatch(/Open Job Copilot Setup → Google account/);
    expect(connectorResultMessage("session", "job-copilot")?.text).toMatch(/different Space session/);
    expect(connectorResultMessage("connector_provider_error", "job-copilot")?.text).toMatch(/^Gmail and Calendar could not be allowed/);
  });
});
