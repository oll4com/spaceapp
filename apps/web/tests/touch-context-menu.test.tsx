import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTouchContextMenu } from "../src/features/ui-theme/use-touch-context-menu.js";
import { FileListView } from "../src/features/files-pane/FileListView.js";
import type { FileItem } from "@space/contracts";

function TouchMenuFixture() {
  const [menus, setMenus] = useState(0);
  const [clicks, setClicks] = useState(0);
  const handlers = useTouchContextMenu(
    (source) => source instanceof Element ? source.closest<HTMLElement>("[data-context-target]") : null,
    () => setMenus((value) => value + 1)
  );
  return <div {...handlers}>
    <button type="button" data-context-target onClick={() => setClicks((value) => value + 1)}>Live</button>
    <output data-testid="menus">{menus}</output>
    <output data-testid="clicks">{clicks}</output>
  </div>;
}

afterEach(() => vi.useRealTimers());

describe("touch context menus", () => {
  it("opens once on a stationary long press and suppresses the following tap", () => {
    vi.useFakeTimers();
    render(<TouchMenuFixture />);
    const target = screen.getByRole("button", { name: "Live" });
    fireEvent.pointerDown(target, { pointerId: 1, pointerType: "touch", isPrimary: true, clientX: 40, clientY: 70 });
    act(() => vi.advanceTimersByTime(500));
    fireEvent.contextMenu(target);
    fireEvent.pointerUp(target, { pointerId: 1, pointerType: "touch" });
    fireEvent.click(target);
    expect(screen.getByTestId("menus").textContent).toBe("1");
    expect(screen.getByTestId("clicks").textContent).toBe("0");
  });

  it("keeps scrolling and ordinary taps distinct from a long press", () => {
    vi.useFakeTimers();
    render(<TouchMenuFixture />);
    const target = screen.getByRole("button", { name: "Live" });
    fireEvent.pointerDown(target, { pointerId: 2, pointerType: "touch", isPrimary: true, clientX: 40, clientY: 70 });
    fireEvent.pointerMove(target, { pointerId: 2, pointerType: "touch", clientX: 40, clientY: 90 });
    act(() => vi.advanceTimersByTime(600));
    fireEvent.pointerUp(target, { pointerId: 2, pointerType: "touch" });
    expect(screen.getByTestId("menus").textContent).toBe("0");
    fireEvent.pointerDown(target, { pointerId: 3, pointerType: "touch", isPrimary: true, clientX: 40, clientY: 70 });
    fireEvent.pointerUp(target, { pointerId: 3, pointerType: "touch" });
    fireEvent.click(target);
    expect(screen.getByTestId("clicks").textContent).toBe("1");
  });

  it("opens the file context menu from a long press on the row without an extra button", () => {
    vi.useFakeTimers();
    const entry = { path: "/opt/spaceapp/note.txt", name: "note.txt", isDirectory: false, size: 10, permissions: "rw-r--r--", mtime: "2026-09-24T00:00:00Z" } as FileItem;
    const noop = vi.fn();
    const { container } = render(<FileListView entries={[entry]} currentPath="/opt/spaceapp" parentPath={null} canGoUp={false} viewMode="table" mode="user" onOpenEntry={noop} onEditEntry={noop} onPreviewEntry={noop} onRenameEntry={noop} onChmodEntry={noop} onDeleteEntry={noop} onDownloadEntry={noop} onFilesDropped={noop} onNavigateUp={noop} />);
    expect(screen.queryByRole("button", { name: "More file actions note.txt" })).toBeNull();
    const row = container.querySelector<HTMLElement>("[data-file-entry-path]")!;
    fireEvent.pointerDown(row, { pointerId: 7, pointerType: "touch", isPrimary: true, clientX: 50, clientY: 80 });
    act(() => vi.advanceTimersByTime(500));
    expect(container.querySelector(".fm-context-menu")?.textContent).toContain("Copy Path");
  });
});
