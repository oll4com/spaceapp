import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpaceBrand } from "../src/SpaceBrand.js";

const brandAssetPath = (fileName: string) => resolve(__dirname, "../public/brand", fileName);

function gifDurationMs(gif: Buffer): number {
  let offset = 13;
  const logicalScreenPackedField = gif[10] ?? 0;
  if ((logicalScreenPackedField & 0x80) !== 0) {
    offset += 3 * 2 ** ((logicalScreenPackedField & 0x07) + 1);
  }

  let durationCentiseconds = 0;
  while (offset < gif.length) {
    const blockType = gif[offset];
    if (blockType === 0x3b) break;

    if (blockType === 0x21) {
      const extensionLabel = gif[offset + 1];
      if (extensionLabel === 0xf9 && gif[offset + 2] === 0x04) {
        durationCentiseconds += gif.readUInt16LE(offset + 4);
        offset += 8;
        continue;
      }

      offset += 2;
      while (offset < gif.length) {
        const blockSize = gif[offset] ?? 0;
        offset += 1;
        if (blockSize === 0) break;
        offset += blockSize;
      }
      continue;
    }

    if (blockType === 0x2c) {
      const imagePackedField = gif[offset + 9] ?? 0;
      offset += 10;
      if ((imagePackedField & 0x80) !== 0) {
        offset += 3 * 2 ** ((imagePackedField & 0x07) + 1);
      }
      offset += 1;
      while (offset < gif.length) {
        const blockSize = gif[offset] ?? 0;
        offset += 1;
        if (blockSize === 0) break;
        offset += blockSize;
      }
      continue;
    }

    throw new Error(`Unexpected GIF block 0x${blockType?.toString(16) ?? "EOF"}`);
  }

  return durationCentiseconds * 10;
}

describe("SpaceBrand", () => {
  const currentImageSource = () => screen.getByRole("img", { name: "Space" }).getAttribute("src");

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts with the static PNG and returns to it after one 4.8 second GIF cycle", () => {
    render(<SpaceBrand />);

    const control = screen.getByRole("button", { name: "Play Space logo animation" });
    expect(currentImageSource()).toBe("/brand/space-logo-2048.png");

    fireEvent.click(control);
    expect(currentImageSource()).toBe("/brand/space-logo.gif");
    fireEvent.load(screen.getByRole("img", { name: "Space" }));

    act(() => vi.advanceTimersByTime(4_799));
    expect(currentImageSource()).toBe("/brand/space-logo.gif");

    act(() => vi.advanceTimersByTime(1));
    expect(currentImageSource()).toBe("/brand/space-logo-2048.png");
  });

  it("restarts the full animation cycle when clicked while the GIF is playing", () => {
    render(<SpaceBrand />);

    const control = screen.getByRole("button", { name: "Play Space logo animation" });
    fireEvent.click(control);
    fireEvent.load(screen.getByRole("img", { name: "Space" }));
    act(() => vi.advanceTimersByTime(3_000));

    fireEvent.click(control);
    fireEvent.load(screen.getByRole("img", { name: "Space" }));
    act(() => vi.advanceTimersByTime(4_799));
    expect(currentImageSource()).toBe("/brand/space-logo.gif");

    act(() => vi.advanceTimersByTime(1));
    expect(currentImageSource()).toBe("/brand/space-logo-2048.png");
  });

  it("starts the full animation timer only after the GIF has loaded", () => {
    render(<SpaceBrand />);

    fireEvent.click(screen.getByRole("button", { name: "Play Space logo animation" }));
    const animatedLogo = screen.getByRole("img", { name: "Space" });
    expect(currentImageSource()).toBe("/brand/space-logo.gif");
    expect(vi.getTimerCount()).toBe(0);

    act(() => vi.advanceTimersByTime(4_800));
    expect(currentImageSource()).toBe("/brand/space-logo.gif");

    fireEvent.load(animatedLogo);
    expect(vi.getTimerCount()).toBe(1);
    act(() => vi.advanceTimersByTime(4_800));
    expect(currentImageSource()).toBe("/brand/space-logo-2048.png");
  });

  it("falls back from a failed GIF to the static PNG and from a failed PNG to the SVG", () => {
    render(<SpaceBrand />);

    const control = screen.getByRole("button", { name: "Play Space logo animation" });
    fireEvent.click(control);
    fireEvent.error(screen.getByRole("img", { name: "Space" }));
    expect(currentImageSource()).toBe("/brand/space-logo-2048.png");

    fireEvent.error(screen.getByRole("img", { name: "Space" }));
    expect(currentImageSource()).toBe("/brand/space-logo.svg");
  });

  it("cleans up the pending animation timer when unmounted", () => {
    const { unmount } = render(<SpaceBrand />);

    fireEvent.click(screen.getByRole("button", { name: "Play Space logo animation" }));
    fireEvent.load(screen.getByRole("img", { name: "Space" }));
    expect(vi.getTimerCount()).toBe(1);

    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("plays the orbital animation and invokes its room action on every click", () => {
    const onActivate = vi.fn();
    render(<SpaceBrand orbital onActivate={onActivate} />);
    const control = screen.getByRole("button", { name: "Play Space logo animation" });
    expect(currentImageSource()).toBe("/brand/spaceapp-orbital.png");
    fireEvent.click(control);
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(currentImageSource()).toBe("/brand/spaceapp-orbital.gif");
    fireEvent.load(screen.getByRole("img", { name: "Space" }));
    act(() => vi.advanceTimersByTime(4_800));
    expect(currentImageSource()).toBe("/brand/spaceapp-orbital.png");
    fireEvent.click(control);
    expect(onActivate).toHaveBeenCalledTimes(2);
    fireEvent.error(screen.getByRole("img", { name: "Space" }));
    expect(currentImageSource()).toBe("/brand/spaceapp-orbital.png");
    fireEvent.error(screen.getByRole("img", { name: "Space" }));
    expect(currentImageSource()).toBe("/brand/spaceapp-orbital.ico");
  });

  it("ships a square orbital GIF with multiple frames and a 4.8 second cycle", () => {
    const gif = readFileSync(brandAssetPath("spaceapp-orbital.gif"));
    expect(gif.subarray(0, 6).toString("ascii")).toBe("GIF89a");
    expect(gif.readUInt16LE(6)).toBe(512);
    expect(gif.readUInt16LE(8)).toBe(512);
    expect(gifDurationMs(gif)).toBe(4_800);
  });

  it("ships valid PNG, GIF and SVG brand assets with one 4.8 second GIF cycle", () => {
    const png = readFileSync(brandAssetPath("space-logo-2048.png"));
    const gif = readFileSync(brandAssetPath("space-logo.gif"));
    const svg = readFileSync(brandAssetPath("space-logo.svg"), "utf8");

    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(png.readUInt32BE(16)).toBe(2_048);
    expect(png.readUInt32BE(20)).toBe(2_048);
    expect(gif.subarray(0, 6).toString("ascii")).toBe("GIF89a");
    expect(gif.readUInt16LE(6)).toBe(512);
    expect(gif.readUInt16LE(8)).toBe(512);
    expect(gifDurationMs(gif)).toBe(4_800);
    expect(svg.trimStart().startsWith("<svg")).toBe(true);
    expect(svg).toContain('viewBox="0 0 512 512"');
    expect(svg).not.toMatch(/<script|<foreignObject|\son\w+=|\shref=|url\(/i);
  });
});
