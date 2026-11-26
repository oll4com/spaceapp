import { readFileSync } from "node:fs";
import jsqr from "jsqr";
import { JSDOM } from "jsdom";
import { deflateSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { generateVaultTransportKey, newVaultHandle, openWithVaultPrivateKey, vaultBase64url } from "@space/contracts";
import { pngPixels } from "../src/vault/png-pixels.js";
import { QR_RETRY_WAITS_MS, runSealedFill, type SealedFillBroker, type SealedFillPage } from "../src/vault/sealed-fill.js";

// Synthetic setup QRs only: otpauth://totp/Example:synthetic@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Example (the public example key).
const KEY = "JBSWY3DPEHPK3PXP";
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const ORIGIN = "https://admin.example";
const VAULT = newVaultHandle("vault");
const broker = {} as SealedFillBroker; // OTP_QR never asks the broker for anything.

function fakePage(png: Buffer | Buffer[], state = { url: `${ORIGIN}/admin/setup`, frameId: "frame-1", afterShot: null as null | string }) {
  const sent: string[] = [], shots = [png].flat(); // each capture takes the next shot; the last one stays
  const page: SealedFillPage = {
    targetId: "target-1", sessionId: "session-1", paneId: "pane:vault",
    cdp: {
      async send(method: string) {
        sent.push(method);
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: state.frameId, url: state.url, loaderId: "loader-1" } } } as never;
        if (method === "Page.getLayoutMetrics") return { cssContentSize: { width: 350, height: 350 } } as never;
        if (method === "Page.captureScreenshot") { if (state.afterShot) state.url = state.afterShot; return { data: (shots.length > 1 ? shots.shift()! : shots[0]!).toString("base64") } as never; }
        throw new Error(`unexpected ${method}`);
      }
    }
  };
  return { page, sent };
}

// A QR not found is read again after QR_RETRY_WAITS_MS: fake timers keep these tests instant.
async function fill(page: SealedFillPage, body: unknown) {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  try {
    const answer = runSealedFill(page, broker, body, new Date());
    await vi.runAllTimersAsync();
    return await answer;
  } finally { vi.useRealTimers(); }
}

async function request() {
  const inbox = await generateVaultTransportKey();
  return { inbox, body: { mode: "OTP_QR", ownerUserId: "user:alice", vaultId: VAULT, paneId: "pane:vault", targetId: "target-1", frameId: "frame-1",
    origin: ORIGIN, inboxPublicKey: vaultBase64url.encode(inbox.publicKey) } };
}

describe("Vault authenticator setup QR (Browser Host, nous_msg:cb10eefe6cc544e7af63ff64)", () => {
  it("decodes Chrome's RGB and RGBA PNG captures for jsQR", () => {
    for (const name of ["vault-otp-qr-rgba.png", "vault-otp-qr-rgb.png"]) {
      const pixels = pngPixels(fixture(name))!;
      expect([pixels.width, pixels.height, pixels.data.length]).toEqual([350, 350, 350 * 350 * 4]);
    }
    expect(pngPixels(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it("seals the page's setup key to the inbox and answers only a status: the key is nowhere in the answer", async () => {
    const { inbox, body } = await request();
    const { page } = fakePage(fixture("vault-otp-qr-rgba.png"));
    const answer = await runSealedFill(page, broker, body, new Date());
    expect(answer.status).toBe("SAVED");
    expect(JSON.stringify(answer)).not.toContain(KEY);
    expect(JSON.stringify(answer)).not.toMatch(/otpauth|secret=/i);
    const opened = await openWithVaultPrivateKey(inbox.privateKey, inbox.publicKey, answer.sealedGenerated, { ownerUserId: "user:alice", vaultId: VAULT, keyVersion: 1 });
    expect(new TextDecoder().decode(opened)).toBe(KEY);
  });

  it("refuses a page with no QR, another origin, or a page that moved during the capture, sealing nothing", async () => {
    const { body } = await request();
    const empty = fakePage(Buffer.from(pngBlank()));
    const blank = await fill(empty.page, body);
    expect([blank.status, blank.reason, blank.sealedGenerated]).toEqual(["BLOCKED", "QR_NOT_FOUND", null]);
    expect(empty.sent.filter((method) => method === "Page.captureScreenshot")).toHaveLength(QR_RETRY_WAITS_MS.length + 1);
    const elsewhere = fakePage(fixture("vault-otp-qr-rgb.png"), { url: "https://evil.example/", frameId: "frame-1", afterShot: null });
    const refused = await runSealedFill(elsewhere.page, broker, body, new Date());
    expect([refused.status, refused.reason]).toEqual(["ORIGIN_MISMATCH", "ORIGIN_CHANGED"]);
    expect(elsewhere.sent).not.toContain("Page.captureScreenshot");
    const moved = await runSealedFill(fakePage(fixture("vault-otp-qr-rgb.png"), { url: `${ORIGIN}/admin/setup`, frameId: "frame-1", afterShot: "https://evil.example/" }).page, broker, body, new Date());
    expect([moved.status, moved.reason, moved.sealedGenerated]).toEqual(["ORIGIN_MISMATCH", "ORIGIN_CHANGED", null]);
  });

  it("reads again while a setup dialog's QR is still drawing (Braintrust 19/11: the agent calls at once)", async () => {
    const { inbox, body } = await request();
    const loading = fakePage([Buffer.from(pngBlank()), fixture("vault-otp-qr-rgba.png")]);
    const answer = await fill(loading.page, body);
    expect(answer.status).toBe("SAVED");
    expect(JSON.stringify(answer)).not.toContain(KEY);
    expect(loading.sent.filter((method) => method === "Page.captureScreenshot")).toHaveLength(2);
    const opened = await openWithVaultPrivateKey(inbox.privateKey, inbox.publicKey, answer.sealedGenerated, { ownerUserId: "user:alice", vaultId: VAULT, keyVersion: 1 });
    expect(new TextDecoder().decode(opened)).toBe(KEY);
  });
});

// Braintrust 18/11 (QR_NOT_FOUND at every scroll): a QR drawn edge to edge on a dark card, or light on dark, reads only on its own in a white quiet zone.
describe("Vault setup QR, Tier 2: the QR element alone", () => {
  type Pixels = { data: Uint8ClampedArray; width: number; height: number };
  // The fixture's QR without its quiet zone: the box of its dark pixels.
  const bare = (): Pixels => {
    const page = pngPixels(fixture("vault-otp-qr-rgba.png"))!;
    let left = page.width, top = page.height, right = 0, bottom = 0;
    for (let y = 0; y < page.height; y++) for (let x = 0; x < page.width; x++) if (page.data[(y * page.width + x) * 4]! < 128) {
      left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
    }
    return crop(page, left, top, right - left + 1, bottom - top + 1, 1);
  };
  function crop(from: Pixels, left: number, top: number, width: number, height: number, scale: number): Pixels {
    const w = Math.round(width * scale), h = Math.round(height * scale), data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const source = ((top + Math.floor(y / scale)) * from.width + left + Math.floor(x / scale)) * 4;
      data.set(from.data.subarray(source, source + 4), (y * w + x) * 4);
    }
    return { data, width: w, height: h };
  }
  // A page: `background` everywhere, the QR (inverted or not) at 300,200.
  function scene(background: number, invert: boolean): Pixels {
    const qr = bare(), width = 800, height = 600, data = new Uint8ClampedArray(width * height * 4).fill(background);
    for (let i = 3; i < data.length; i += 4) data[i] = 255;
    for (let y = 0; y < qr.height; y++) for (let x = 0; x < qr.width; x++) for (let c = 0; c < 3; c++) {
      const value = qr.data[(y * qr.width + x) * 4 + c]!;
      data[((y + 200) * width + x + 300) * 4 + c] = invert ? 255 - value : value;
    }
    return { data, width, height };
  }
  function qrPage(image: Pixels, qrSide: number) {
    const dom = new JSDOM('<div role="dialog"><img id="logo"><img id="wide"><img id="qr"></div>', { runScripts: "outside-only", url: `${ORIGIN}/settings/security` });
    const boxes: Record<string, [number, number, number, number]> = { logo: [20, 20, 48, 48], wide: [100, 20, 300, 60], qr: [300, 200, qrSide, qrSide] };
    dom.window.Element.prototype.getBoundingClientRect = function (this: Element) {
      const [x, y, width, height] = boxes[this.id] ?? [0, 0, 0, 0];
      return { x, y, width, height } as DOMRect;
    };
    dom.window.Element.prototype.scrollIntoView = () => undefined;
    const sent: string[] = [];
    const page: SealedFillPage = { targetId: "target-1", sessionId: "session-1", paneId: "pane:vault", cdp: {
      async send(method: string, params: Record<string, unknown> = {}) {
        sent.push(method);
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame-1", url: `${ORIGIN}/settings/security`, loaderId: "loader-1" } } } as never;
        if (method === "Page.getLayoutMetrics") return { cssContentSize: { width: image.width, height: image.height } } as never;
        if (method === "Page.createIsolatedWorld") return { executionContextId: 7 } as never;
        if (method === "Runtime.evaluate") return { result: { value: dom.window.eval(String(params.expression)) } } as never;
        if (method === "Page.captureScreenshot") {
          const clip = params.clip as { x: number; y: number; width: number; height: number; scale: number };
          return { data: png(params.captureBeyondViewport ? image : crop(image, clip.x, clip.y, clip.width, clip.height, clip.scale)).toString("base64") } as never;
        }
        throw new Error(`unexpected ${method}`);
      }
    } };
    return { page, sent };
  }

  for (const [name, background, invert] of [["edge to edge on a dark card", 32, false], ["light on dark, on a white page", 255, true]] as const) {
    it(`reads a QR ${name} that the whole page does not show`, async () => {
      const image = scene(background, invert);
      expect(jsqr.default(image.data, image.width, image.height)).toBeNull();
      const { inbox, body } = await request();
      const { page, sent } = qrPage(image, bare().width);
      const answer = await runSealedFill(page, broker, body, new Date());
      expect([answer.status, answer.reason]).toEqual(["SAVED", null]);
      expect(sent).toContain("Page.createIsolatedWorld");
      const opened = await openWithVaultPrivateKey(inbox.privateKey, inbox.publicKey, answer.sealedGenerated, { ownerUserId: "user:alice", vaultId: VAULT, keyVersion: 1 });
      expect(new TextDecoder().decode(opened)).toBe(KEY);
    });
  }

  it("still answers QR_NOT_FOUND when no element holds a QR", async () => {
    const { body } = await request();
    const answer = await fill(qrPage({ data: new Uint8ClampedArray(800 * 600 * 4).fill(255), width: 800, height: 600 }, 120).page, body);
    expect([answer.status, answer.reason]).toEqual(["BLOCKED", "QR_NOT_FOUND"]);
  });
});

// An RGB PNG of RGBA pixels (zero CRCs, as pngBlank).
function png(pixels: { data: Uint8ClampedArray; width: number; height: number }): Buffer {
  const chunk = (type: string, body: Buffer) => { const head = Buffer.alloc(8); head.writeUInt32BE(body.length, 0); head.write(type, 4, "latin1"); return Buffer.concat([head, body, Buffer.alloc(4)]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(pixels.width, 0); header.writeUInt32BE(pixels.height, 4); header[8] = 8; header[9] = 2;
  const rows = Buffer.alloc((pixels.width * 3 + 1) * pixels.height);
  for (let y = 0; y < pixels.height; y++) for (let x = 0; x < pixels.width; x++) for (let c = 0; c < 3; c++) rows[y * (pixels.width * 3 + 1) + 1 + x * 3 + c] = pixels.data[(y * pixels.width + x) * 4 + c]!;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

// A white 40x40 RGB PNG: no QR in it (pngPixels reads no CRC, so the chunks carry zero CRCs).
function pngBlank(): Uint8Array {
  const chunk = (type: string, body: Buffer) => { const head = Buffer.alloc(8); head.writeUInt32BE(body.length, 0); head.write(type, 4, "latin1"); return Buffer.concat([head, body, Buffer.alloc(4)]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(40, 0); header.writeUInt32BE(40, 4); header[8] = 8; header[9] = 2;
  const rows = Buffer.concat(Array.from({ length: 40 }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(120, 255)])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}
