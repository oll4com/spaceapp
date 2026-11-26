import { describe, expect, it, vi } from "vitest";
import type { Pane } from "@space/contracts";
import { typeCodeNow } from "../src/nous/code-delivery.js";
import { sameModelId } from "../src/pane-guards.js";
import type { RoomPaneObservation } from "../src/room-pane-control.js";

const pane = { id: "pane:NNvOJOATq74p" } as Pane;
const code = "Operator's one-time code for your needs-you (Braintrust authenticator): 481516";
const seen = (runtimeId: string, state: RoomPaneObservation["state"], text = "> ") =>
  ({ paneId: pane.id, title: "Jack", runtimeId, sessionId: "cli_session:jack", state, text } as RoomPaneObservation);
const typer = (first: RoomPaneObservation, after: RoomPaneObservation) => {
  const inspect = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(after);
  return { inspect, pressKeys: vi.fn(async () => undefined), wait: async () => undefined };
};

describe("a one-time code is typed into the pane at once (15/11 Dino/Jack: 3 Braintrust codes waited behind the turn that waited for them)", () => {
  it("a busy Antigravity gets alt+m, which sends now; Enter would queue the code behind the running turn", async () => {
    const deps = typer(seen("cli:gemini", "RUNNING"), seen("cli:gemini", "RUNNING"));
    expect(await typeCodeNow(deps, pane, code, "trace:1")).toBeNull();
    expect(deps.pressKeys.mock.calls.map((call) => call[1])).toEqual([code, "\u001bm"]);
  });

  it("a busy Claude Code and any idle CLI get Enter, which takes the line into the turn or submits it", async () => {
    for (const first of [seen("cli:claude", "RUNNING"), seen("cli:gemini", "IDLE"), seen("cli:codex", "WAITING_FOR_INPUT")]) {
      const deps = typer(first, first);
      expect(await typeCodeNow(deps, pane, code, "trace:1")).toBeNull();
      expect(deps.pressKeys.mock.calls.map((call) => call[1])).toEqual([code, "\r"]);
    }
  });

  it("says why when the code cannot arrive: no CLI, a stopped CLI, or a composer that kept it", async () => {
    expect(await typeCodeNow(typer({ ...seen("cli:gemini", "IDLE"), sessionId: null }, seen("cli:gemini", "IDLE")), pane, code, "t")).toBe("the pane runs no CLI");
    const exited = typer(seen("cli:gemini", "EXITED"), seen("cli:gemini", "EXITED"));
    expect(await typeCodeNow(exited, pane, code, "t")).toBe("its CLI is exited");
    expect(exited.pressKeys).not.toHaveBeenCalled();
    expect(await typeCodeNow(typer(seen("cli:claude", "RUNNING"), seen("cli:claude", "RUNNING", `❯ ${code}`)), pane, code, "t")).toBe("it stayed in the pane's composer");
  });
});

it("the model guards read a \"-high\" suffix as the same model (15/11: gemini-3.8-flash vs gemini-3.8-flash-high)", () => {
  expect(sameModelId("gemini-3.8-flash", "gemini-3.8-flash-high")).toBe(true);
  expect(sameModelId("gemini-3.8-flash-high", "gemini-3.8-flash-high")).toBe(true);
  expect(sameModelId(null, undefined)).toBe(true);
  expect(sameModelId("gemini-3.8-flash", "gemini-3.8-flash-low")).toBe(false);
  expect(sameModelId("gemini-3.8-flash", null)).toBe(false);
});
