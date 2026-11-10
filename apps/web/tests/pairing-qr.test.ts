import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { pairingQrModules, pairingQrPath } from "../src/features/auth/pairing-qr.js";

// Nous Pro 1b-6: the pairing QR drawn in the browser. Expected symbols from segno 1.6.6 (make(text, error="m", boost_error=False,
// mode="byte", micro=False[, mask]); rows of 0/1 joined by newlines, SHA-256; gen2.py in ~/agent-workspace/active/20261031-nous-pro/qr-ref).
// segno adds a zero byte when the data already ends on a codeword boundary; the reference patches that to ISO/IEC 18004 7.4.10 (none).
const long = `SPACEAPP-PAIR:1:${"eyJ2IjoxLCJvIjoiQUFBQUFBQUFBQUEiLCJ1IjpbImh0dHBzOi8vc3BhY2UuZXhhbXBsZS5jb206NDkxMSJdLCJyIjpudWxsfQ".repeat(4)}`;
const texts = { short: "Space", medium: "https://space.example.com:4911/api/mobile/channel?m=pair", long };
const digest = (modules: boolean[][]) => createHash("sha256").update(modules.map((row) => row.map((dark) => (dark ? "1" : "0")).join("")).join("\n")).digest("hex");
const size = (version: number) => version * 4 + 17;

describe("the pairing QR", () => {
  it("matches segno module for module, versions 1, 4 and 15, three masks each", () => {
    const vectors: Array<[keyof typeof texts, number, number, string]> = [
      ["short", 0, 1, "826a41c1e37a9ba6c194de50c93b23b9be1fb0b70873645e13d4f5b8453b93da"], ["short", 3, 1, "12c25ea0974b52f6d84100f26429078e402d91443010c3b2e4e898269804a35f"],
      ["short", 6, 1, "c3659583a6ba5eeccd7c9b4f8ddf3f1455004b04adc7abb91974828bbbb489a7"], ["medium", 0, 4, "480929255a18c5e21d296b34f310a180c765b73f22628aa529fdf51ea4bfe64c"],
      ["medium", 3, 4, "72fe76f82995bd80ebf73339250fba755b8a462e95d44fbaacbda21efd2f0b57"], ["medium", 6, 4, "643a388dd411f41ed20bb5512c339a0820a9d38891235fedd57fffdb84151ca7"],
      ["long", 0, 15, "d409a87d1e4e37db20c33ec33edea35635423f400ed24337db107b795d37f708"], ["long", 3, 15, "e40f62613e235e1c6b237262b88e97fc6b881e1e81c9c5aae70f6abdacfdcc7e"],
      ["long", 6, 15, "074338182352ad7ba33ae3fe41f0b8226c3811ab5893163f9f36e9d58883bc22"]
    ];
    for (const [name, mask, version, hash] of vectors) {
      const modules = pairingQrModules(texts[name], mask);
      expect(modules.length, `${name} mask ${mask}`).toBe(size(version));
      expect(digest(modules), `${name} mask ${mask}`).toBe(hash);
    }
  });

  it("the mask it picks is drawn with that mask's format bits", () => {
    // The penalty picks by itself (segno's own choice differs, which decoders do not care about); the symbol must be that mask's.
    for (const text of Object.values(texts)) {
      const picked = digest(pairingQrModules(text));
      expect([0, 1, 2, 3, 4, 5, 6, 7].map((mask) => digest(pairingQrModules(text, mask)))).toContain(picked);
    }
  });

  it("draws one path with the quiet zone", () => {
    const { size: drawn, path } = pairingQrPath(texts.short);
    expect(drawn).toBe(21 + 8);
    expect(path.startsWith("M4 4h1v1h-1z")).toBe(true);
  });
});
