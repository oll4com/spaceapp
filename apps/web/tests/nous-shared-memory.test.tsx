import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NousSharedMemory } from "../src/features/nous/NousSharedMemory.js";
import { announceUiLanguage } from "../src/features/ui-language/ui-language.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";

beforeEach(() => installSpaceRuntime(liveRuntime));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("reviews proposals, saves edits with a revision, and retires entries", async () => {
  let entry = { id: "nous_shared:test", title: "Evidence", body: "Verify the result.", tags: ["working"], source: "NOUS", status: "PROPOSED", revision: 1 };
  const changes: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (init?.method === "PATCH") { const patch = JSON.parse(String(init.body)); changes.push(patch); entry = { ...entry, ...patch, revision: entry.revision + 1 }; return new Response(JSON.stringify({ entry }), { status: 200 }); }
    return new Response(JSON.stringify({ entries: [entry], policy: { autoApprove: false, dailyUpgrade: true, lastDailyDay: null } }), { status: 200 });
  }));
  render(<NousSharedMemory />);
  fireEvent.click(await screen.findByRole("button", { name: "Manage entries…" }));
  await screen.findByText("Evidence");
  fireEvent.click(screen.getByRole("button", { name: "Approve Evidence" }));
  await waitFor(() => expect(changes[0]).toMatchObject({ revision: 1, status: "ACTIVE" }));
  await screen.findByText("Active", { selector: ".nous-shared-memory-state" });
  fireEvent.click(screen.getByRole("button", { name: "Edit Evidence" }));
  fireEvent.change(screen.getByLabelText("Memory text"), { target: { value: "Read the task list before closing a pane." } });
  fireEvent.click(screen.getByRole("button", { name: "Save entry" }));
  await waitFor(() => expect(changes[1]).toMatchObject({ revision: 2, body: "Read the task list before closing a pane." }));
  await screen.findByText("Read the task list before closing a pane.");
  fireEvent.click(screen.getByRole("button", { name: "Retire Evidence" }));
  await waitFor(() => expect(changes[2]).toMatchObject({ revision: 3, status: "RETIRED" }));
});
it("shows private-content validation and prevents saving private content", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ entries: [], policy: { autoApprove: false, dailyUpgrade: true } }), { status: 200 })));
  render(<NousSharedMemory />); fireEvent.click(await screen.findByRole("button", { name: "Manage entries…" }));
  fireEvent.click(screen.getByRole("button", { name: "Add entry" }));
  fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Evidence" } });
  fireEvent.change(screen.getByLabelText("Memory text"), { target: { value: "Ask Alice." } });
  fireEvent.blur(screen.getByLabelText("Memory text"));
  expect((await screen.findByRole("alert")).textContent).toMatch(/personal|names/);
  expect((screen.getByRole("button", { name: "Save entry" }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => {});
});

it("discards a stale edit on explicit reload and uses the new revision", async () => {
  const entry = { id: "nous_shared:test", title: "Evidence", body: "Verify the result.", tags: [], source: "NOUS", status: "ACTIVE", revision: 1 };
  let reads = 0; let writes = 0; let saved: unknown;
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (String(_url).includes("/api/auth/csrf")) return new Response(JSON.stringify({ csrfToken: "shared-test", headerName: "x-space-csrf-token" }), { status: 200 });
    if (init?.method === "PATCH") {
      if (++writes === 1) return new Response(JSON.stringify({ error: { message: "This entry changed. Reload and try again." } }), { status: 409 });
      saved = JSON.parse(String(init.body)); return new Response(JSON.stringify({ entry: { ...entry, revision: 3 } }), { status: 200 });
    }
    return new Response(JSON.stringify({ entries: [{ ...entry, revision: ++reads }], policy: { autoApprove: false, dailyUpgrade: true } }), { status: 200 });
  }));
  render(<NousSharedMemory />); fireEvent.click(await screen.findByRole("button", { name: "Manage entries…" })); await screen.findByText("Evidence");
  fireEvent.click(screen.getByRole("button", { name: "Edit Evidence" }));
  fireEvent.click(screen.getByRole("button", { name: "Save entry" })); await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Discard edits and reload" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Save entry" })).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Edit Evidence" }));
  fireEvent.click(screen.getByRole("button", { name: "Save entry" }));
  await waitFor(() => expect(saved).toMatchObject({ revision: 2 }));
});

it("keeps Settings to one summary row and opens the entries in a window with search and status filters", async () => {
  const row = (id: string, title: string, status: string) => ({ id, title, body: `${title} body.`, tags: [], source: "SEED", status, revision: 1 });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ entries: [row("a", "Hand out work once", "ACTIVE"), row("b", "Quota refusals wait", "ACTIVE"), row("c", "Scope waits", "PROPOSED")],
    policy: { autoApprove: false, dailyUpgrade: true } }), { status: 200 })));
  render(<NousSharedMemory />);
  await screen.findByText("2 active · 1 to approve");
  expect(screen.queryByText("Hand out work once")).toBeNull();
  expect(screen.getByRole("switch", { name: /Daily shared memory upgrade/ })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Manage entries…" }));
  const dialog = await screen.findByRole("dialog", { name: "Shared working knowledge" });
  expect(dialog.querySelectorAll("article")).toHaveLength(3);
  fireEvent.click(screen.getByRole("button", { name: /^Proposed/ }));
  expect([...dialog.querySelectorAll("article")].map((node) => node.getAttribute("aria-label"))).toEqual(["Scope waits"]);
  fireEvent.click(screen.getByRole("button", { name: /^All/ }));
  fireEvent.change(screen.getByRole("searchbox", { name: "Search entries" }), { target: { value: "quota" } });
  expect([...dialog.querySelectorAll("article")].map((node) => node.getAttribute("aria-label"))).toEqual(["Quota refusals wait"]);
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  act(() => announceUiLanguage("el"));
  expect(await screen.findByText("2 ενεργές · 1 προς έγκριση")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Διαχείριση εγγραφών…" })).toBeTruthy();
  act(() => announceUiLanguage("en"));
});
