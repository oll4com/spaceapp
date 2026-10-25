import { useEffect } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DemoSpaceApp } from "../src/demo/DemoSpaceApp.js";
import { demoRuntimeBundle } from "../src/demo/demo-runtime.js";

const observations = vi.hoisted(() => new Map<string, { renders: number; generation: number }>());
vi.mock("../src/features/terminal-pane/index.js", () => ({
  createTerminalBootstrapBarrier: () => ({
    join: () => ({ arrive: async () => undefined }),
    waitForTerminalSetupTask: async () => undefined
  }),
  TerminalPane: ({ pane, revealGeneration, onBootstrapped, onPrefillReadyChange }: {
    pane: { id: string; title: string }; revealGeneration: number;
    onBootstrapped: (id: string) => void;
    onPrefillReadyChange: (id: string, ready: boolean) => void;
  }) => {
    observations.set(pane.id, { renders: (observations.get(pane.id)?.renders ?? 0) + 1, generation: revealGeneration });
    useEffect(() => {
      onBootstrapped(pane.id);
      onPrefillReadyChange(pane.id, true);
    }, [pane.id, onBootstrapped, onPrefillReadyChange]);
    return <section data-testid={pane.id}>{pane.title}</section>;
  }
}));

afterEach(() => {
  cleanup();
  demoRuntimeBundle.runtime.reset();
  observations.clear();
  vi.restoreAllMocks();
});

it("keeps a third resident room memoized during A/B switches and gives it the current generation on return", async () => {
  const runtime = demoRuntimeBundle.runtime;
  await runtime.api.updateUserSettings({ warmRoomEnabled: true });
  runtime.platform.localStorage.setItem("space.warmRoom.enabled.v1", "true");
  const rooms = (await runtime.api.rooms()).data.slice(0, 3);
  const fixtures = await Promise.all(rooms.map(room => runtime.api.createRoomPanes(room.id, {
    panes: [{ mode: "TERMINAL", terminalRuntimeId: "cli:codex" }]
  })));
  const paneId = fixtures[2]!.data[0]!.id;
  const view = render(<DemoSpaceApp />);
  const select = async (index: number) => {
    if (!screen.queryByRole("button", { name: `Open ${rooms[index]!.name}` })) {
      fireEvent.click(await screen.findByRole("button", { name: "Open rooms" }));
    }
    fireEvent.click(await screen.findByRole("button", { name: `Open ${rooms[index]!.name}` }));
    await waitFor(() => expect(view.container.querySelector(
      `.room-runtime-layer[data-room-runtime-id="${rooms[index]!.id}"]`
    )?.getAttribute("data-presentation-state")).toBe("displayed"));
  };
  await select(2);
  expect(observations.get(paneId)?.generation).toBeGreaterThan(0);
  await select(0);
  const resident = screen.getByTestId(paneId);
  const before = observations.get(paneId)!.renders;
  await select(1);
  await select(0);
  expect(screen.getByTestId(paneId)).toBe(resident);
  expect(observations.get(paneId)!.renders).toBe(before);
  await select(2);
  expect(screen.getByTestId(paneId)).toBe(resident);
  expect(observations.get(paneId)!.generation).toBe(Number(
    view.container.querySelector("[data-presentation-generation]")?.getAttribute("data-presentation-generation")
  ));
  // Loading the demo app exceeds the default 5 s under test-runner load; no behaviour change.
}, 30_000);
