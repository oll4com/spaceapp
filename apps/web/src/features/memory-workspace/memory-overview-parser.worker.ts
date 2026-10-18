import { streamMemoryOverviewResponse, type MemoryOverviewParseRequest } from "./memory-overview-parser.js";

self.onmessage = (event: MessageEvent<MemoryOverviewParseRequest>) => {
  void streamMemoryOverviewResponse(event.data, message => self.postMessage(message))
    .catch(error => self.postMessage({ kind: "error", message: error instanceof Error ? error.message : "Memory response could not be parsed." }));
};
