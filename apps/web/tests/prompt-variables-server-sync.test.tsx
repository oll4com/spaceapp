// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const userSettings = vi.fn();

vi.mock("../src/runtime/SpaceRuntime.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/runtime/SpaceRuntime.js")>();
  return {
    ...original,
    getSpaceRuntime: () => ({ platform: { localStorage: window.localStorage }, api: { userSettings } })
  };
});

const {
  resetPromptVariablesServerSyncForTests,
  syncPromptVariablesFromServer,
  usePromptVariables
} = await import("../src/features/prompt-variables/prompt-variables-store.js");

function Probe({ id }: { id: string }) {
  const { variables } = usePromptVariables();
  return <span data-testid={id}>{variables.map((variable) => variable.name).join(",")}</span>;
}

const serverVariable = {
  id: "pv_server",
  name: "server_tag",
  label: "Server tag",
  value: "from the server",
  createdAt: "2026-10-11T00:00:00.000Z",
  updatedAt: "2026-10-11T00:00:00.000Z"
};

describe("prompt variables server sync", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetPromptVariablesServerSyncForTests();
    userSettings.mockReset();
  });

  afterEach(() => cleanup());

  it("shares one user-settings request across every hook mounted together", async () => {
    userSettings.mockResolvedValue({ promptVariables: [serverVariable], promptVariablesEnabled: true });

    render(<>{["a", "b", "c", "d"].map((id) => <Probe key={id} id={id} />)}</>);
    await act(async () => { await Promise.resolve(); });

    expect(userSettings).toHaveBeenCalledTimes(1);
    for (const id of ["a", "b", "c", "d"]) {
      expect(screen.getByTestId(id).textContent).toBe("server_tag");
    }
  });

  it("syncs again after the sharing window and retries after a failed request", async () => {
    userSettings.mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ promptVariables: [] });
    const start = Date.now();

    syncPromptVariablesFromServer(start);
    await act(async () => { await Promise.resolve(); });
    syncPromptVariablesFromServer(start + 1);
    expect(userSettings).toHaveBeenCalledTimes(2);

    syncPromptVariablesFromServer(start + 5_000);
    expect(userSettings).toHaveBeenCalledTimes(2);
    syncPromptVariablesFromServer(start + 1 + 10_000);
    expect(userSettings).toHaveBeenCalledTimes(3);
  });
});
