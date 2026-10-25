import { act, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  DockChips,
  DockIconButton,
  DockNotice,
  DockSearch,
  DockState,
  DockToolbar,
  useDockConfirm
} from "../src/features/dock-kit/DockKit.js";
import { Plus } from "../src/features/ui-theme/app-icons.js";

describe("dock kit", () => {
  it("names every icon button for screen readers and tooltips", () => {
    const onClick = vi.fn();
    render(
      <DockToolbar summary={<><strong>3</strong> items</>}>
        <DockIconButton label="Add item" icon={Plus} onClick={onClick} />
      </DockToolbar>
    );
    const button = screen.getByRole("button", { name: "Add item" });
    expect(button.getAttribute("title")).toBe("Add item");
    expect(button.getAttribute("type")).toBe("button");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.getByText("items", { exact: false }).className).toBe("dock-kit-summary");
  });

  it("searches as you type and clears with one click", () => {
    function Harness() {
      const [value, setValue] = useState("");
      return <DockSearch label="Search tasks" value={value} onChange={setValue} />;
    }
    render(<Harness />);
    const input = screen.getByRole("searchbox", { name: "Search tasks" });
    expect(input.getAttribute("placeholder")).toBe("Search tasks…");
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();
    fireEvent.change(input, { target: { value: "deploy" } });
    expect((input as HTMLInputElement).value).toBe("deploy");
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("marks exactly one filter chip as pressed", () => {
    const onChange = vi.fn();
    render(
      <DockChips
        label="Task statuses"
        value="OPEN"
        onChange={onChange}
        options={[{ id: "ALL", label: "All" }, { id: "OPEN", label: "Open", count: 2 }]}
      />
    );
    expect(screen.getByRole("group", { name: "Task statuses" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "All" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: /^Open/ }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(onChange).toHaveBeenCalledWith("ALL");
  });

  it("announces loading and empty states politely and errors assertively", () => {
    const retry = vi.fn();
    const { rerender } = render(<DockState kind="loading" title="Loading tasks…" />);
    expect(screen.getByRole("status").textContent).toContain("Loading tasks…");
    rerender(<DockState kind="empty" title="No tasks yet" detail="Add one with +." />);
    expect(screen.getByRole("status").textContent).toContain("Add one with +.");
    rerender(<DockState kind="error" title="Tasks could not be loaded" action={{ label: "Try again", onClick: retry }} />);
    expect(screen.getByRole("alert").textContent).toContain("Tasks could not be loaded");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("lets the user dismiss a notice", () => {
    const onDismiss = vi.fn();
    render(<DockNotice onDismiss={onDismiss}>Save failed.</DockNotice>);
    expect(screen.getByRole("alert").textContent).toContain("Save failed.");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss message" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("confirms inside the app and resolves the answer", async () => {
    const answers: boolean[] = [];
    function Harness() {
      const { confirm, confirmDialog } = useDockConfirm();
      return (
        <>
          <button type="button" onClick={() => void confirm({ title: "Delete this task?", message: "This cannot be undone.", confirmLabel: "Delete" }).then((answer) => answers.push(answer))}>
            Delete
          </button>
          {confirmDialog}
        </>
      );
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = screen.getByRole("alertdialog", { name: "Delete this task?" });
    expect(dialog.textContent).toContain("This cannot be undone.");
    expect(document.activeElement?.textContent).toBe("Cancel");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    });
    expect(answers).toEqual([false]);
    expect(screen.queryByRole("alertdialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const accept = screen.getAllByRole("button", { name: "Delete" }).find((button) => button.closest("dialog"));
    await act(async () => {
      fireEvent.click(accept!);
    });
    expect(answers).toEqual([false, true]);

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    });
    expect(answers).toEqual([false, true, false]);
  });

  it("keeps the Modern blanket dock rules away from kit controls without raising their specificity", () => {
    const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../src/features/ui-theme/modern-theme.css"), "utf8");
    expect(css).toContain(':where(button, input, select, textarea):where(:not([class*="dock-kit-"]))');
    expect(css).toContain(':where([role="alert"]:not([class*="dock-kit-"], .nous-focus-banner))');
  });
});
