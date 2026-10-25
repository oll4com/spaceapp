import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SettingsDisclosure, SettingsSections } from "../src/features/settings/SettingsDisclosure.js";
import { Settings } from "../src/features/ui-theme/app-icons.js";
afterEach(cleanup);
it("loads a section on demand and retains its draft when another section opens", () => {
  const mounted = vi.fn();
  function Editor() { mounted(); return <input aria-label="Draft" defaultValue="" />; }
  render(<SettingsSections>
    <SettingsDisclosure title="First" description="First section" icon={Settings} scope="This browser"><Editor /></SettingsDisclosure>
    <SettingsDisclosure title="Second" description="Second section" icon={Settings} scope="Installation"><p>Second content</p></SettingsDisclosure>
  </SettingsSections>);
  expect(mounted).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "First" }));
  fireEvent.change(screen.getByLabelText("Draft"), { target: { value: "keep this" } });
  fireEvent.click(screen.getByRole("button", { name: "Second" }));
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.getByRole("button", { name: "First" }).getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(screen.getByRole("button", { name: "First" }));
  expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("keep this");
});

it("allows an initially open section to close", () => {
  render(
    <SettingsSections>
      <SettingsDisclosure
        initialOpen
        title="Initially open"
        description="Section description"
        icon={Settings}
        scope="This browser"
      >
        <p>Section content</p>
      </SettingsDisclosure>
    </SettingsSections>
  );

  const toggle = screen.getByRole("button", { name: "Initially open" });
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(screen.getByText("Section content").closest(".settings-disclosure-content")?.hasAttribute("hidden")).toBe(true);
});
