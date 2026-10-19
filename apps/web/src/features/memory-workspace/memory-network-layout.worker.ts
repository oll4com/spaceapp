import { streamMemoryLayout } from "./memory-layout-stream.js";
import { MemoryLayoutRequestAssembler } from "./memory-layout-request.js";
import type { MemoryLayoutInput } from "./memory-layout-protocol.js";

let generation = 0;
const assembler = new MemoryLayoutRequestAssembler();
self.onmessage = (event: MessageEvent<MemoryLayoutInput>) => {
  try {
    const message = event.data;
    // Cancel a previous relaxation as soon as its replacement starts arriving.
    if (message?.kind === "layout-begin" || message?.kind === "layout") generation++;
    const request = assembler.accept(message);
    if (!request) return;
    const current = ++generation;
    void streamMemoryLayout(request, (response, transfer = []) => {
      if (current === generation) self.postMessage(response, { transfer });
    }, { isCancelled: () => current !== generation }).catch(error => {
      if (current === generation) self.postMessage({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    });
  } catch (error) {
    generation++;
    self.postMessage({ kind: "error", message: error instanceof Error ? error.message : String(error) });
  }
};
