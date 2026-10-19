import { describe, expect, it, vi } from "vitest";
import { createDesignRenderer } from "../src/design/render.js";

const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
const answer = (request: Record<string, unknown>) => ({ templateId: request.templateId, width: request.width, height: request.height, format: request.format,
  mimeType: `image/${String(request.format)}`, bytes: png.length, sha256: "a".repeat(64), base64: png.toString("base64") });

describe("Design template renderer adapter", () => {
  it("sends the validated fields only and returns the image at the requested size", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const render = createDesignRenderer({ run: async (raw) => { const request = JSON.parse(raw); requests.push(request); return JSON.stringify(answer(request)); } });
    const result = await render("user:operator", {
      templateId: "wide-banner", width: 1584, height: 396, params: { headline: "SpaceApp" }, imagePaths: { logo: "/opt/spaceapp/apps/web/public/brand/space-logo.svg" },
      brandKit: { name: "SpaceApp", colors: { background: "#0A0E24", surface: "#121A3A", text: "#FFFFFF", primary: "#67D9F5", accent: "#93E9FA" },
        fonts: { heading: "Inter", body: "Inter" }, id: "dbrand:spaceapp", voice: "calm" } as never,
      safeArea: { top: 40, right: 60, bottom: 40, left: 420 }
    });
    expect(result).toMatchObject({ mimeType: "image/png", format: "png", width: 1584, height: 396, sha256: "a".repeat(64) });
    expect(result.bytes).toEqual(png);
    expect(requests[0]).toEqual({ templateId: "wide-banner", width: 1584, height: 396, format: "png", params: { headline: "SpaceApp" },
      imagePaths: { logo: "/opt/spaceapp/apps/web/public/brand/space-logo.svg" },
      brandKit: { name: "SpaceApp", colors: { background: "#0A0E24", surface: "#121A3A", text: "#FFFFFF", primary: "#67D9F5", accent: "#93E9FA" },
        fonts: { heading: "Inter", body: "Inter" } }, safeArea: { top: 40, right: 60, bottom: 40, left: 420 } });
  });

  it("refuses an answer of another size, and renders one design at a time per owner", async () => {
    const wrong = createDesignRenderer({ run: async (raw) => JSON.stringify({ ...answer(JSON.parse(raw)), width: 10 }) });
    await expect(wrong("user:a", { templateId: "quote-card", width: 1080, height: 1080 })).rejects.toThrow(/requested size/);

    const releases: Array<() => void> = [];
    const run = vi.fn((raw: string) => new Promise<string>((resolve) => { releases.push(() => resolve(JSON.stringify(answer(JSON.parse(raw))))); }));
    const render = createDesignRenderer({ run });
    const first = render("user:a", { templateId: "quote-card", width: 1080, height: 1080 });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    await expect(render("user:a", { templateId: "quote-card", width: 1080, height: 1080 })).rejects.toThrow(/Another design is being rendered/);
    // Another owner is not held up.
    const other = render("user:b", { templateId: "quote-card", width: 1080, height: 1080 });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    releases.forEach((release) => release());
    await Promise.all([first, other]);
    // The owner's slot is free again.
    const again = render("user:a", { templateId: "quote-card", width: 1080, height: 1080 });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(3));
    releases[2]!();
    await expect(again).resolves.toMatchObject({ width: 1080 });
  });
});
