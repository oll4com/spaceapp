import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DotProfile } from "@space/contracts";
import { DotInfoCard } from "../src/features/agent-pane/DotInfoCard.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";

// The probe cases (tests/dots-dom.mjs, the proof's page function) are in dots-proof-probe-dom.test.tsx.
vi.mock("../src/api.js", () => ({ api: {
  channels: vi.fn(async () => ({ providers: [], identities: [], threads: [] })),
  dotToolInvocations: vi.fn(async (dotId: string) => ({ dotId, items: [] })), dotDeliverables: vi.fn(async (dotId: string) => ({ dotId, items: [] })),
  dotComputer: vi.fn(async (dotId: string) => ({ dotId, workspace: { path: "/opt/spaceapp/var/dots/x", exists: false, entries: [], totalEntries: 0, sortedAll: true },
    runs: [], goals: [], browsers: [], limits: { maxConcurrentTasks: 2, activeTasks: 0 } })),
  artifactFileUrl: (id: string) => `/api/artifacts/${id}/file`, agentFileDownloadUrl: (id: string) => `/api/agent-files/${id}/download`
} }));
vi.mock("../src/features/voice-input/VoiceInputProvider.js", () => ({ useOptionalVoiceInput: () => null, useVoiceInput: () => ({}) }));
beforeEach(() => {
  installSpaceRuntime(liveRuntime);
  // jsdom has no layout: every rendered element counts as visible for the probe.
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{ width: 10, height: 10 }] as unknown as DOMRectList);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const dot = { dotId: `dot:${"1".repeat(32)}`, name: "Orbit", slot: 1, appearance: { character: "astronaut", accent: "slate" },
  preferences: {}, workLimits: { maxConcurrentTasks: 1, dailyBudgetUsd: null } } as unknown as DotProfile;

describe("Dots proof probe", () => {
  it("keeps the owner's actions and files out of an Agent Proof room's card", async () => {
    const { api } = await import("../src/api.js");
    vi.mocked(api.dotToolInvocations).mockClear(); vi.mocked(api.dotDeliverables).mockClear();
    render(<DotInfoCard dot={dot} roomId="room:proof" visible working={false} lastActiveAt={null} sessionId={null} onCall={() => {}}
      callDisabledReason={null} onClose={() => {}} overlay={false} roomScoped />);
    expect(await screen.findByRole("region", { name: "Computers" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Recent activity" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Outputs" })).toBeNull();
    expect(api.dotToolInvocations).not.toHaveBeenCalled();
    expect(api.dotDeliverables).not.toHaveBeenCalled();
  });
});
