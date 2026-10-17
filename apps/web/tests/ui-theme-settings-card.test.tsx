import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { UiThemeSettingsCard } from "../src/features/ui-theme/UiThemeSettingsCard.js";

describe("UiThemeSettingsCard", () => {
  it.each(["classic", "codex", "motion"] as const)("changes icon packs while preserving the %s theme", (theme) => {
    const onChange = vi.fn();
    render(<UiThemeSettingsCard currentAppearance="dark" currentIconPack="lucide" currentTheme={theme} onChange={onChange} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Icon pack" }), { target: { value: "material-rounded" } });
    expect(onChange).toHaveBeenCalledWith({ theme, appearance: "dark", background: "spaceapp", iconPack: "material-rounded" });
    expect(screen.getByRole("option", { name: "Graphite" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Motion" })).toBeTruthy();
  });

  it("previews every icon pack, Space Duotone included, and marks the current one", () => {
    const { container } = render(<UiThemeSettingsCard currentAppearance="dark" currentIconPack="space" currentTheme="modern" onChange={vi.fn()} />);
    expect(screen.getByRole("option", { name: "Space Duotone (default)" })).toBeTruthy();
    const rows = [...container.querySelectorAll<HTMLElement>("[data-icon-pack-preview]")];
    expect(rows.map((row) => row.dataset.iconPackPreview)).toEqual(["space", "lucide", "material-rounded", "motion", "aurora"]);
    expect(container.querySelector(".is-current")?.textContent).toBe("Space Duotone (default) (current)");
  });

  it("enables icon packs in Classic while keeping its fixed dark appearance", () => {
    render(
      <UiThemeSettingsCard
        currentAppearance="system"
        currentIconPack="lucide"
        currentTheme="classic"
        onChange={vi.fn()}
      />
    );

    expect((screen.getByRole("combobox", { name: "Interface theme" }) as HTMLSelectElement).value).toBe("classic");
    expect((screen.getByRole("combobox", { name: "Modern color mode" }) as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByRole("combobox", { name: "Icon pack" }) as HTMLSelectElement).disabled).toBe(false);
    expect(screen.queryByRole("button", { name: "Apply and reload" })).toBeNull();
  });

  it("requests an immediate reload whenever the interface theme changes", () => {
    const onChange = vi.fn();
    render(
      <UiThemeSettingsCard
        currentAppearance="system"
        currentIconPack="lucide"
        currentTheme="classic"
        onChange={onChange}
      />
    );

    fireEvent.change(screen.getByRole("combobox", { name: "Interface theme" }), {
      target: { value: "modern" }
    });

    expect(onChange).toHaveBeenCalledWith({
      appearance: "system",
      background: "spaceapp",
      iconPack: "lucide",
      theme: "modern"
    });
  });

  it("applies Modern color and icon changes independently without a footer action", () => {
    const onChange = vi.fn();
    render(
      <UiThemeSettingsCard
        currentAppearance="dark"
        currentIconPack="lucide"
        currentTheme="modern"
        onChange={onChange}
      />
    );

    fireEvent.change(screen.getByRole("combobox", { name: "Modern color mode" }), {
      target: { value: "light" }
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Icon pack" }), {
      target: { value: "material-rounded" }
    });

    expect(onChange).toHaveBeenNthCalledWith(1, {
      appearance: "light",
      background: "spaceapp",
      iconPack: "lucide",
      theme: "modern"
    });
    expect(onChange).toHaveBeenNthCalledWith(2, {
      appearance: "dark",
      background: "spaceapp",
      iconPack: "material-rounded",
      theme: "modern"
    });
  });

  it("allows switching background between SpaceApp and theme default", () => {
    const onChange = vi.fn();
    render(
      <UiThemeSettingsCard
        currentAppearance="dark"
        currentBackground="spaceapp"
        currentIconPack="lucide"
        currentTheme="modern"
        onChange={onChange}
      />
    );

    const select = screen.getByRole("combobox", { name: "Background" }) as HTMLSelectElement;
    expect(select.value).toBe("spaceapp");
    expect(screen.getByRole("option", { name: "SpaceApp" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Theme default (no background)" })).toBeTruthy();

    fireEvent.change(select, { target: { value: "none" } });
    expect(onChange).toHaveBeenCalledWith({
      appearance: "dark",
      background: "none",
      iconPack: "lucide",
      theme: "modern"
    });
  });

  it("brings the Aurora background and icon pack along with the Aurora theme", () => {
    const onChange = vi.fn();
    render(<UiThemeSettingsCard currentAppearance="dark" currentBackground="none" currentIconPack="lucide" currentTheme="modern" onChange={onChange} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Interface theme" }), { target: { value: "aurora" } });
    expect(onChange).toHaveBeenCalledWith({ appearance: "dark", background: "aurora", iconPack: "aurora", theme: "aurora" });
  });

  it("brings the Glass Planet wallpaper with Liquid Glass, keeps the icon pack and allows light and dark", () => {
    const onChange = vi.fn();
    const { rerender } = render(<UiThemeSettingsCard currentAppearance="system" currentBackground="spaceapp" currentIconPack="lucide" currentTheme="modern" onChange={onChange} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Interface theme" }), { target: { value: "liquid-glass" } });
    expect(onChange).toHaveBeenCalledWith({ appearance: "system", background: "liquid-glass", iconPack: "lucide", theme: "liquid-glass" });
    expect(screen.getByRole("option", { name: "Glass Planet" })).toBeTruthy();
    rerender(<UiThemeSettingsCard currentAppearance="system" currentBackground="liquid-glass" currentIconPack="lucide" currentTheme="liquid-glass" onChange={onChange} />);
    expect((screen.getByRole("combobox", { name: "Modern color mode" }) as HTMLSelectElement).disabled).toBe(false);
  });

  it("shows the iOS 27 tint slider only for Liquid Glass and reports each change", () => {
    const onGlassTintChange = vi.fn();
    const { rerender } = render(<UiThemeSettingsCard currentAppearance="dark" currentIconPack="space" currentTheme="modern" currentGlassTint={50} onGlassTintChange={onGlassTintChange} onChange={vi.fn()} />);
    expect(screen.queryByRole("slider", { name: "Liquid Glass tint" })).toBeNull();
    rerender(<UiThemeSettingsCard currentAppearance="dark" currentIconPack="space" currentTheme="liquid-glass" currentGlassTint={50} onGlassTintChange={onGlassTintChange} onChange={vi.fn()} />);
    const slider = screen.getByRole("slider", { name: "Liquid Glass tint" }) as HTMLInputElement;
    expect([slider.value, slider.getAttribute("aria-valuetext")]).toEqual(["50", "50% tinted"]);
    fireEvent.change(slider, { target: { value: "15" } });
    expect(onGlassTintChange).toHaveBeenCalledWith(15);
  });

  it("previews every theme and background and applies a tile like its select", () => {
    const onChange = vi.fn();
    render(<UiThemeSettingsCard currentAppearance="dark" currentBackground="spaceapp" currentIconPack="lucide" currentTheme="modern" onChange={onChange} />);
    const themes = within(screen.getByRole("group", { name: "Theme previews" })).getAllByRole("button");
    expect(themes.map((tile) => [tile.textContent, tile.getAttribute("aria-pressed")])).toEqual([
      ["Classic", "false"], ["Modern", "true"], ["Graphite", "false"], ["Motion", "false"], ["Aurora", "false"], ["Liquid Glass", "false"]
    ]);
    fireEvent.click(themes[1]!);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(themes[5]!);
    expect(onChange).toHaveBeenLastCalledWith({ appearance: "dark", background: "liquid-glass", iconPack: "lucide", theme: "liquid-glass" });
    const backgrounds = within(screen.getByRole("group", { name: "Background previews" })).getAllByRole("button");
    expect(backgrounds.map((tile) => tile.textContent)).toEqual(["SpaceApp", "Aurora", "Glass Planet", "None"]);
    fireEvent.click(backgrounds[2]!);
    expect(onChange).toHaveBeenLastCalledWith({ appearance: "dark", background: "liquid-glass", iconPack: "lucide", theme: "modern" });
  });
});
