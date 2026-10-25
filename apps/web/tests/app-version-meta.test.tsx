import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppVersionMeta, DemoVersionMeta } from "../src/features/app-version/AppVersionMeta.js";

vi.mock("../src/features/app-version/public-config.js", () => ({
  readPublicHomepageConfig: vi.fn().mockReturnValue({ discordUrl: "https://discord.gg/example" }),
}));

vi.mock("../src/features/app-version/use-app-version.js", () => ({
  useAppVersion: vi.fn(),
}));

const useAppVersionMock = vi.mocked((
  await import("../src/features/app-version/use-app-version.js")
).useAppVersion);

describe("AppVersionMeta", () => {
  beforeEach(() => {
    useAppVersionMock.mockReturnValue(null);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows placeholder version while status is unknown", () => {
    render(<AppVersionMeta />);
    expect(screen.getByText("…")).toBeTruthy();
  });

  it("renders version, github, youtube and discord links", () => {
    useAppVersionMock.mockReturnValue({
      appRelease: "v0.1.17",
      currentCommit: "deadbeef",
      shortCommit: "deadbee",
      currentBranch: "main",
      dirty: false,
      athensTag: "v2026.08.06.1",
      githubLatest: "v0.1.17",
      githubTagUrl: null,
      updateAvailable: false,
      behindCount: 0,
      checkedAt: null,
    });
    render(<AppVersionMeta />);
    expect(screen.getByText("v0.1.17").closest("a")!.getAttribute("href")).toBe(
      "https://github.com/oll4com/spaceapp/releases",
    );
    expect(screen.getByLabelText("SpaceApp GitHub").getAttribute("href")).toBe(
      "https://github.com/oll4com/spaceapp",
    );
    expect(screen.getByLabelText("SpaceApp YouTube").getAttribute("href")).toBe(
      "https://www.youtube.com/@spaceapp_dev",
    );
    expect(screen.getByLabelText("Join SpaceApp Discord").getAttribute("href")).toBe(
      "https://discord.gg/example",
    );
    expect(screen.queryByText(/Update/)).toBeNull();
  });

  it("shows update badge when a newer release exists", () => {
    useAppVersionMock.mockReturnValue({
      appRelease: "v0.1.16",
      currentCommit: "abc",
      shortCommit: "ab",
      currentBranch: "main",
      dirty: false,
      athensTag: null,
      githubLatest: "v0.1.17",
      githubTagUrl: null,
      updateAvailable: true,
      behindCount: 1,
      checkedAt: null,
    });
    render(<AppVersionMeta />);
    const update = screen.getByText(/Update available: v0\.1\.17/);
    expect(update.closest("a")!.getAttribute("href")).toBe("https://github.com/oll4com/spaceapp/releases");
    expect(screen.getByText("v0.1.17").closest("a")!.getAttribute("href")).toBe(
      "https://github.com/oll4com/spaceapp/releases",
    );
  });

  it("shows public installations the update command with a Copy button", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    useAppVersionMock.mockReturnValue({
      appRelease: "v1.1.2",
      currentCommit: null,
      shortCommit: null,
      currentBranch: null,
      dirty: false,
      athensTag: null,
      githubLatest: "v1.1.3",
      githubTagUrl: "https://github.com/oll4com/spaceapp/releases/tag/v1.1.3",
      updateAvailable: true,
      behindCount: 1,
      checkedAt: null,
      updateCommand: "npx --yes run-spaceapp@latest update",
    });
    render(<AppVersionMeta />);
    expect(screen.queryByRole("dialog", { name: "Update SpaceApp" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Update available: v1\.1\.3/ }));
    const panel = screen.getByRole("dialog", { name: "Update SpaceApp" });
    expect(panel.textContent).toContain("npx --yes run-spaceapp@latest update");
    expect(screen.getByText("What's new in v1.1.3").closest("a")!.getAttribute("href")).toBe(
      "https://github.com/oll4com/spaceapp/releases/tag/v1.1.3",
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("npx --yes run-spaceapp@latest update"));
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Update SpaceApp" })).toBeNull();
  });

  it("DemoVersionMeta shows static version link and community links", () => {
    render(<DemoVersionMeta />);
    expect(screen.getByText("v0.1.0 · demo").closest("a")!.getAttribute("href")).toBe(
      "https://github.com/oll4com/spaceapp/releases",
    );
    expect(screen.getByLabelText("SpaceApp GitHub")).toBeTruthy();
    expect(screen.getByLabelText("SpaceApp YouTube")).toBeTruthy();
    expect(screen.getByLabelText("Join SpaceApp Discord")).toBeTruthy();
  });
});