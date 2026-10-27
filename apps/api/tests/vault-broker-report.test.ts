import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { VAULT_BROKER_BANNER, VAULT_BROKER_SOURCES, vaultBrokerReport } from "../src/vault/broker-report.js";

// The Vault broker reinstall decision shows what the operator approves (Vault review 2026-10-22, plan clipboard:HIPO0ALNjfsP step 4).
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("Vault broker report", () => {
  it("names the installed bundle's commit and hash and the sources' diff stat to HEAD; an unbannered bundle shows the sources' newest commits", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-vault-broker-report-"));
    try {
      const repo = join(root, "repo");
      await mkdir(join(repo, "src"), { recursive: true });
      const env = { ...process.env, HOME: root, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
      const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env });
      git("init", "-q");
      await writeFile(join(repo, "src/broker.ts"), "export const v = 1;\n");
      await writeFile(join(repo, "README.md"), "x\n");
      git("add", ".");
      git("commit", "-q", "-m", "first");
      const first = git("rev-parse", "--short=10", "HEAD").trim();
      await writeFile(join(repo, "src/broker.ts"), "export const v = 2;\nexport const w = 3;\n");
      await writeFile(join(repo, "README.md"), "y\n");
      git("commit", "-q", "-am", "second: the broker changed");
      const bundle = join(root, "broker.mjs");
      await writeFile(bundle, `// space-vault-broker ${first} built 2026-10-20T10:00:00.000Z\nconsole.log(1);\n`);
      expect(VAULT_BROKER_BANNER.test(await readFile(bundle, "utf8"))).toBe(true);
      const report = await vaultBrokerReport({ bundlePath: bundle, repo, sources: ["src/broker.ts"] });
      expect(report).toContain(`commit \`${first}\` (built 2026-10-20T10:00:00.000Z)`);
      expect(report).toContain(createHash("sha256").update(await readFile(bundle)).digest("hex"));
      // Only the bundle's sources count: the README change is not the broker's.
      expect(report).toMatch(/src\/broker\.ts \| 3 \+\+-/);
      expect(report).toContain("1 file changed, 2 insertions(+), 1 deletion(-)");
      expect(report).not.toContain("README.md");
      // The same sources: nothing to build.
      await writeFile(bundle, `// space-vault-broker ${git("rev-parse", "--short=10", "HEAD").trim()} built 2026-10-22T10:00:00.000Z\nconsole.log(2);\n`);
      expect(await vaultBrokerReport({ bundlePath: bundle, repo, sources: ["src/broker.ts"] })).toContain("none: the reinstall would build the same sources");
      // A bundle from before the banner: the commit is unknown, the sources' newest commits are shown instead.
      await writeFile(bundle, "console.log(1);\n");
      const unknown = await vaultBrokerReport({ bundlePath: bundle, repo, sources: ["src/broker.ts"] });
      expect(unknown).toContain("unknown commit");
      expect(unknown).toContain("second: the broker changed");
      expect(await vaultBrokerReport({ bundlePath: join(root, "missing.mjs"), repo })).toContain("none at");
      expect(await vaultBrokerReport({ bundlePath: bundle, repo: join(root, "not-a-repo"), sources: ["src/broker.ts"] })).toContain("could not be read");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lists sources that exist, including every relative import of the broker's API files", async () => {
    for (const source of VAULT_BROKER_SOURCES) expect(existsSync(resolve(repoRoot, source)), source).toBe(true);
    for (const source of VAULT_BROKER_SOURCES.filter((entry) => entry.startsWith("apps/api/src/"))) {
      // Type-only imports never reach the bundle.
      const text = (await readFile(resolve(repoRoot, source), "utf8")).split("\n").filter((line) => !/^import type /.test(line)).join("\n");
      for (const match of text.matchAll(/from "(\.[^"]+)\.js"/g)) {
        const target = relative(repoRoot, resolve(dirname(resolve(repoRoot, source)), `${match[1]}.ts`));
        expect(VAULT_BROKER_SOURCES as readonly string[], `${source} imports ${target}`).toContain(target);
      }
    }
  });
});
