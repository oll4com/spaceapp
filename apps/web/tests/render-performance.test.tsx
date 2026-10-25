import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { reuseVersionedItems, useStableCallback } from "../src/render-performance.js";

describe("render performance helpers", () => {
  it("keeps one callback reference while invoking the latest implementation", () => {
    const references: Array<() => void> = [];
    const observed: string[] = [];

    function Harness({ value }: { value: string }) {
      const callback = useStableCallback(() => observed.push(value));
      references.push(callback);
      return <button onClick={callback}>Run</button>;
    }

    const view = render(<Harness value="first" />);
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    view.rerender(<Harness value="second" />);
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    expect(references.at(-1)).toBe(references[0]);
    expect(observed).toEqual(["first", "second"]);
  });

  it("reuses version-matched entities and the whole array when order is unchanged", () => {
    const previous = [
      { id: "pane:a", updatedAt: "1", title: "A" },
      { id: "pane:b", updatedAt: "1", title: "B" }
    ];
    const unchanged = previous.map((item) => ({ ...item }));

    const reused = reuseVersionedItems(previous, unchanged, (item) => item.updatedAt);

    expect(reused).toBe(previous);

    const changed = reuseVersionedItems(
      previous,
      [unchanged[0]!, { ...unchanged[1]!, updatedAt: "2", title: "B2" }],
      (item) => item.updatedAt
    );
    expect(changed).not.toBe(previous);
    expect(changed[0]).toBe(previous[0]);
    expect(changed[1]).not.toBe(previous[1]);
    expect(changed[1]?.title).toBe("B2");
  });
});
