import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SettingsDisclosure, SettingsSections, settingsSearchMatches } from "../src/features/settings/SettingsDisclosure.js";
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

it("searches without accents or case, so Greek words typed plainly are found", () => {
  expect(settingsSearchMatches("ειδοποιησεις", ["Ειδοποιήσεις"])).toBe(true);
  expect(settingsSearchMatches("ΜΕΤΑΦΟΡΑ αντιγραφα", ["Αντίγραφα & μεταφορά"])).toBe(true);
  expect(settingsSearchMatches("γλωσσα", ["Language", "Γλώσσα"])).toBe(true);
  expect(settingsSearchMatches("notif", ["Notifications"])).toBe(true);
  expect(settingsSearchMatches("ειδοποιησεις", ["Language"])).toBe(false);
});

// UI review 22/11: no row shows above the sticky search, and on a phone every switch lines up with its ⓘ on the label's line.
it("keeps the search over the dock's top padding and aligns switches and ⓘ", async () => {
  const [{ readFileSync }, { resolve }] = await Promise.all([import("node:fs"), import("node:path")]);
  const css = readFileSync(resolve(__dirname, "../src/features/settings/settings-disclosure.css"), "utf8");
  const dockPadding = readFileSync(resolve(__dirname, "../src/styles.css"), "utf8").match(/\n\.dock-panel \{[^}]*padding: ([\d.]+)rem;/)?.[1];
  expect(dockPadding).toBe("0.75");
  expect(css).toMatch(/\.agent-settings-dock:not\(\.is-fullscreen\) > \.settings-dock-toolbar \{ top: -\.75rem; margin-top: -\.75rem; padding-top: \.75rem; \}/);
  expect(css).toMatch(/\.settings-dock-toolbar \{[^}]*position: sticky;[^}]*background: var\(--modern-surface/);
  expect(css).toMatch(/\.space-toggle-label, \.settings-flat-row-copy > strong\) \{\s*display: flex;/);
  expect(css).toMatch(/> \.info-tip \{\s*flex: none;/);
  expect(css).toMatch(/\.settings-flat-row\.space-toggle \.space-toggle-state \{ min-width: 6\.2em; \}/);
});
