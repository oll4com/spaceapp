import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { InMemorySpaceStore } from "@space/runtime";
import { nousSettingsInputSchema } from "@space/contracts";
import { registerNous } from "../src/nous/wiring.js";

// F-lang (run-spaceapp 1.2.0 lab, 2/11): Nous answered English messages in Greek on a fresh English install. Only Settings → Language = el
// may tell Nous to write Greek; with no language set the operator's latest message decides.
const owner = "user:operator";
const GREEK_INSTRUCTION = /\b(?:in|to them in|everything they read in) Greek\b|Greek when/i;

async function turnText(settings: Record<string, unknown> | null): Promise<string> {
  const store = new InMemorySpaceStore();
  await store.createRoom({ name: "Main", initialPaneCount: 0 }, "trace:t", owner);
  if (settings) await store.updateUserSettings(owner, settings as never);
  const seen: string[] = [];
  const { app, wiring } = await nousApp(store, seen);
  await wiring.service.send(owner, "Please make a two-step plan for the health check.", { person: true });
  await wiring.service.idle(owner);
  await app.close();
  expect(seen).toHaveLength(1);
  return seen[0]!;
}

async function nousApp(store: InMemorySpaceStore, seen: string[] = []) {
  const app = Fastify();
  const wiring = registerNous(app, {
    config: { instance: "dev", publicDistribution: true }, apiBaseUrl: "http://127.0.0.1", autonomous: false, auth: { sessionSecret: "nous-language-secret-with-enough-length" },
    store, routeOptions: {}, parseBody: (schema, body) => schema.parse(body), parseQuery: (schema, query) => schema.parse(query),
    readActivity: async () => { throw new Error("No activity in this test."); }, roomTools: { execute: vi.fn() } as never, inspectPane: vi.fn() as never,
    answerCli: vi.fn() as never, releaseTrain: async () => "No release trains yet.", copilots: {},
    notifications: { raise: vi.fn(), resolve: vi.fn(async () => {}), list: async () => [], setStatus: async () => null } as never,
    runner: async (input) => { seen.push(`${input.system}\n${input.prompt}`); return { text: "Done.", isError: false }; }
  });
  await app.ready();
  return { app, wiring };
}

describe("Nous's answer language", () => {
  it("never tells an English install's Nous to write Greek, and keeps the Greek rule where Settings → Language is el", async () => {
    const english = await turnText(null);
    expect(english).not.toMatch(GREEK_INSTRUCTION);
    expect(english).not.toContain("Πρόβλεψη");
    expect(english).toContain('Write to the operator in the language of their latest message: "Please make a two-step plan');
    expect(await turnText({ agentLanguage: "en" })).not.toMatch(GREEK_INSTRUCTION);
    expect(await turnText({ agentLanguage: "el" })).toContain("The operator's language is Greek (Settings → Language). Write everything they read in Greek");
  });

  // 1.2.0 lab 4/11 (c8): `{"paneBoard":{"enabled":true}}` stored the group's other defaults with it (language el), so the lines turned Greek.
  it("keeps a public install's pane board in English when a PATCH names only one of its fields", async () => {
    const store = new InMemorySpaceStore();
    const { app, wiring } = await nousApp(store);
    await wiring.service.saveSettings(owner, nousSettingsInputSchema.parse({ paneBoard: { intervalMinutes: 10 } }));
    const saved = await wiring.service.saveSettings(owner, nousSettingsInputSchema.parse({ paneBoard: { enabled: true } }));
    await app.close();
    expect(saved.paneBoard).toMatchObject({ enabled: true, language: "en", intervalMinutes: 10 });
    expect((await store.getUserSettings(owner)).nous?.paneBoard).toMatchObject({ enabled: true, language: "en", intervalMinutes: 10 });
  });
});
