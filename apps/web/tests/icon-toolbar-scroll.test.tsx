import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Circle } from "lucide-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePersistentIconToolbar } from "../src/icon-toolbar.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";

const ORDER_STORAGE_KEY = "space.testToolbar.actionOrder";
const SHARED_HIDDEN_STORAGE_KEY = "space.testToolbar.sharedHiddenActions";

function ReorderToolbar() {
  const toolbar = usePersistentIconToolbar({
    actions: ["a", "b", "c"].map((id) => ({
      id,
      label: id.toUpperCase(),
      title: id.toUpperCase(),
      ariaLabel: id.toUpperCase(),
      icon: Circle,
      onClick: vi.fn()
    })),
    hiddenStorageKey: "space.testToolbar.hiddenActions",
    orderStorageKey: ORDER_STORAGE_KEY
  });

  return (
    <div>
      <div aria-label="Reorder toolbar">
        {toolbar.visibleActions.map((action) => (
          <button key={action.id} type="button" {...toolbar.getDragHandleProps(action)}>{action.label}</button>
        ))}
      </div>
      <button type="button" aria-label="Fixed action" draggable={false}>Fixed</button>
    </div>
  );
}

function SharedHiddenToolbar({ label, actionIds }: { label: string; actionIds: string[] }) {
  const toolbar = usePersistentIconToolbar({
    actions: actionIds.map((id) => ({
      id,
      label: id === "memory" ? "Memory" : "Copy",
      title: id,
      ariaLabel: `${label} ${id}`,
      icon: Circle,
      onClick: vi.fn()
    })),
    hiddenStorageKey: SHARED_HIDDEN_STORAGE_KEY,
    orderStorageKey: `space.testToolbar.${label}.actionOrder`,
    preserveUnknownActionIds: true
  });

  return (
    <section aria-label={`${label} toolbar`}>
      {toolbar.visibleActions.map((action) => <span key={action.id}>{action.label}</span>)}
      {actionIds.includes("memory") ? (
        <button type="button" onClick={() => toolbar.hideAction("memory")}>Hide memory</button>
      ) : null}
    </section>
  );
}

function PrimaryToolbar() {
  const toolbar = usePersistentIconToolbar({
    actions: ["a", "b", "c"].map((id) => ({
      id,
      label: id.toUpperCase(),
      title: id.toUpperCase(),
      ariaLabel: id.toUpperCase(),
      icon: Circle,
      onClick: vi.fn()
    })),
    hiddenStorageKey: "space.testPrimaryToolbar.hiddenActions",
    orderStorageKey: "space.testPrimaryToolbar.actionOrder",
    preserveUnknownActionIds: true
  });

  return (
    <div>
      <div aria-label="Primary toolbar">
        {toolbar.visibleActions.slice(0, 2).map((action) => <span key={action.id}>{action.label}</span>)}
      </div>
      <button type="button" onClick={() => toolbar.showActionInPrimary("c", 2)}>Show C</button>
    </div>
  );
}

function mockFinePointer(matches: boolean, maxTouchPoints = 0) {
  vi.stubGlobal("matchMedia", vi.fn().mockImplementation(() => ({
    matches,
    media: "(any-pointer: fine)",
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  })));
  Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: maxTouchPoints });
}

beforeEach(() => {
  installSpaceRuntime(liveRuntime);
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

describe("persistent toolbar reordering", () => {
  it("keeps a shared hidden action when another toolbar instance does not expose that action", async () => {
    render(
      <>
        <SharedHiddenToolbar label="CLI" actionIds={["memory", "copy"]} />
        <SharedHiddenToolbar label="CLI ROOT" actionIds={["copy"]} />
      </>
    );

    fireEvent.click(within(screen.getByLabelText("CLI toolbar")).getByRole("button", { name: "Hide memory" }));

    await waitFor(() => expect(window.localStorage.getItem(SHARED_HIDDEN_STORAGE_KEY)).toBe('["memory"]'));
    expect(within(screen.getByLabelText("CLI toolbar")).queryByText("Memory")).toBeNull();
  });

  it.each([
    ["adjacent forward", "A", "B", ["B", "A", "C"]],
    ["non-adjacent forward", "A", "C", ["B", "C", "A"]],
    ["adjacent backward", "B", "A", ["B", "A", "C"]],
    ["non-adjacent backward", "C", "A", ["C", "A", "B"]]
  ])("persists the exact %s order", async (_caseName, draggedLabel, targetLabel, expectedOrder) => {
    mockFinePointer(true);
    render(<ReorderToolbar />);
    const toolbar = screen.getByLabelText("Reorder toolbar");

    fireEvent.dragStart(within(toolbar).getByRole("button", { name: draggedLabel }));
    fireEvent.dragOver(within(toolbar).getByRole("button", { name: targetLabel }));
    fireEvent.drop(within(toolbar).getByRole("button", { name: targetLabel }));

    await waitFor(() => expect(JSON.parse(window.localStorage.getItem(ORDER_STORAGE_KEY) ?? "[]")).toEqual(expectedOrder.map((label) => label.toLowerCase())));
    expect(within(toolbar).getAllByRole("button").map((button) => button.textContent)).toEqual(expectedOrder);
    expect(screen.getByRole("button", { name: "Fixed action" }).getAttribute("draggable")).toBe("false");
  });

  it("restores the exact persisted order after reload", async () => {
    mockFinePointer(true);
    const view = render(<ReorderToolbar />);
    const toolbar = screen.getByLabelText("Reorder toolbar");
    fireEvent.dragStart(within(toolbar).getByRole("button", { name: "A" }));
    fireEvent.drop(within(toolbar).getByRole("button", { name: "C" }));
    await waitFor(() => expect(window.localStorage.getItem(ORDER_STORAGE_KEY)).toBe('["b","c","a"]'));

    view.unmount();
    render(<ReorderToolbar />);
    expect(within(screen.getByLabelText("Reorder toolbar")).getAllByRole("button").map((button) => button.textContent)).toEqual(["B", "C", "A"]);
  });

  it("allows native drag in desktop browsers that do not expose pointer media features", () => {
    mockFinePointer(false, 0);
    render(<ReorderToolbar />);
    expect(within(screen.getByLabelText("Reorder toolbar")).getAllByRole("button").every((button) => button.getAttribute("draggable") === "true")).toBe(true);
  });

  it("disables native drag on touch-only devices", () => {
    mockFinePointer(false, 1);
    render(<ReorderToolbar />);
    expect(within(screen.getByLabelText("Reorder toolbar")).getAllByRole("button").every((button) => button.getAttribute("draggable") === "false")).toBe(true);
  });

  it("promotes an overflow action into the last available primary slot", async () => {
    window.localStorage.setItem("space.testPrimaryToolbar.actionOrder", '["unknown","a","b","c"]');
    render(<PrimaryToolbar />);
    const primaryToolbar = screen.getByLabelText("Primary toolbar");

    expect(Array.from(primaryToolbar.children).map((item) => item.textContent)).toEqual(["A", "B"]);

    fireEvent.click(screen.getByRole("button", { name: "Show C" }));

    await waitFor(() =>
      expect(Array.from(primaryToolbar.children).map((item) => item.textContent)).toEqual(["A", "C"])
    );
    expect(window.localStorage.getItem("space.testPrimaryToolbar.actionOrder")).toBe('["unknown","a","c","b"]');
  });

  it("reorders actions with explicit before and after position", async () => {
    function ExplicitReorderToolbar() {
      const toolbar = usePersistentIconToolbar({
        actions: ["a", "b", "c", "d"].map((id) => ({
          id,
          label: id.toUpperCase(),
          title: id.toUpperCase(),
          ariaLabel: id.toUpperCase(),
          icon: Circle,
          onClick: vi.fn()
        })),
        hiddenStorageKey: "space.testToolbar.hiddenActions",
        orderStorageKey: ORDER_STORAGE_KEY
      });

      return (
        <div>
          <button type="button" onClick={() => toolbar.moveAction("d", "b", "before")}>Move D before B</button>
          <button type="button" onClick={() => toolbar.moveAction("a", "c", "after")}>Move A after C</button>
          <div aria-label="Order result">
            {toolbar.orderedActions.map((action) => <span key={action.id}>{action.label}</span>)}
          </div>
        </div>
      );
    }

    render(<ExplicitReorderToolbar />);
    const result = screen.getByLabelText("Order result");
    expect(Array.from(result.children).map((c) => c.textContent)).toEqual(["A", "B", "C", "D"]);

    fireEvent.click(screen.getByRole("button", { name: "Move D before B" }));
    expect(Array.from(result.children).map((c) => c.textContent)).toEqual(["A", "D", "B", "C"]);

    fireEvent.click(screen.getByRole("button", { name: "Move A after C" }));
    expect(Array.from(result.children).map((c) => c.textContent)).toEqual(["D", "B", "C", "A"]);
  });
});
