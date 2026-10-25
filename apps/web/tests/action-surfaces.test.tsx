import { useRef, useState } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DesktopActionManager } from "../src/features/action-surfaces/DesktopActionManager.js";
import { MobileActionSheet } from "../src/features/action-surfaces/MobileActionSheet.js";
import { Settings } from "../src/features/ui-theme/app-icons.js";
import type { IconToolbarAction } from "../src/icon-toolbar.js";

function Fixture({ desktop = false, plain = false, focusDestination = false }: {
  desktop?: boolean; plain?: boolean; focusDestination?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState(["second"]);
  const [order, setOrder] = useState(["first", "second", "disabled"]);
  const [status, setStatus] = useState("No action");
  const trigger = useRef<HTMLButtonElement>(null);
  const destination = useRef<HTMLInputElement>(null);
  const actions: IconToolbarAction[] = order.map(id => ({
    id, label: id, ariaLabel: id, title: `${id} action`, icon: Settings,
    disabled: id === "disabled", onClick: () => undefined
  }));
  const props = {
    actions, hiddenActionIds: hidden, label: "Fixture actions", popupId: "fixture-actions", triggerRef: trigger,
    plainActions: plain, onClose: () => setOpen(false),
    onHideAction: (id: string) => setHidden(current => [...current, id]),
    onShowAction: (id: string) => setHidden(current => current.filter(value => value !== id)),
    onRunAction: (action: IconToolbarAction) => {
      setStatus(action.id);
      if (focusDestination) destination.current?.focus();
      setOpen(false);
    }
  };
  return <>
    <button ref={trigger} onClick={() => setOpen(true)}>Open fixture</button>
    <input ref={destination} aria-label="Destination" />
    <output aria-label="Action result">{status}</output>
    {open ? desktop ? <DesktopActionManager {...props} onReorderAction={(source, target, position) => {
      setOrder(current => {
        const next = current.filter(id => id !== source);
        next.splice(next.indexOf(target) + (position === "after" ? 1 : 0), 0, source);
        return next;
      });
    }} /> : <MobileActionSheet {...props} /> : null}
  </>;
}

describe.each([false, true])("Action surface desktop=%s", desktop => {
  it("returns focus to the connected trigger on Escape", async () => {
    render(<Fixture desktop={desktop} plain />);
    const trigger = screen.getByRole("button", { name: "Open fixture" });
    fireEvent.click(trigger);
    const surface = screen.getByRole(desktop ? "menu" : "dialog", { name: "Fixture actions" });
    await waitFor(() => expect(surface.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(surface, { key: "Escape" });
    expect(surface.isConnected).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it("runs enabled actions and preserves the destination focus during dismissal", async () => {
    render(<Fixture desktop={desktop} plain focusDestination />);
    fireEvent.click(screen.getByRole("button", { name: "Open fixture" }));
    const surface = screen.getByRole(desktop ? "menu" : "dialog", { name: "Fixture actions" });
    const role = desktop ? "menuitem" : "button";
    const disabled = within(surface).getByRole(role, { name: "disabled" });
    expect(disabled).toHaveProperty("disabled", true);
    fireEvent.click(disabled);
    expect(screen.getByLabelText("Action result").textContent).toBe("No action");
    fireEvent.click(within(surface).getByRole(role, { name: "first" }));
    expect(screen.getByLabelText("Action result").textContent).toBe("first");
    expect(surface.isConnected).toBe(false);
    expect(document.activeElement).toBe(screen.getByLabelText("Destination"));
  });

  it("reveals hidden actions and persists the user's subsequent hide choice", () => {
    render(<Fixture desktop={desktop} />);
    fireEvent.click(screen.getByRole("button", { name: "Open fixture" }));
    const role = desktop ? "menuitemcheckbox" : "button";
    fireEvent.click(screen.getByRole(role, { name: "Show second" }));
    const shown = screen.getByRole(role, { name: "Hide second" });
    if (desktop) expect(shown.getAttribute("aria-checked")).toBe("true");
    else expect(screen.getByRole("button", { name: "second" })).toHaveProperty("disabled", false);
    fireEvent.click(shown);
    const hidden = screen.getByRole(role, { name: "Show second" });
    if (desktop) expect(hidden.getAttribute("aria-checked")).toBe("false");
    else expect(screen.getByRole("button", { name: "second" })).toHaveProperty("disabled", true);
  });
});

it("cycles mobile focus without including disabled actions", () => {
  render(<Fixture plain />);
  fireEvent.click(screen.getByRole("button", { name: "Open fixture" }));
  const close = screen.getByRole("button", { name: "Close Fixture actions" });
  const last = screen.getByRole("button", { name: "second" });
  expect(document.activeElement).toBe(close);
  fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(last);
  fireEvent.keyDown(last, { key: "Tab" });
  expect(document.activeElement).toBe(close);
});

it("reorders desktop actions by keyboard while retaining focus on the moved action", async () => {
  render(<Fixture desktop plain />);
  fireEvent.click(screen.getByRole("button", { name: "Open fixture" }));
  const first = screen.getByRole("menuitem", { name: "first" });
  await waitFor(() => expect(document.activeElement).toBe(first));
  fireEvent.keyDown(first, { key: "ArrowDown", altKey: true });
  expect(screen.getAllByRole("menuitem").map(button => button.getAttribute("aria-label"))).toEqual(["second", "first", "disabled"]);
  await waitFor(() => expect(document.activeElement).toBe(first));
});

describe("Desktop pane menu with window tiles", () => {
  function TileFixture() {
    const trigger = useRef<HTMLButtonElement>(null);
    const [open, setOpen] = useState(true);
    const actions: IconToolbarAction[] = ["first", "blocked", "last"].map(id => ({
      id, label: id, ariaLabel: id, title: id === "blocked" ? "Blocked for a reason." : `${id} action`, icon: Settings,
      disabled: id === "blocked", hideWhenDisabled: false, onClick: () => undefined
    }));
    const commands = ["Maximize", "Minimize"].map(label => ({
      id: label, label, ariaLabel: label, description: label, icon: Settings, placement: "quick" as const, onClick: () => undefined
    }));
    return <>
      <button ref={trigger}>Trigger</button>
      {open ? <DesktopActionManager actions={actions} commands={commands} commandSectionLabel="Quick actions" hiddenActionIds={[]}
        label="Tile actions" popupId="tile-actions" triggerRef={trigger} plainActions onClose={() => setOpen(false)}
        onHideAction={() => undefined} onShowAction={() => undefined} /> : null}
    </>;
  }

  it("opens and returns Home to the first task action, with the tiles reachable by ArrowUp", async () => {
    render(<TileFixture />);
    const menu = screen.getByRole("menu", { name: "Tile actions" });
    const first = within(menu).getByRole("menuitem", { name: "first" });
    await waitFor(() => expect(document.activeElement).toBe(first));
    expect(within(menu).getByRole("menuitem", { name: "blocked" }).getAttribute("title")).toBe("Blocked for a reason.");

    fireEvent.keyDown(menu, { key: "End" });
    expect(document.activeElement).toBe(within(menu).getByRole("menuitem", { name: "last" }));
    fireEvent.keyDown(menu, { key: "Home" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(document.activeElement).toBe(within(menu).getByRole("menuitem", { name: "Minimize" }));
  });
});

describe("Mobile pane sheet", () => {
  it("shows why a command is disabled, since touch has no tooltip", () => {
    const trigger = { current: null };
    render(<MobileActionSheet actions={[]} hiddenActionIds={[]} label="Sheet" popupId="sheet" triggerRef={trigger}
      onClose={() => undefined} onHideAction={() => undefined} onShowAction={() => undefined} onRunAction={() => undefined}
      commands={[{ id: "new_task", label: "New task", description: "Start a clean thread", ariaLabel: "New task", icon: Settings,
        disabled: true, title: "The Chat is still loading.", onClick: () => undefined }]} />);
    const command = screen.getByRole("button", { name: "New task" });
    expect(command.textContent).toContain("The Chat is still loading.");
    expect(command.textContent).not.toContain("Start a clean thread");
  });
});

describe("MobileActionSheet swipe", () => {
  it("closes when its header is pulled down, not on a tap", () => {
    render(<Fixture plain />);
    fireEvent.click(screen.getByRole("button", { name: "Open fixture" }));
    const sheet = screen.getByRole("dialog", { name: "Fixture actions" });
    const header = sheet.querySelector("header")!;
    fireEvent.pointerDown(header, { clientY: 100 });
    fireEvent.pointerUp(header, { clientY: 120 });
    expect(sheet.isConnected).toBe(true);
    fireEvent.pointerDown(header, { clientY: 100 });
    fireEvent.pointerUp(header, { clientY: 200 });
    expect(sheet.isConnected).toBe(false);
  });
});
