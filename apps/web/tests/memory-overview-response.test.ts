import { afterEach, expect, it, vi } from "vitest";
import { readMemoryOverviewResponse } from "../src/memory-overview-response.js";

class DecoderWorker {
  static instances: DecoderWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() { DecoderWorker.instances.push(this); }
  emit(data: unknown) { this.onmessage?.({ data } as MessageEvent); }
}
afterEach(() => { vi.unstubAllGlobals(); DecoderWorker.instances = []; });
async function start(signal?: AbortSignal) {
  vi.stubGlobal("Worker", DecoderWorker);
  const bytes = new TextEncoder().encode("{\"data\":{}}").buffer;
  const promise = readMemoryOverviewResponse({ arrayBuffer: async () => bytes } as Response, signal);
  await Promise.resolve();
  return { promise, bytes, worker: DecoderWorker.instances.at(-1)! };
}
it("transfers bytes for worker parsing and reassembles ordered bounded graph batches", async () => {
  const { promise, bytes, worker } = await start();
  expect(worker.postMessage).toHaveBeenCalledWith({ mode: "parse-overview", bytes }, [bytes]);
  worker.emit({ nodes: [{ id: "a" }], edges: [] });
  worker.emit({ nodes: [{ id: "b" }], edges: [{ source: "a", target: "b" }] });
  worker.emit({ payload: { data: { nodes: [], edges: [], truncated: false } } });
  expect(await promise).toEqual({ data: { nodes: [{ id: "a" }, { id: "b" }], edges: [{ source: "a", target: "b" }], truncated: false } });
  expect(worker.terminate).toHaveBeenCalledOnce();
});
it("terminates parsing on cancellation", async () => {
  const controller = new AbortController();
  const { promise, worker } = await start(controller.signal);
  const rejected = expect(promise).rejects.toMatchObject({ name: "AbortError" });
  controller.abort();
  await rejected;
  expect(worker.terminate).toHaveBeenCalledOnce();
});
it("rejects invalid payloads and worker failures instead of hanging the loader", async () => {
  const first = await start();
  first.worker.emit({ error: "Memory overview response could not be decoded." });
  await expect(first.promise).rejects.toThrow("could not be decoded");
  const second = await start();
  second.worker.onerror?.();
  await expect(second.promise).rejects.toThrow("could not be decoded");
  expect(first.worker.terminate).toHaveBeenCalledOnce();
  expect(second.worker.terminate).toHaveBeenCalledOnce();
});
