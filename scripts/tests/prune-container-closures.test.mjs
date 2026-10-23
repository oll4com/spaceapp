import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildBrowserClosure,
  buildCliClosure,
  buildCoreClosure,
  parseArgs,
  removeSourceMaps,
  resolveDependencyClosure
} from "../prune-container-closures.mjs";

test("parseArgs defaults to system architecture and default closures dir", () => {
  const args = parseArgs([]);
  assert.ok(args.targetArch === "amd64" || args.targetArch === "arm64");
  assert.ok(args.outputDir.endsWith("closures"));
});

test("parseArgs honors --targetarch and --output-dir flags", () => {
  const args = parseArgs(["--targetarch", "arm64", "--output-dir", "custom-closures"]);
  assert.equal(args.targetArch, "arm64");
  assert.ok(args.outputDir.endsWith("custom-closures"));
});

test("removeSourceMaps removes .map files recursively and leaves other files intact", () => {
  const dir = mkdtempSync(join(tmpdir(), "spaceapp-test-sourcemaps-"));
  try {
    const sub = join(dir, "nested");
    mkdirSync(sub);
    writeFileSync(join(dir, "bundle.js"), "console.log(1)");
    writeFileSync(join(dir, "bundle.js.map"), "{}");
    writeFileSync(join(sub, "sub.mjs"), "export const a = 1;");
    writeFileSync(join(sub, "sub.mjs.map"), "{}");

    removeSourceMaps(dir);

    assert.equal(existsSync(join(dir, "bundle.js")), true);
    assert.equal(existsSync(join(dir, "bundle.js.map")), false);
    assert.equal(existsSync(join(sub, "sub.mjs")), true);
    assert.equal(existsSync(join(sub, "sub.mjs.map")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveDependencyClosure walks package.json dependency trees", () => {
  const nm = mkdtempSync(join(tmpdir(), "spaceapp-test-closure-"));
  try {
    const pkgA = join(nm, "pkg-a");
    const pkgB = join(nm, "pkg-b");
    const pkgC = join(nm, "pkg-c");
    mkdirSync(pkgA);
    mkdirSync(pkgB);
    mkdirSync(pkgC);

    writeFileSync(join(pkgA, "package.json"), JSON.stringify({ dependencies: { "pkg-b": "^1.0.0" } }));
    writeFileSync(join(pkgB, "package.json"), JSON.stringify({ dependencies: { "pkg-c": "^1.0.0" } }));
    writeFileSync(join(pkgC, "package.json"), JSON.stringify({ dependencies: {} }));

    const resolved = resolveDependencyClosure(nm, ["pkg-a"]);
    assert.deepEqual(Array.from(resolved).sort(), ["pkg-a", "pkg-b", "pkg-c"]);
  } finally {
    rmSync(nm, { recursive: true, force: true });
  }
});
