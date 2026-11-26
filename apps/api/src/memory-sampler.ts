import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { getHeapSpaceStatistics } from "node:v8";

const MB = 2 ** 20;
const mb = (bytes: number) => Math.round(bytes / MB);

/**
 * `api.memory` every 30 s: process.memoryUsage() and V8's heap spaces in MB. When heapUsed grows by more than `jumpMb` since the
 * previous sample, the line also names the requests still in flight (method, path without its query, declared body size, age),
 * no contents: API audit 16/11, 904 -> 1,523 MB in 64 s before the 15/11 08:40 UTC heap-limit abort with no evidence of what grew it.
 */
export function sampleApiMemory(
  log: { info: (fields: object, message: string) => void },
  server: Pick<Server, "on" | "off">,
  { intervalMs = 30_000, jumpMb = 300, memoryUsage = () => process.memoryUsage() }: { intervalMs?: number; jumpMb?: number; memoryUsage?: () => NodeJS.MemoryUsage } = {}
): () => void {
  const inFlight = new Map<IncomingMessage, number>();
  const track = (request: IncomingMessage, response: ServerResponse) => {
    inFlight.set(request, Date.now());
    response.once("close", () => inFlight.delete(request));
  };
  server.on("request", track);
  let previousHeapUsed = memoryUsage().heapUsed;
  const timer = setInterval(() => {
    const memory = memoryUsage();
    const jumped = memory.heapUsed - previousHeapUsed > jumpMb * MB;
    previousHeapUsed = memory.heapUsed;
    const now = Date.now();
    log.info({
      event: "api.memory",
      rssMb: mb(memory.rss),
      heapTotalMb: mb(memory.heapTotal),
      heapUsedMb: mb(memory.heapUsed),
      externalMb: mb(memory.external),
      arrayBuffersMb: mb(memory.arrayBuffers),
      heapSpacesUsedMb: Object.fromEntries(getHeapSpaceStatistics().map((space) => [space.space_name, mb(space.space_used_size)])),
      ...(jumped ? {
        heapJump: true,
        inFlight: [...inFlight].map(([request, startedAt]) => ({
          method: request.method,
          path: (request.url ?? "").split("?")[0],
          bodyBytes: Number(request.headers["content-length"]) || null,
          ageMs: now - startedAt
        }))
      } : {})
    }, jumped ? "API heap jumped" : "API memory");
  }, intervalMs);
  timer.unref();
  return () => {
    clearInterval(timer);
    server.off("request", track);
  };
}
