import { expect, it, vi } from "vitest";
import { createTerminalReplayWriteQueue } from "../src/features/terminal-pane/TerminalPane.js";

it("batches initial replay while preserving every byte and completion", async () => {
  const write = vi.fn(async (_data: string, _mode: string) => {});
  const queue = createTerminalReplayWriteQueue(write, async () => {}, () => false, true);
  const frames = Array.from({ length: 230 }, (_, i) => `frame:${i} ελληνικά\r\n`);
  const completed = vi.fn();
  const pending = frames.map(frame => queue.enqueue(frame, "PREFILL").then(completed));
  await queue.drain();
  await Promise.all(pending);
  expect(write).toHaveBeenCalledTimes(8);
  expect(write.mock.calls.map(call => call[0]).join("")).toBe(frames.join(""));
  expect(completed).toHaveBeenCalledTimes(230);
});

it("never combines replay across live frames or changes live write modes", async () => {
  const writes: Array<[string, string]> = [];
  const queue = createTerminalReplayWriteQueue(async (data, mode) => { writes.push([data, mode]); }, async () => {}, () => false, true);
  queue.enqueue("\u001b[", "PREFILL");
  queue.enqueue("31mGreek α", "PREFILL");
  queue.enqueue("live", "VISIBLE");
  queue.enqueue("tail", "PREFILL");
  await queue.drain();
  expect(writes).toEqual([["\u001b[31mGreek α", "PREFILL"], ["live", "VISIBLE"], ["tail", "PREFILL"]]);
});

it("bounds batch bytes using UTF-8 and leaves visible-stage scheduling unchanged", async () => {
  const writes: string[] = [];
  let buffered = false;
  const yielding = vi.fn(async () => {});
  const queue = createTerminalReplayWriteQueue(async data => { writes.push(data); }, yielding, () => buffered, true);
  const frame = "α".repeat(20000);
  queue.enqueue(frame, "PREFILL"); queue.enqueue(frame, "PREFILL");
  await queue.drain();
  expect(writes).toEqual([frame, frame]);
  expect(yielding).not.toHaveBeenCalled();
  buffered = true;
  queue.enqueue("one", "PREFILL"); queue.enqueue("two", "PREFILL");
  await queue.drain();
  expect(writes.slice(2)).toEqual(["one", "two"]);
  expect(yielding).toHaveBeenCalledTimes(2);
});

it("does not write a queued batch after disposal", async () => {
  const write = vi.fn(async (_data: string, _mode: string) => {});
  const queue = createTerminalReplayWriteQueue(write, async () => {}, () => false, true);
  queue.enqueue("a", "PREFILL"); queue.enqueue("b", "PREFILL");
  queue.dispose();
  await queue.drain();
  expect(write).not.toHaveBeenCalled();
});

it("rejects every frame in a failed batch and drain", async () => {
  const error = new Error("write failed");
  const queue = createTerminalReplayWriteQueue(async () => { throw error; }, async () => {}, () => false, true);
  const pending = [queue.enqueue("a", "PREFILL"), queue.enqueue("b", "PREFILL"), queue.drain()];
  const results = await Promise.allSettled(pending);
  expect(results.every(result => result.status === "rejected" && result.reason === error)).toBe(true);
});
