import { expect, it } from "vitest";

it("validates iframe origin, source, pane, generation and increasing sequence before saving", async () => {
  const modulePath = "../src/features/t3code-pane/t3code-selection-channel.ts";
  const module = await import(/* @vite-ignore */ modulePath).catch(() => ({} as any));
  expect(typeof module.createT3SelectionChannel, "Parent selection channel is missing").toBe("function");
  const frame = { postMessage: () => {} }, saved: any[] = [];
  const initial = { environmentId: "env-real", projectId: "project-real", threadId: "thread-one", draftId: null };
  const generation = "75578f14-5020-4576-bfdf-0cc0831ecda4";
  const channel = module.createT3SelectionChannel({ paneId: "pane:owned123", generation, origin: "http://space.test", frameWindow: () => frame,
    selection: initial, persist: async (input: any) => { saved.push(input); }, onError: () => {} });
  const data = { version: 1, type: "selection.changed", paneId: "pane:owned123", generation, sequence: 1,
    requestId: "75578f14-5020-4576-bfdf-0cc0831ecda5", payload: { ...initial, threadId: "thread-two" } };
  const event = { origin: "http://space.test", source: frame, data };
  for (const invalid of [ { ...event, origin: "http://foreign.test" }, { ...event, source: {} },
    { ...event, data: { ...data, paneId: "pane:other123" } }, { ...event, data: { ...data, generation: "75578f14-5020-4576-bfdf-0cc0831ecda6" } },
    { ...event, data: { ...data, payload: { ...data.payload, token: "private" } } } ]) await channel.receive(invalid);
  expect(saved).toHaveLength(0);
  await channel.receive(event); await channel.receive(event);
  expect(saved).toHaveLength(1); expect(saved[0].selection.threadId).toBe("thread-two");
  channel.dispose(); await channel.receive({ ...event, data: { ...data, sequence: 2 } }); expect(saved).toHaveLength(1);
});

it("does not report navigation applied until the matching request receives an ACK", async () => {
  const modulePath = "../src/features/t3code-pane/t3code-selection-channel.ts";
  const module = await import(/* @vite-ignore */ modulePath).catch(() => ({} as any));
  expect(typeof module.createT3SelectionChannel).toBe("function");
  const sent: any[] = [], saved: any[] = [], applied: any[] = [];
  const frame = { postMessage: (message: any, target: string) => sent.push({ message, target }) };
  const selection = { environmentId: "env-real", projectId: "project-real", threadId: "thread-one", draftId: null };
  const generation = "75578f14-5020-4576-bfdf-0cc0831ecda4";
  const channel = module.createT3SelectionChannel({ paneId: "pane:owned123", generation, origin: "http://space.test", frameWindow: () => frame,
    selection, persist: async (value: any) => { saved.push(value); }, onApplied: (value: any) => applied.push(value), onError: () => {} });
  const next = { ...selection, threadId: "thread-two" }; channel.request(next);
  expect(sent[0].target).toBe("http://space.test"); expect(saved).toHaveLength(0); expect(applied).toHaveLength(0);
  const request = sent[0].message;
  await channel.receive({ origin: "http://space.test", source: frame, data: { ...request, type: "selection.applied", requestId: "75578f14-5020-4576-bfdf-0cc0831ecda9", sequence: 1 } });
  expect(applied).toHaveLength(0);
  await channel.receive({ origin: "http://space.test", source: frame, data: { ...request, type: "selection.applied", sequence: 2 } });
  expect(applied).toEqual([next]); expect(saved).toHaveLength(1); // Navigation ACK is persisted by the authorized parent.
});
