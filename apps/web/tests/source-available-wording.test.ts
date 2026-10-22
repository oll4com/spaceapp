import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// SpaceApp is MIT from 1.1.7 (operator decision 2026-10-19); the UI must not call it source-available or BSL any more.
const webRoot = join(import.meta.dirname, "..");
function textFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "downloads" ? [] : textFiles(path);
    return /\.(?:tsx?|svg|html|json|css)$/.test(entry.name) ? [path] : [];
  });
}

describe("licence wording in the web app", () => {
  it("never calls SpaceApp source-available or BSL", () => {
    const offenders = [...textFiles(join(webRoot, "src")), ...textFiles(join(webRoot, "public"))]
      .filter((file) => /source[\s_-]?available|Business Source License|BUSL-1\.1/i.test(readFileSync(file, "utf8")))
      .map((file) => relative(webRoot, file));
    expect(offenders).toEqual([]);
  });
});
