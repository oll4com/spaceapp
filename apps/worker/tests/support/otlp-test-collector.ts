import http from "node:http";
import type { AddressInfo } from "node:net";

export interface CollectedOtlpLink {
  traceId: string;
  spanId: string;
  attributes?: Record<string, string | number>;
}

export interface CollectedOtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Record<string, string | number>;
  status?: { code?: number; message?: string };
  links?: CollectedOtlpLink[];
  serviceName?: string;
  scopeName?: string;
}

export interface OtlpTestCollector {
  readonly server: http.Server;
  readonly endpoint: string;
  readonly port: number;
  readonly spans: CollectedOtlpSpan[];
  readonly rawRequests: Array<{ url?: string; method?: string; body: unknown }>;
  clear(): void;
  waitForSpans(count: number, timeoutMs?: number): Promise<CollectedOtlpSpan[]>;
  close(): Promise<void>;
}

function decodeAttributeValue(val: unknown): string | number {
  if (!val || typeof val !== "object") return "";
  const v = val as { stringValue?: string; intValue?: string | number; doubleValue?: number };
  if (typeof v.stringValue === "string") return v.stringValue;
  if (v.intValue !== undefined) return Number(v.intValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  return "";
}

function decodeAttributes(raw: unknown): Record<string, string | number> {
  const result: Record<string, string | number> = {};
  if (!Array.isArray(raw)) return result;
  for (const item of raw) {
    if (item && typeof item === "object" && typeof item.key === "string") {
      result[item.key] = decodeAttributeValue(item.value);
    }
  }
  return result;
}

export async function startOtlpTestCollector(): Promise<OtlpTestCollector> {
  const spans: CollectedOtlpSpan[] = [];
  const rawRequests: Array<{ url?: string; method?: string; body: unknown }> = [];
  const waiters: Array<() => void> = [];

  const notifyWaiters = () => {
    for (const waiter of [...waiters]) waiter();
  };

  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || (req.url !== "/v1/traces" && req.url !== "/v1/traces/")) {
      res.writeHead(404);
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const bodyStr = Buffer.concat(chunks).toString("utf8");
        const body = JSON.parse(bodyStr);
        rawRequests.push({ url: req.url, method: req.method, body });

        const resourceSpans = Array.isArray(body?.resourceSpans) ? body.resourceSpans : [];
        for (const rSpan of resourceSpans) {
          const serviceNameAttr = Array.isArray(rSpan?.resource?.attributes)
            ? rSpan.resource.attributes.find((a: { key?: string }) => a?.key === "service.name")
            : undefined;
          const serviceName = serviceNameAttr?.value?.stringValue;

          const scopeSpans = Array.isArray(rSpan?.scopeSpans) ? rSpan.scopeSpans : [];
          for (const sSpan of scopeSpans) {
            const scopeName = sSpan?.scope?.name;
            const rawSpans = Array.isArray(sSpan?.spans) ? sSpan.spans : [];
            for (const sp of rawSpans) {
              const links: CollectedOtlpLink[] | undefined = Array.isArray(sp.links)
                ? sp.links.map((link: { traceId: string; spanId: string; attributes?: unknown }) => ({
                    traceId: link.traceId,
                    spanId: link.spanId,
                    attributes: decodeAttributes(link.attributes)
                  }))
                : undefined;

              spans.push({
                traceId: sp.traceId,
                spanId: sp.spanId,
                parentSpanId: sp.parentSpanId,
                name: sp.name,
                kind: sp.kind,
                startTimeUnixNano: sp.startTimeUnixNano,
                endTimeUnixNano: sp.endTimeUnixNano,
                attributes: decodeAttributes(sp.attributes),
                status: sp.status,
                links,
                serviceName,
                scopeName
              });
            }
          }
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({}));
        notifyWaiters();
      } catch {
        res.writeHead(400);
        res.end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });

  const address = server.address() as AddressInfo;
  const port = address.port;
  const endpoint = `http://127.0.0.1:${port}`;

  return {
    server,
    endpoint,
    port,
    spans,
    rawRequests,
    clear() {
      spans.length = 0;
      rawRequests.length = 0;
    },
    async waitForSpans(count: number, timeoutMs = 5000): Promise<CollectedOtlpSpan[]> {
      if (spans.length >= count) return spans;
      return new Promise<CollectedOtlpSpan[]>((resolve, reject) => {
        let timer: NodeJS.Timeout | null = null;
        const check = () => {
          if (spans.length >= count) {
            if (timer) clearTimeout(timer);
            const idx = waiters.indexOf(check);
            if (idx >= 0) waiters.splice(idx, 1);
            resolve(spans);
          }
        };
        waiters.push(check);
        timer = setTimeout(() => {
          const idx = waiters.indexOf(check);
          if (idx >= 0) waiters.splice(idx, 1);
          reject(new Error(`Timed out waiting for ${count} spans. Received ${spans.length} spans so far.`));
        }, timeoutMs);
      });
    },
    async close(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}
