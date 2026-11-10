// The X-Space-Client header (plan clipboard:4TXfIZzj8ITW): viewport, touch form, the Nous dock's tab, and the desktop app the stripped
// Electron UA hides, from its bridge.
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseNousClientHeader } from "@space/contracts";

const coarse = (matches: boolean) => vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(pointer: coarse)" && matches }));

describe("clientHeader", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); delete (window as unknown as { spaceDesktop?: unknown }).spaceDesktop; delete (window as unknown as { SpaceNative?: unknown }).SpaceNative; });

  it("describes a phone browser with the dock's tab", async () => {
    coarse(true);
    vi.stubGlobal("innerWidth", 412); vi.stubGlobal("innerHeight", 915);
    const { clientHeader, setClientView } = await import("../src/client-context.js");
    setClientView("nous:needs-you");
    expect(parseNousClientHeader(clientHeader())).toEqual({ form: "PHONE", view: "nous:needs-you", viewport: "412x915" });
    setClientView(undefined);
    expect(parseNousClientHeader(clientHeader())).toEqual({ form: "PHONE", viewport: "412x915" });
  });

  it("takes SpaceApp Android's version from its Web tab bridge", async () => {
    coarse(true);
    vi.stubGlobal("innerWidth", 412); vi.stubGlobal("innerHeight", 915);
    (window as unknown as { SpaceNative: unknown }).SpaceNative = { appVersion: () => "0.2.5" };
    const { clientHeader } = await import("../src/client-context.js");
    expect(parseNousClientHeader(clientHeader())).toEqual({ form: "PHONE", version: "0.2.5", viewport: "412x915" });
    (window as unknown as { SpaceNative: unknown }).SpaceNative = { appVersion: () => "0.2.5; app=WEB" };
    expect(parseNousClientHeader(clientHeader())).toEqual({ form: "PHONE", viewport: "412x915" });
  });

  it("names the Windows desktop app and its version from the bridge", async () => {
    coarse(false);
    vi.stubGlobal("innerWidth", 1920); vi.stubGlobal("innerHeight", 1080);
    (window as unknown as { spaceDesktop: unknown }).spaceDesktop = { getSystemInfo: async () => ({ platform: "win32", version: "0.1.30" }) };
    const { clientHeader } = await import("../src/client-context.js");
    await vi.waitFor(() => expect(parseNousClientHeader(clientHeader())).toEqual({ app: "DESKTOP_WINDOWS", form: "DESKTOP", version: "0.1.30", viewport: "1920x1080" }));
  });
});
