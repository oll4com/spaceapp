import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { execFile, spawn } from "../src/safe-child-process.js";

// 1.1.5 internal review (2026-10-16): about 60 API spawns set no env and inherited Space's credentials.
const printSecret = ["-e", "process.stdout.write(process.env.SPACE_SESSION_SECRET ?? 'absent')"];
const saved = process.env.SPACE_SESSION_SECRET;
afterEach(() => { if (saved === undefined) delete process.env.SPACE_SESSION_SECRET; else process.env.SPACE_SESSION_SECRET = saved; });

it("hides Space credentials from children that pass no env and keeps an explicit env", async () => {
  process.env.SPACE_SESSION_SECRET = "fixture-session-secret";
  const run = promisify(execFile);
  expect((await run(process.execPath, printSecret)).stdout).toBe("absent");
  expect((await run(process.execPath, printSecret, { timeout: 10_000 })).stdout).toBe("absent");
  expect((await run(process.execPath, printSecret, { env: { SPACE_SESSION_SECRET: "explicit" } })).stdout).toBe("explicit");
  const output = await new Promise<string>((resolve, reject) => {
    let text = "";
    const child = spawn(process.execPath, printSecret, { stdio: ["ignore", "pipe", "ignore"] });
    child.stdout?.on("data", (chunk: Buffer) => { text += chunk.toString(); });
    child.once("error", reject);
    child.once("close", () => resolve(text));
  });
  expect(output).toBe("absent");
  const callback = await new Promise<string>((resolve, reject) =>
    execFile(process.execPath, printSecret, (error, stdout) => (error ? reject(error) : resolve(String(stdout)))));
  expect(callback).toBe("absent");
});

it("keeps every API module on the safe wrapper", () => {
  const src = fileURLToPath(new URL("../src", import.meta.url));
  const files = (readdirSync(src, { recursive: true }) as string[])
    .filter((file) => file.endsWith(".ts") && !file.includes("__tests__") && !file.includes(".test.") && !file.endsWith("safe-child-process.ts"));
  const offenders = files.filter((file) => /^import \{(?!\s*type\b)[^}]*\} from "node:child_process";/m.test(readFileSync(join(src, file), "utf8")) ||
    /from "node:child_process";/.test(readFileSync(join(src, file), "utf8").replace(/^import type [^\n]*\n/gm, "")));
  expect(offenders.map((file) => relative(src, join(src, file)))).toEqual([]);
});
