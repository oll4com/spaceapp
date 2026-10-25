// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { captureDomFrame, compileNeeds, SnipDomUnsupportedError } from "../src/features/snip-tool/snip-dom-capture.js";

const rect = (x: number, y: number, width: number, height: number) => ({ x, y, left: x, top: y, width, height, right: x + width, bottom: y + height, toJSON: () => ({}) }) as DOMRect;
let svgMarkup = "";

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 600 });
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 2 });
  svgMarkup = "";
  // jsdom cannot decode images; record the snapshot markup instead.
  Object.defineProperty(HTMLImageElement.prototype, "decode", { configurable: true, writable: true, value: function (this: HTMLImageElement) {
    if (this.src.startsWith("data:image/svg+xml")) svgMarkup = decodeURIComponent(this.src.slice(this.src.indexOf(",") + 1));
    return Promise.resolve();
  } });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn(), getImageData: vi.fn() } as any);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,UElYRUxT");
});
afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); delete (HTMLImageElement.prototype as any).decode; });

describe("permission-free page capture", () => {
  it("snapshots the page at device pixels without the Snip Tool, secrets or unscrolled content", async () => {
    document.body.innerHTML = `
      <main class="board"><input type="password" value="hunter2"><input value="typed">
        <div class="log" style="overflow:auto;height:50px"><p class="line">first</p></div>
        <canvas class="pane-canvas" width="40" height="20"></canvas></main>
      <div class="snip-ui snip-capsule">capsule</div>`;
    const log = document.querySelector(".log")!;
    Object.defineProperty(log, "scrollTop", { configurable: true, value: 30 });
    vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue(rect(10, 10, 40, 20));
    const frame = await captureDomFrame({ region: { x: 0, y: 0, width: 300, height: 200 } });
    expect([frame.width, frame.height]).toEqual([600, 400]);
    expect(svgMarkup).toContain('class="board"');
    expect(svgMarkup).not.toContain("capsule");
    expect(svgMarkup).not.toContain("hunter2");
    expect(svgMarkup).toContain('value="xxxxxxx"');
    expect(svgMarkup).toContain('value="typed"');
    expect(svgMarkup).toMatch(/class="line"[^>]*translate\(0px, -30px\)|translate\(0px, -30px\)[^>]*class="line"/);
    expect(svgMarkup).toContain("background-image: url(&quot;data:image/png;base64,UElYRUxT&quot;)");
  });

  it("leaves embedded pages to screen sharing only when they are inside the snip", async () => {
    document.body.innerHTML = `<div class="pane"><iframe src="https://example.com/"></iframe></div>`;
    const frameBox = vi.spyOn(HTMLIFrameElement.prototype, "getBoundingClientRect").mockReturnValue(rect(500, 400, 200, 100));
    await expect(captureDomFrame({ region: { x: 0, y: 0, width: 300, height: 200 } })).resolves.toBeTruthy();
    expect(svgMarkup).not.toContain("example.com");
    frameBox.mockReturnValue(rect(100, 100, 200, 100));
    await expect(captureDomFrame({ region: { x: 0, y: 0, width: 300, height: 200 } })).rejects.toBeInstanceOf(SnipDomUnsupportedError);
  });

  it("leaves a visible video with native controls to screen sharing", async () => {
    document.body.innerHTML = `<div class="player"><video controls src="/demo/media/clip.mp4"></video></div>`;
    const box = vi.spyOn(HTMLVideoElement.prototype, "getBoundingClientRect").mockReturnValue(rect(600, 400, 160, 90));
    await expect(captureDomFrame({ region: { x: 0, y: 0, width: 300, height: 200 } })).resolves.toBeTruthy();
    box.mockReturnValue(rect(20, 20, 160, 90));
    await expect(captureDomFrame({ region: { x: 0, y: 0, width: 300, height: 200 } })).rejects.toMatchObject({ reason: "a video" });
  });

  it("empties subtrees far from the snip, keeping their box, unless something inside reaches it or a :has() rule depends on it", async () => {
    const style = document.createElement("style");
    style.textContent = ".board:has(.badge) .title { color: red; }";
    document.head.append(style);
    document.body.innerHTML = `
      <div class="board">
        <div class="far" data-rect="0,0,100,100"><p>far text</p></div>
        <div class="near" data-rect="380,280,300,200"><p>near text</p></div>
        <div class="escape" data-rect="0,0,100,100"><div class="menu" data-rect="420,320,50,50">menu text</div></div>
        <div class="guarded" data-rect="0,0,100,100"><span class="badge">badge text</span></div>
      </div>`;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const parts = this.dataset.rect?.split(",").map(Number);
      return parts ? rect(parts[0]!, parts[1]!, parts[2]!, parts[3]!) : rect(-1000, -1000, 0, 0);
    });
    try {
      await captureDomFrame({ region: { x: 400, y: 300, width: 200, height: 100 } });
    } finally { style.remove(); }
    expect(svgMarkup).not.toContain("far text");
    expect(svgMarkup).toMatch(/class="far"[^>]*style="width: [^;]*!important[^"]*min-width:/);
    expect(svgMarkup).toContain("near text");
    expect(svgMarkup).toContain("menu text");
    expect(svgMarkup).toContain("badge text");
  });

  it("embeds only the CSS a static snapshot can match", () => {
    expect(compileNeeds(".pane .title, .chip")).toEqual([["pane", "title"], ["chip"]]);
    expect(compileNeeds(".button:hover")).toEqual([]);
    expect(compileNeeds(".x:not(.y):is(.a, .b) [href$='.png']")).toEqual([["x"]]);
    expect(compileNeeds("div > span")).toBeNull();
    expect(compileNeeds(".esc\\:aped")).toBeNull();
  });
});
