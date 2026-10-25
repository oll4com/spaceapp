import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpaceToggle } from "../src/features/ui-controls/SpaceToggle.js";

function ToggleHarness() {
  const [enabled, setEnabled] = useState(false);
  return (
    <SpaceToggle
      label="Shared control"
      detail="Shared switch detail"
      checked={enabled}
      onChange={setEnabled}
    />
  );
}

describe("SpaceToggle", () => {
  afterEach(() => cleanup());

  it("uses native keyboard semantics with the shared Enabled and Disabled presentation", () => {
    render(<ToggleHarness />);

    const toggle = screen.getByRole("switch", { name: "Shared control" }) as HTMLInputElement;
    expect(toggle.tagName).toBe("INPUT");
    expect(toggle.type).toBe("checkbox");
    expect(toggle.checked).toBe(false);
    expect(screen.getByText("Disabled")).toBeTruthy();

    fireEvent.click(toggle);

    expect(toggle.checked).toBe(true);
    expect(screen.getByText("Enabled")).toBeTruthy();
    expect(document.querySelector(".space-toggle-track .space-toggle-thumb")).toBeTruthy();
  });

  it("keeps disabled switches immutable and visibly disabled", () => {
    const onChange = vi.fn();
    render(<SpaceToggle label="Locked control" checked={false} disabled onChange={onChange} />);

    const toggle = screen.getByRole("switch", { name: "Locked control" }) as HTMLInputElement;
    fireEvent.click(toggle);

    expect(toggle.disabled).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
    expect(toggle.closest(".space-toggle")?.getAttribute("data-disabled")).toBe("true");
  });
});
