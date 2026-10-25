import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readPublicHomepageConfig } from "../src/features/app-version/public-config.js";
import { resolveEntryRoute } from "../src/entry-route.js";

describe("public homepage routing", () => {
  it("sends the public root and /homepage to spaceapp.dev and preserves the Space app root", () => {
    expect(resolveEntryRoute("/", "spaceapp.dev")).toBe("public-site");
    expect(resolveEntryRoute("/", "spaceapp.example")).toBe("app");
    expect(resolveEntryRoute("/", "127.0.0.1")).toBe("app");
    expect(resolveEntryRoute("/homepage", "spaceapp.example")).toBe("public-site");
    expect(resolveEntryRoute("/homepage/", "spaceapp.example")).toBe("public-site");
    expect(resolveEntryRoute("/demo-workspace", "spaceapp.dev")).toBe("demo");
    expect(resolveEntryRoute("/demo-workspace/", "spaceapp.example")).toBe("demo");
    expect(resolveEntryRoute("/app", "spaceapp.dev")).toBe("app");
    expect(resolveEntryRoute("/app/", "spaceapp.example")).toBe("app");
    expect(resolveEntryRoute("/help", "spaceapp.example")).toBe("app");
    expect(resolveEntryRoute("/homepage-preview", "spaceapp.dev")).toBe("app");
  });

  it("keeps the operator app, global styles, and xterm graph behind a dynamic import", () => {
    const source = readFileSync("src/main.tsx", "utf8");
    const document = readFileSync("index.html", "utf8");

    expect(source).toContain("window.location.replace(PUBLIC_SITE_URL)");
    expect(source).not.toContain("features/homepage");
    expect(source).toContain('import("./demo/DemoSpaceApp.js")');
    expect(source).toContain('import("./live/LiveSpaceApp.js")');
    expect(source).toContain('import("./styles.css")');
    expect(source).not.toMatch(/^import\s+.*from\s+["']\.\/App\.js["']/m);
    expect(source).not.toMatch(/^import\s+["']\.\/styles\.css["']/m);
    expect(source).not.toContain("@xterm/xterm");
    expect(document).toContain('<script src="/homepage-config.js"></script>');
    expect(document.indexOf('/homepage-config.js')).toBeLessThan(document.indexOf('/src/main.tsx'));
  });

  it("no longer ships the retired in-app homepage", () => {
    expect(existsSync("src/features/homepage")).toBe(false);
  });

  it("ships valid crawler guidance for the public homepage", () => {
    const robots = readFileSync("public/robots.txt", "utf8");
    const llms = readFileSync("public/llms.txt", "utf8");

    expect(robots).toContain("Allow: /");
    expect(robots).not.toContain("/app");
    expect(robots).toContain("Disallow: /help");
    expect(robots).toContain("Disallow: /api/");
    expect(llms).toMatch(/^# Space/m);
    expect(llms).toContain("[Space homepage](/)");
    expect(llms).toContain("[Interactive demo](/#demo)");
  });

  it("accepts only canonical Discord HTTPS invite URLs from runtime window configuration", () => {
    expect(readPublicHomepageConfig({ discordUrl: "https://discord.gg/space-demo" })).toEqual({
      discordUrl: "https://discord.gg/space-demo"
    });
    expect(readPublicHomepageConfig({ discordUrl: "https://discord.com/invite/space-demo" })).toEqual({
      discordUrl: "https://discord.com/invite/space-demo"
    });
    expect(readPublicHomepageConfig({ discordUrl: "http://discord.gg/space-demo" }).discordUrl).toBeNull();
    expect(readPublicHomepageConfig({ discordUrl: "https://discord.gg.evil.example/space" }).discordUrl).toBeNull();
    expect(readPublicHomepageConfig({ discordUrl: "https://discord.com/login" }).discordUrl).toBeNull();
    expect(readPublicHomepageConfig({ discordUrl: "https://discord.gg/" }).discordUrl).toBeNull();
    expect(readPublicHomepageConfig({ discordUrl: "https://user:secret@discord.gg/space" }).discordUrl).toBeNull();
    expect(readPublicHomepageConfig({ discordUrl: "https://discord.gg:444/space" }).discordUrl).toBeNull();
    expect(readPublicHomepageConfig({}).discordUrl).toBeNull();
  });
});
