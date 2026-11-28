import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import seed from "../src/space-memory-seed.json" with { type: "json" };
import { createCanonicalSpaceMemoryBridge } from "../src/shared-state.js";
import { parseStarterMemorySeed, screenStarterMemory, seedStarterSpaceMemory, starterMemoryId } from "../src/space-memory-seed.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "space-memory-seed-")); roots.push(root);
  const paths = { indexPath: join(root, "space_memory.md"), monthlyPath: join(root, "space_memory_2026-11.md") };
  await writeFile(paths.indexPath, "# Space Memory\n");
  return { root, paths, bridge: createCanonicalSpaceMemoryBridge(paths) };
}
const query = { page: 1, pageSize: 500, sortOrder: "desc" as const, searchMode: "keyword" as const };
const entry = (key: string, revision: number, body: string) => ({ key, revision, title: "Getting started", body, tags: ["help"] });
const mini = (...entries: ReturnType<typeof entry>[]) => ({ schemaVersion: 1, reviewedAt: "2026-11-27T00:00:00.000Z", entries });

describe("starter Space Memory", () => {
  // Build gate (operator 27/11 hard rule): the shipped seed parses and every entry passes the privacy screen.
  it("ships a seed that passes the privacy screen", () => {
    const parsed = parseStarterMemorySeed(seed);
    expect(parsed.entries.length).toBeGreaterThan(20);
    for (const item of parsed.entries) expect(screenStarterMemory(item), item.key).toEqual([]);
  });

  it.each([
    ["an email or @", "Write to someone at help@example.org for access."],
    ["a URL, host, domain or IP", "Open https://example.org/login?token=abc to sign in."],
    ["a URL, host, domain or IP", "The server listens on 10.0.0.12 behind the router."],
    ["a URL, host, domain or IP", "Use the box at app.example.net when it is up."],
    ["a key-like string", "Paste sk-ant-api03-abcdefghijk into the field."],
    // Split so the public export audit (github-token, aws-access-key) sees no key in this file.
    ["a key-like string", "The key gh" + "p_abcdefghijklmnopqrstuvwxyz0123456789 opens the repo."],
    ["a key-like string", "Use AK" + "IAABCDEFGHIJKLMNOP for storage."],
    ["a key-like string", "Send Bearer eyJhbGciOiJIUzI1NiJ9 with each call."],
    ["a secret value", "The admin password: hunter2 works."],
    ["a phone number", "Call +30 210 123 4567 for help."],
    ["money or prices", "The plan costs €20 a month."],
    ["an internal id", "Read plan clipboard:pt2ciFXsMqVa first."],
    ["a private name", "Ask Iris to check the phone app."],
    ["a private name", "The proxmox host keeps the boxes."]
  ])("refuses %s", (reason, body) => {
    expect(screenStarterMemory({ title: "Help", body, tags: [] }).join("; ")).toContain(reason);
    expect(() => parseStarterMemorySeed(mini(entry("bad", 1, body)))).toThrow(/contains/);
  });

  it("refuses a repeated key", () => {
    expect(() => parseStarterMemorySeed(mini(entry("one", 1, "First."), entry("one", 2, "Second.")))).toThrow(/repeats/);
  });

  it("seeds once, keeps the user's own memories and adds nothing on a second run", async () => {
    const { paths, bridge } = await fixture();
    await bridge.save({ scope: "SYSTEM", title: "My own note", body: "Keep this exactly.", provenance: "test" });
    const before = await readFile(paths.monthlyPath, "utf8");
    expect(await seedStarterSpaceMemory(paths.monthlyPath, mini(entry("panes", 1, "A pane is one window of work."), entry("help", 1, "Press the help button.")))).toEqual({ added: 2 });
    expect(await seedStarterSpaceMemory(paths.monthlyPath, mini(entry("panes", 1, "A pane is one window of work."), entry("help", 1, "Press the help button.")))).toEqual({ added: 0 });
    const after = await readFile(paths.monthlyPath, "utf8");
    expect(after.startsWith(before)).toBe(true);
    const listed = await bridge.list(query);
    expect(listed.map((item) => item.title).sort()).toEqual(["Getting started", "Getting started", "My own note"]);
    expect(listed.find((item) => item.id === starterMemoryId("panes", 1))?.body).toContain("A pane is one window of work.");
  });

  it("does not add again an entry already in another month's file", async () => {
    const { root, paths } = await fixture();
    await seedStarterSpaceMemory(paths.monthlyPath, mini(entry("panes", 1, "A pane is one window of work.")));
    expect(await seedStarterSpaceMemory(join(root, "space_memory_2026-12.md"), mini(entry("panes", 1, "A pane is one window of work.")))).toEqual({ added: 0 });
  });

  it("shows only the newest revision of an entry", async () => {
    const { paths, bridge } = await fixture();
    await seedStarterSpaceMemory(paths.monthlyPath, mini(entry("panes", 1, "Old wording.")));
    expect(await seedStarterSpaceMemory(paths.monthlyPath, mini(entry("panes", 3, "New wording.")))).toEqual({ added: 1 });
    const bodies = (await bridge.list(query)).map((item) => item.body);
    expect(bodies.some((body) => body.includes("New wording."))).toBe(true);
    expect(bodies.some((body) => body.includes("Old wording."))).toBe(false);
  });
});
