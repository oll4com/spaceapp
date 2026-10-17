import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { InstanceBadge } from "../src/features/instance-badge/InstanceBadge.js";
import { fetchSpaceInstance } from "../src/features/instance-badge/space-instance.js";

function versionFetcher(body: unknown, ok = true): typeof fetch {
  return (async () => ({ ok, json: async () => body })) as unknown as typeof fetch;
}

describe("InstanceBadge", () => {
  afterEach(() => {
    cleanup();
    document.title = "Space";
  });

  it("reads the instance from the public version endpoint", async () => {
    await expect(fetchSpaceInstance(versionFetcher({ instance: "dev" }))).resolves.toBe("dev");
    await expect(fetchSpaceInstance(versionFetcher({ instance: "stable" }))).resolves.toBe("stable");
    await expect(fetchSpaceInstance(versionFetcher({ name: "space-api" }))).resolves.toBeNull();
    await expect(fetchSpaceInstance(versionFetcher({}, false))).resolves.toBeNull();
    await expect(fetchSpaceInstance((async () => { throw new Error("offline"); }) as unknown as typeof fetch)).resolves.toBeNull();
  });

  it("keeps the component module a React-only Fast Refresh boundary", async () => {
    const component = await import("../src/features/instance-badge/InstanceBadge.js");
    expect(Object.keys(component)).toEqual(["InstanceBadge"]);
    expect(component.InstanceBadge).toBe(InstanceBadge);
  });

  it("marks the dev instance and keeps the DEV prefix when the app retitles the tab", async () => {
    document.title = "Space";
    render(<InstanceBadge fetcher={versionFetcher({ instance: "dev" })} />);
    expect((await screen.findByRole("status", { name: "Development instance" })).textContent).toBe("DEV");
    await waitFor(() => expect(document.title).toBe("DEV · Space"));
    document.title = "Space Help";
    await waitFor(() => expect(document.title).toBe("DEV · Space Help"));
  });

  it("renders nothing on the stable instance", async () => {
    const fetcher = versionFetcher({ instance: "stable" });
    const { container } = render(<InstanceBadge fetcher={fetcher} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.innerHTML).toBe("");
    expect(document.title).toBe("Space");
  });
});
