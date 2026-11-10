import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { NOUS_PROMPT_MAX_CHARS } from "@space/contracts";
import { fitPrompt, fitWhole, historyLines, nameList, NOUS_RETRIEVED_NAMES_CHARS, promptSection, rankByWords, references, relevantHistory, relevantParts } from "../src/nous/retrieval.js";
import { planMapParts, PLAN_MAP_ROWS } from "../src/nous/plan-map.js";

describe("Nous retrieval (operator 31/10 16:25 BKK: relevance instead of the newest N)", () => {
  const docs = [
    { id: "a", text: "Η Hetzner έστειλε το τιμολόγιο του server" },
    { id: "b", text: "The server at Hetzner in Greece is ordered" },
    { id: "c", text: "The plan map holds the server list" },
    { id: "d", text: "Nothing about it" }
  ];
  it("ranks every entry sharing the query's words, accent-folded, rare words first, and leaves the rest out", () => {
    const ranked = rankByWords(docs, (doc) => doc.text, "Τι έγινε με το τιμολόγιο της hetzner;").map(({ doc }) => doc.id);
    expect(ranked).toEqual(["a", "b"]);
    expect(rankByWords(docs, (doc) => doc.text, "και να με")).toEqual([]);
    // No count: forty entries that match equally all come.
    expect(rankByWords(Array.from({ length: 40 }, (_, index) => `rule ${index} about Hetzner`), (doc) => doc, "hetzner")).toHaveLength(40);
  });

  it("keeps entries whole as far as the context allows and names the rest", () => {
    const items = ["x".repeat(30), "y".repeat(30), "z".repeat(30)].map((whole, index) => ({ whole, name: `n${index}` }));
    expect(fitWhole(items, "read them", 70)).toEqual(["x".repeat(30), "y".repeat(30), "- 1 more match (read them): n2"]);
    // The first entry always comes whole, however long.
    expect(fitWhole(items, "read them", 10)).toEqual(["x".repeat(30), "- 2 more matches (read them): n1; n2"]);
  });

  it("names the rest within its own budget (1/11: 610 memory matches made one 77,000-character line)", () => {
    const names = Array.from({ length: 600 }, (_, index) => `[space_memory:${index}] "a remembered entry"`);
    const line = nameList(names);
    expect(line.length).toBeLessThanOrEqual(NOUS_RETRIEVED_NAMES_CHARS + 20);
    expect(line).toMatch(/; and \d+ more$/);
    expect(nameList(["a", "b"])).toBe("a; b");
  });
});

describe("A turn's prompt within its budget (stable 1/11 05:45-07:33 UTC: 34 operator turns failed \"Invalid prompt.\")", () => {
  it("leaves the lowest-ranked parts out whole, the largest first within a rank, names each with its tool, and keeps the order", () => {
    const parts = [
      { name: "Conversation so far", text: "c".repeat(300), rank: 8 },
      { name: "Release trains", text: "t".repeat(100), rank: 3 },
      { name: "Open tasks", text: "k".repeat(400), rank: 5, readWith: "space_tasks" },
      { name: "Plan activity", text: "a".repeat(200), rank: 4 },
      { name: "Operator messages", text: "m".repeat(300), rank: null }
    ];
    const { text, left } = fitPrompt(parts, 1_200);
    expect(left.map((part) => part.name)).toEqual(["Release trains", "Plan activity", "Open tasks"]);
    expect(text.length).toBeLessThanOrEqual(1_200);
    expect(text.indexOf("c".repeat(300))).toBeLessThan(text.indexOf("m".repeat(300)));
    expect(text).toContain("- Open tasks (400 characters): space_tasks");
    expect(text).toContain("- Release trains (100 characters): space_world {\"section\": \"Release trains\"}");
    // Everything fits: nothing left out, no note.
    expect(fitPrompt(parts, 10_000)).toEqual({ text: parts.map((part) => part.text).join("\n\n"), left: [] });
  });

  it("keeps the parts that never leave whole past the budget, and cuts the largest only past the technical bound, saying so", () => {
    const keep = [{ name: "Operator messages", text: "m".repeat(500), rank: null }, { name: "Standing orders", text: "s".repeat(2_000), rank: null }];
    expect(fitPrompt(keep, 1_000, 5_000).text).toBe(`${"m".repeat(500)}\n\n${"s".repeat(2_000)}`);
    const cut = fitPrompt(keep, 1_000, 1_500).text;
    expect(cut.length).toBeLessThanOrEqual(1_500);
    expect(cut.startsWith("m".repeat(500))).toBe(true);
    expect(cut).toContain("more characters of Standing orders past the prompt's technical bound of 1,500]");
  });

  it("reads one named section whole, or names the sections there are", () => {
    const parts = [{ name: "Open tasks", text: "## Open tasks\n- one", rank: 5 }, { name: "Your notes", text: "## Your notes", rank: 6 }];
    expect(promptSection(parts, "open TASKS")).toBe("## Open tasks\n- one");
    expect(promptSection(parts, "trains")).toBe("No section of the world is named \"trains\". Its sections now: Open tasks; Your notes.");
  });

  // The host runners' own tests (scripts/tests/space-*-nous-turn.test.mjs) check the same bound: they are not in the public tree.
  it("is the bound the worker checks", () => {
    expect(readFileSync(new URL("../../worker/src/nous-turn.ts", import.meta.url), "utf8")).toContain("const MAX_PROMPT_CHARS = NOUS_PROMPT_MAX_CHARS;");
  });
});

describe("relevance for turns that do not answer the operator (token study 1/11)", () => {
  it("keeps a list's relevant entries and counts the rest, leaves a list with none, keeps other parts; no words, every part stays", () => {
    const parts = [{ name: "Head", text: "Tokens", rank: null }, { name: "Rooms", text: "## Rooms\n- Andy working", rank: 9 },
      { name: "Tasks", text: "## Open tasks\n- [task:a] Check the Hetzner backup\n- [task:b] Renew a certificate\n- [task:c] Post on X", rank: 5, readWith: "space_tasks", entries: true },
      { name: "Goals", text: "## Goals\n### Grow downloads\nStars and installs", rank: 8, entries: true }];
    const relevant = relevantParts(parts, "Andy finished the Hetzner backup");
    expect(relevant[1]).toBe(parts[1]);
    expect(relevant[2]!.text).toBe("## Open tasks\n- [task:a] Check the Hetzner backup\n- 2 other entries not about this turn: space_tasks");
    expect(relevant[3]!.rank).toBe(-1);
    expect(relevantParts(parts, "")).toEqual(parts);
    const fitted = fitPrompt(relevant);
    expect(fitted.text).toContain("- [task:a] Check the Hetzner backup");
    expect(fitted.left.map((part) => part.name)).toEqual(["Goals"]);
    expect(fitted.text).toContain("- Goals (");
  });

  it("gives the dialogue's message the turn works on first, then the matching ones in time order, and counts the rest", () => {
    const message = (id: string, kind: "OPERATOR" | "INBOX" | "ANSWER", content: string) => ({ id, ownerUserId: "u", turnId: null, kind, status: "DONE", content, meta: {}, createdAt: `2026-11-01T0${id}:00:00.000Z` }) as never;
    const messages = [message("1", "OPERATOR", "Back up Hetzner on Andy"), message("2", "INBOX", "Leo charts refreshed"), message("3", "ANSWER", "Hetzner backup started on Andy"),
      message("4", "INBOX", "Andy finished the Hetzner backup")];
    const text = relevantHistory(messages, "Andy finished the Hetzner backup", "4");
    expect(text.split("\n\n").slice(0, 3)).toEqual(["Operator: Back up Hetzner on Andy", "Nous: Hetzner backup started on Andy", "Inbox (room monitor and notifications, not the operator):\nAndy finished the Hetzner backup"]);
    expect(text).toContain("- 1 other message of the dialogue");
    expect(historyLines(messages)).toHaveLength(4);
  });

  it("keeps an earlier inbox line only when it shares a record id or ticket with the turn's text (round 2, 1/11: handled lines filled 20,000 characters)", () => {
    const message = (id: string, kind: "OPERATOR" | "INBOX" | "ANSWER", content: string) => ({ id, ownerUserId: "u", turnId: null, kind, status: "DONE", content, meta: {}, createdAt: `2026-11-01T0${id}:00:00.000Z` }) as never;
    const messages = [message("1", "OPERATOR", "Ship the Hetzner backup"), message("2", "INBOX", "Inbox (room monitor): Andy (pane:andy00001) started the Hetzner backup"),
      message("3", "INBOX", "Inbox (room monitor): Leo (pane:leo000001) finished the Hetzner charts"), message("4", "ANSWER", "Hetzner backup runs on Andy"),
      message("5", "INBOX", "Inbox (room monitor): Andy (pane:andy00001) finished the Hetzner backup; ticket q-20261101-120000-ab12 DEPLOYED")];
    const text = relevantHistory(messages, messages[4]!.content, "5");
    expect(text).toContain("started the Hetzner backup");
    expect(text).not.toContain("Hetzner charts");
    expect(text).toContain("- 1 other message of the dialogue");
    expect(references("pane:andy00001 and q-20261101-120000-ab12, not a:b")).toEqual(["pane:andy00001", "q-20261101-120000-ab12"]);
  });

  it("splits the plan map into its picture and its rows, which a relevance turn keeps by the turn's words", () => {
    const text = `## Plan map (the one picture)\nServer-wide holds: none\nUnblock first: nothing\n2 other plans wait on nothing recorded.\n${PLAN_MAP_ROWS}\n- [clipboard:aaaaaaaaaaaa] Hetzner backup: waits on Andy\n- [clipboard:bbbbbbbbbbbb] Charts: due Monday`;
    const parts = planMapParts(text, 6);
    expect(parts.map((part) => part.name)).toEqual(["Plan map", "Plan map: the plans that wait, have a date or depend on another"]);
    expect(parts[0]!.text).toContain("wait on nothing recorded.");
    expect(parts[1]).toMatchObject({ entries: true, rank: 6, text: expect.stringMatching(new RegExp(`^${PLAN_MAP_ROWS.replace(/[()]/g, "\\$&")}\n- `)) });
    const kept = relevantParts(parts, "Andy finished the Hetzner backup");
    expect(kept[1]!.text).toBe(`${PLAN_MAP_ROWS}\n- [clipboard:aaaaaaaaaaaa] Hetzner backup: waits on Andy\n- 1 other entry not about this turn: space_world {"section": "Plan map"} reads every row`);
    expect(planMapParts("## Plan map\nnothing open", 6)).toEqual([{ name: "Plan map", text: "## Plan map\nnothing open", rank: 6 }]);
  });
});
