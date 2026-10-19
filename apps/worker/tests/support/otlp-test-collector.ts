import { createServer, type Server } from "node:http";

/** A span exactly as it arrives at a collector in an OTLP/HTTP JSON POST. */
export interface CollectedSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: number;
  attributes: Record<string, string | number>;
  links: { traceId: string; spanId: string; attributes: Record<string, string | number> }[];
  statusCode: number;
}

export interface FakeOtlpCollector {
  /** Base URL to configure as SPACE_OTEL_EXPORTER_OTLP_ENDPOINT. */
  url: string;
  spans: CollectedSpan[];
  rawBodies: string[];
  close: () => Promise<void>;
}

function attributeRecord(attributes: readonly { key: string; value: { stringValue?: string; intValue?: string } }[] | undefined): Record<string, string | number> {
  const record: Record<string, string | number> = {};
  for (const attribute of attributes ?? []) {
    if (attribute.value.stringValue !== undefined) record[attribute.key] = attribute.value.stringValue;
    else if (attribute.value.intValue !== undefined) record[attribute.key] = Number(attribute.value.intValue);
  }
  return record;
}

/** Local fake OTLP collector (http.createServer): no Docker, no external service. */
export async function startFakeOtlpCollector(): Promise<FakeOtlpCollector> {
  const spans: CollectedSpan[] = [];
  const rawBodies: string[] = [];
  const server: Server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/traces") {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      rawBodies.push(body);
      try {
        const payload = JSON.parse(body) as {
          resourceSpans?: {
            scopeSpans?: {
              spans?: {
                traceId: string;
                spanId: string;
                parentSpanId?: string;
                name: string;
                kind: number;
                attributes?: { key: string; value: { stringValue?: string; intValue?: string } }[];
                links?: { traceId: string; spanId: string; attributes?: { key: string; value: { stringValue?: string; intValue?: string } }[] }[];
                status?: { code?: number };
              }[];
            }[];
          }[];
        };
        for (const resourceSpan of payload.resourceSpans ?? []) {
          for (const scopeSpan of resourceSpan.scopeSpans ?? []) {
            for (const span of scopeSpan.spans ?? []) {
              spans.push({
                traceId: span.traceId,
                spanId: span.spanId,
                parentSpanId: span.parentSpanId ?? null,
                name: span.name,
                kind: span.kind,
                attributes: attributeRecord(span.attributes),
                links: (span.links ?? []).map(link => ({
                  traceId: link.traceId,
                  spanId: link.spanId,
                  attributes: attributeRecord(link.attributes)
                })),
                statusCode: span.status?.code ?? 0
              });
            }
          }
        }
        response.writeHead(200, { "content-type": "application/json" }).end("{}");
      } catch {
        response.writeHead(400).end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Collector did not bind.");
  return {
    url: `http://127.0.0.1:${address.port}`,
    spans,
    rawBodies,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}
