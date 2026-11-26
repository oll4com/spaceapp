import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NousOverview } from "@space/contracts";
import { NousPlanMap } from "../src/features/nous/NousPlanMap.js";

afterEach(cleanup);
type Plan = NousOverview["plans"][number];
type Holds = NonNullable<NousOverview["planHolds"]>;
const plan = (id: string, title: string, patch: Partial<Plan> = {}): Plan =>
  ({ id: `clipboard:${id}`, title, progress: 0, status: "PLANNED", room: null, pane: null, nextStep: null, level: 0, dependsOn: [], dueAt: null, overdue: false, hold: null, ...patch });
const overview = (plans: Plan[], holds: Partial<Holds> = {}): NousOverview =>
  ({ plans, needsHands: [], trains: "", planMap: null, planHolds: { holds: [], unblockFirst: [], dates: [], ...holds } });
const tailscale = { kind: "OPERATOR" as const, what: "Connect Tailscale to the Greek HP", until: null, source: "PANE" as const };

describe("the Plans view's plan map (operator request 2026-10-25)", () => {
  it("groups plans by what they wait on, with what you must do first in front, and opens a plan from its row or a chip", () => {
    const onOpen = vi.fn();
    render(<NousPlanMap onOpen={onOpen} overview={overview([
      plan("free", "Free plan", { pane: "Andy", room: "Cleo" }), plan("date", "Kept for Monday", { hold: { kind: "DATE", what: "the Monday check", until: "2026-10-26T02:00:00.000Z", source: "PANE" } }),
      plan("dr", "Greece DR fixes", { hold: tailscale }), plan("copy", "Greece DR copy", { level: 1, dependsOn: ["clipboard:dr"], paneClosed: true, hold: { kind: "PLAN", what: "Greece DR fixes", until: null, source: "DEPENDENCY" } })
    ], { unblockFirst: [{ kind: "OPERATOR", what: tailscale.what, planIds: ["clipboard:dr"], unsticks: 2 }] })} />);
    expect(screen.getAllByRole("heading", { level: 4 }).map((heading) => heading.textContent)).toEqual(["Waits on you1", "Waits on another plan1", "Waits for a date1", "No wait recorded1"]);
    expect(screen.getByText("1 wait on you")).toBeTruthy();
    // Only an open pane is named; a plan whose pane closed says so (operator request 2026-10-26).
    expect(screen.getByText("Andy · Cleo")).toBeTruthy();
    expect(screen.getByText("Pane closed")).toBeTruthy();
    expect(screen.getAllByText("No pane")).toHaveLength(2);
    // The wait for a date is not a blocker; the operator's own wait is.
    const blockers = within(screen.getByRole("region", { name: "Unblock first" }).querySelector("ol")!).getAllByRole("listitem");
    expect(blockers.map((item) => item.textContent)).toEqual([`You${tailscale.what}HoldsGreece DR fixes2 plans`]);
    fireEvent.click(within(blockers[0]!).getByRole("button", { name: "Greece DR fixes" }));
    expect(onOpen).toHaveBeenLastCalledWith("clipboard:dr");
    fireEvent.click(screen.getByRole("button", { name: /^Open the plan Kept for Monday, 0%, waits for a date/ }));
    expect(onOpen).toHaveBeenLastCalledWith("clipboard:date");
  });

  it("draws the diagram on request: a box per blocker, the plans it holds and their dependents, an arrow for each link; the list comes back", () => {
    const onOpen = vi.fn();
    render(<NousPlanMap onOpen={onOpen} overview={overview([
      plan("dr", "Greece DR fixes", { hold: tailscale }), plan("copy", "Greece DR copy", { level: 1, dependsOn: ["clipboard:dr"], hold: { kind: "PLAN", what: "Greece DR fixes", until: null, source: "DEPENDENCY" } }),
      plan("free", "Free plan")
    ], { unblockFirst: [{ kind: "OPERATOR", what: tailscale.what, planIds: ["clipboard:dr"], unsticks: 2 }] })} />);
    fireEvent.click(screen.getByRole("button", { name: "Diagram" }));
    const diagram = screen.getByRole("group", { name: "Plan dependencies" });
    expect(diagram.querySelectorAll(".nous-diagram-node.is-blocker")).toHaveLength(1);
    expect(within(diagram).getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual(["Open the plan Greece DR fixes", "Open the plan Greece DR copy"]);
    expect(diagram.querySelectorAll("path.nous-plan-edge")).toHaveLength(2);
    expect(screen.getByText("1 other plan waits on nothing you can unblock: see the list.")).toBeTruthy();
    fireEvent.click(within(diagram).getByRole("button", { name: "Open the plan Greece DR copy" }));
    expect(onOpen).toHaveBeenCalledWith("clipboard:copy");
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    expect(screen.queryByRole("group", { name: "Plan dependencies" })).toBeNull();
  });

  it("says when nothing is to be unblocked, and when there is no open plan", () => {
    const { unmount } = render(<NousPlanMap onOpen={() => undefined} overview={overview([plan("free", "Free plan")])} />);
    expect(screen.getByText("Nothing to unblock: no plan waits on you, a third party, a promote, Nous or the server.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Diagram" }));
    expect(screen.getByText("Nothing to unblock")).toBeTruthy();
    unmount();
    render(<NousPlanMap onOpen={() => undefined} overview={overview([])} />);
    expect(screen.getByText("No open plans")).toBeTruthy();
  });

  it("shows a parked plan's reason and its met conditions in place of its wait (plan clipboard:7S_jA46vDkU9)", () => {
    render(<NousPlanMap onOpen={() => undefined} overview={overview([plan("parked", "Parked one", { hold: { kind: "NOUS", what: "the proof", until: null, source: "PANE" },
      parked: { reason: "Waits on nous: the proof", met: 1, total: 2 } })])} />);
    expect(screen.getByText("Parked: Waits on nous: the proof · 1/2 conditions met")).toBeTruthy();
    expect(screen.queryByText("the proof")).toBeNull();
  });

  it("lists plans closed with work left in their own section, even with no open plan (operator nous_msg:8076f33e)", () => {
    const onOpen = vi.fn();
    render(<NousPlanMap onOpen={onOpen} overview={{ ...overview([]), closedPlans: [plan("olla", "Example shop stock sale", { progress: 69, status: "COMPLETED", paneClosed: true,
      parked: { reason: "Waits on date: phase 2 on 26/11", met: 1, total: 2, conditions: [
        { who: "DATE", what: "Phase 2 −50%", at: "2026-11-26T07:00:00.000Z", state: "OPEN", metAt: null },
        { who: "OPERATOR", what: "Prices approved", at: null, state: "MET", metAt: "2026-11-14T10:00:00.000Z" }] } }),
      plan("bare", "Closed bare", { progress: 40, status: "COMPLETED" })] }} />);
    const section = screen.getByRole("region", { name: "Closed with work left" });
    // Why it closed and each condition that reopens it, in place of the one-line parked count.
    expect(within(section).queryByText(/conditions met/)).toBeNull();
    expect(within(section).getByText("Why: Waits on date: phase 2 on 26/11")).toBeTruthy();
    expect(within(section).getByText("Closed at 69%")).toBeTruthy();
    const conditions = within(within(section).getByRole("list", { name: "Conditions to reopen" })).getAllByRole("listitem");
    expect(conditions.map((item) => [item.className, item.firstElementChild?.textContent, item.lastElementChild?.textContent?.split(" · ").slice(0, 2).join(" · ")]))
      .toEqual([["is-open", "OPEN", "DATE · Phase 2 −50%"], ["is-met", "MET", "OPERATOR · Prices approved"]]);
    expect(conditions[0]!.textContent).toMatch(/26/);
    expect(conditions[1]!.textContent).toMatch(/met /);
    expect(within(section).getByText("Closed at 40%")).toBeTruthy();
    expect(within(section).getByText("No reason or condition to reopen it was recorded.")).toBeTruthy();
    expect(within(section).getByText("Pane closed")).toBeTruthy();
    fireEvent.click(within(section).getByRole("button", { name: /^Open the plan Example shop stock sale, 69%/ }));
    expect(onOpen).toHaveBeenCalledWith("clipboard:olla");
  });
});
