import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayCompressionMode, GatewaySettings } from "@space/contracts";
import { announceGatewaySettings } from "../src/features/space-gateway/gateway-settings-events.js";
import { useGatewayCompressionToggle, type GatewayCompressionClient } from "../src/features/space-gateway/useGatewayCompressionToggle.js";

function settings(mode: GatewayCompressionMode) {
  return { compressionMode: mode } as GatewaySettings;
}

function Harness({ client }: { client: GatewayCompressionClient }) {
  const toggle = useGatewayCompressionToggle({ enabled: true, client });
  return (
    <>
      <button type="button" disabled={toggle.mode === null || toggle.pending} onClick={toggle.request}>Context compression {toggle.mode ?? "…"}</button>
      {toggle.dialog}
    </>
  );
}

describe("context compression quick toggle", () => {
  afterEach(() => cleanup());

  it("explains what turning compression off and on changes, and changes it only after confirmation", async () => {
    let mode: GatewayCompressionMode = "ON";
    const client = {
      settings: vi.fn(async () => settings(mode)),
      update: vi.fn(async (next: GatewayCompressionMode) => { mode = next; return settings(next); })
    };
    const announced: GatewaySettings[] = [];
    const listener = (event: Event) => announced.push((event as CustomEvent<GatewaySettings>).detail);
    window.addEventListener("space:gateway-settings-change", listener);
    render(<Harness client={client} />);
    const trigger = await screen.findByRole("button", { name: "Context compression ON" });

    fireEvent.click(trigger);
    let dialog = await screen.findByRole("dialog", { name: "Turn off context compression?" });
    expect(dialog.textContent).toContain("send every request to the providers unchanged");
    expect(dialog.textContent).toContain("account quotas run out sooner");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(client.update).not.toHaveBeenCalled();

    fireEvent.click(trigger);
    dialog = await screen.findByRole("dialog", { name: "Turn off context compression?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Turn off compression" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Context compression OFF" })).toBeTruthy());
    expect(client.update).toHaveBeenCalledWith("OFF");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(announced.at(-1)?.compressionMode).toBe("OFF");

    fireEvent.click(screen.getByRole("button", { name: "Context compression OFF" }));
    dialog = await screen.findByRole("dialog", { name: "Turn on context compression?" });
    expect(dialog.textContent).toContain("compress tool output");
    expect(dialog.textContent).toContain("File reads and your own messages are never changed");
    fireEvent.click(within(dialog).getByRole("button", { name: "Turn on compression" }));
    await waitFor(() => expect(client.update).toHaveBeenLastCalledWith("ON"));
    window.removeEventListener("space:gateway-settings-change", listener);
  });

  it("keeps the dialog open with the reason when the change fails, and follows changes made in Space Gateway", async () => {
    const client = {
      settings: vi.fn(async () => settings("ON")),
      update: vi.fn(async () => { throw new Error("Space Gateway is unavailable."); })
    };
    render(<Harness client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "Context compression ON" }));
    const dialog = await screen.findByRole("dialog", { name: "Turn off context compression?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Turn off compression" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe("Space Gateway is unavailable.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    act(() => announceGatewaySettings(settings("OFF")));
    expect(await screen.findByRole("button", { name: "Context compression OFF" })).toBeTruthy();
  });
});
