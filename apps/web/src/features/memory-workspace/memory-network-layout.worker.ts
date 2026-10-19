import { layoutMemoryNetwork } from "./memory-network-layout.js";
import { runSceneJob, type WorkerMessage, type WorkerRequest } from "./memory-layout-stream.js";

const cancelled = new Set<number>();
const post = (message: WorkerMessage, transfer: ArrayBuffer[]) => self.postMessage(message, { transfer });
// MessageChannel yields without the 4 ms clamp setTimeout gets after a few nested calls, and lets "cancel" messages in.
const channel = new MessageChannel();
const yieldToEvents = () => new Promise<void>(resolve => { channel.port1.onmessage = () => resolve(); channel.port2.postMessage(0); });

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  if (request.type === "cancel") { cancelled.add(request.id); return; }
  if (request.type === "layout2d") {
    post({ type: "layout2d", id: request.id, positions: [...layoutMemoryNetwork(request.nodes, request.edges)] }, []);
    return;
  }
  void runSceneJob(request.id, request.source, { now: () => performance.now(), yieldToEvents, isCancelled: () => cancelled.has(request.id), post });
};
