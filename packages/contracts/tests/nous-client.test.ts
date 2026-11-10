// Where the operator writes to Nous from (plan clipboard:4TXfIZzj8ITW): firm server signals first, the header only describes.
import { describe, expect, it } from "vitest";
import { describeNousClient, formatNousClientHeader, nousClientContext, nousClientContextSchema, parseNousClientHeader } from "../src/nous-client.js";

const UA = {
  windowsChrome: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.130 Safari/537.36",
  linuxChrome: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.130 Safari/537.36",
  webView: "Mozilla/5.0 (Linux; Android 17; SM-S938B Build/CP2A.260605.016; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/155.0.8059.43 Mobile Safari/537.36",
  phoneChrome: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36",
  electronLinux: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) spaceapp/0.1.30 Chrome/152.0.0.0 Electron/41.0.0 Safari/537.36",
  iPad: "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  okhttp: "okhttp/4.12.0"
};

describe("nousClientContext", () => {
  it("tells every client seen in nginx on 31/10 apart", () => {
    expect(nousClientContext({ userAgent: UA.windowsChrome })).toEqual({ app: "WEB", os: "WINDOWS", form: "DESKTOP" });
    expect(nousClientContext({ userAgent: UA.phoneChrome })).toEqual({ app: "WEB", os: "ANDROID", form: "PHONE" });
    expect(nousClientContext({ userAgent: UA.webView })).toEqual({ app: "SPACEAPP_ANDROID", os: "ANDROID", form: "PHONE" });
    expect(nousClientContext({ userAgent: UA.electronLinux })).toEqual({ app: "DESKTOP_LINUX", os: "LINUX", form: "DESKTOP" });
    expect(nousClientContext({ userAgent: UA.iPad })).toEqual({ app: "WEB", os: "IOS", form: "TABLET" });
    // okhttp says nothing; the device session's app claim tells the Nous app from SpaceApp v2.
    expect(nousClientContext({ userAgent: UA.okhttp, appClaim: "nous" })).toEqual({ app: "NOUS_ANDROID", os: "ANDROID" });
    expect(nousClientContext({ userAgent: UA.okhttp, appClaim: "spaceapp", header: "v=0.2.2; form=PHONE; view=rooms; vp=412x915" }))
      .toEqual({ app: "SPACEAPP_ANDROID", os: "ANDROID", form: "PHONE", version: "0.2.2", view: "rooms", viewport: "412x915" });
    expect(nousClientContext({ userAgent: UA.okhttp })).toEqual({ app: "UNKNOWN" });
    expect(nousClientContext({ via: "TELEGRAM", userAgent: UA.windowsChrome, header: "app=WEB" })).toEqual({ app: "TELEGRAM" });
  });

  it("lets the header name the desktop app the stripped Electron UA hides, never against a firm signal", () => {
    expect(nousClientContext({ userAgent: UA.windowsChrome, header: "app=DESKTOP_WINDOWS; v=0.1.30; view=nous:chat" }))
      .toEqual({ app: "DESKTOP_WINDOWS", os: "WINDOWS", form: "DESKTOP", version: "0.1.30", view: "nous:chat" });
    expect(nousClientContext({ userAgent: UA.webView, header: "app=DESKTOP_WINDOWS" }).app).toBe("SPACEAPP_ANDROID");
    expect(nousClientContext({ userAgent: UA.okhttp, appClaim: "nous", header: "app=WEB" }).app).toBe("NOUS_ANDROID");
    expect(nousClientContext({ userAgent: UA.windowsChrome, header: "app=TELEGRAM" }).app).toBe("WEB");
  });

  it("drops bad keys and values instead of failing", () => {
    expect(parseNousClientHeader("app=EVIL; v=<script>; view=nous:chat; vp=9x; zz=1; os=ANDROID")).toEqual({ view: "nous:chat", os: "ANDROID" });
    expect(parseNousClientHeader("x".repeat(301))).toEqual({});
    expect(parseNousClientHeader(formatNousClientHeader({ app: "NOUS_ANDROID", version: "0.2.10", form: "PHONE", viewport: "412x915" })))
      .toEqual({ app: "NOUS_ANDROID", version: "0.2.10", form: "PHONE", viewport: "412x915" });
  });

  it("describes it in one phrase for the turn text", () => {
    expect(describeNousClient({ app: "NOUS_ANDROID", version: "0.2.10", os: "ANDROID", form: "PHONE", view: "requests" })).toBe("the Nous app 0.2.10 on an Android phone, view requests");
    expect(describeNousClient({ app: "DESKTOP_WINDOWS", os: "WINDOWS", form: "DESKTOP" })).toBe("the Windows desktop app on a computer (Windows)");
    expect(describeNousClient({ app: "TELEGRAM" })).toBe("Telegram");
  });

  it("covers macOS and Live, the kinds no real message has reached yet", () => {
    const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
    const context = nousClientContext({ userAgent: mac, header: "app=DESKTOP_MAC; v=0.1.30" });
    expect(context).toEqual({ app: "DESKTOP_MAC", os: "MACOS", form: "DESKTOP", version: "0.1.30" });
    expect(describeNousClient(context)).toBe("the macOS desktop app 0.1.30 on a computer (macOS)");
    expect(describeNousClient(nousClientContext({ via: "LIVE", userAgent: mac }))).toBe("Live voice");
  });

  // Step 6 proof: meta.client of real operator messages on stable (31/10-1/11), read with space-admin-action nous-messages.
  it("reads the clients stable recorded back into the turn text", () => {
    const real: Array<[string, unknown, string]> = [
      ["nous_msg:9be95f7dc7ea4cb58dcae6ef", { os: "WINDOWS", app: "DESKTOP_WINDOWS", form: "DESKTOP", view: "nous:conversation", version: "0.1.26", viewport: "1920x1032" },
        "the Windows desktop app 0.1.26 on a computer (Windows), view nous:conversation"],
      ["nous_msg:9c64bde7072b4117b00229eb", { os: "LINUX", app: "DESKTOP_LINUX", form: "DESKTOP", view: "nous:conversation", version: "0.1.26", viewport: "1536x832" },
        "the Linux desktop app 0.1.26 on a computer (Linux), view nous:conversation"],
      ["nous_msg:7e7360e1cdd745dcb6d91a34", { os: "ANDROID", app: "NOUS_ANDROID", form: "PHONE", view: "/", version: "0.2.18", viewport: "411x891" },
        "the Nous app 0.2.18 on an Android phone, view /"],
      ["nous_msg:bb6dec1d09c04584b9eace6a", { os: "ANDROID", app: "SPACEAPP_ANDROID", form: "PHONE", view: "nous:conversation", viewport: "411x473" },
        "the SpaceApp Android app on an Android phone, view nous:conversation"],
      ["nous_msg:015823b72b884374a9ad58a4", { os: "LINUX", app: "WEB", form: "DESKTOP" }, "the web app on a computer (Linux)"]
    ];
    for (const [, stored, phrase] of real) expect(describeNousClient(nousClientContextSchema.parse(stored))).toBe(phrase);
  });
});
