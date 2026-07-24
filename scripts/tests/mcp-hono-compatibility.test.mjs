import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

test("reviewed Hono override completes an MCP initialize handshake", async () => {
  const mcp = new McpServer({ name: "spaceapp-security-test", version: "0.1.4" });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined
  });
  await mcp.connect(transport);

  const server = createServer((request, response) => {
    transport.handleRequest(request, response).catch((error) => {
      response.destroy(error);
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "spaceapp-security-test", version: "0.1.4" }
        }
      }),
      signal: AbortSignal.timeout(5_000)
    });
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(body, /spaceapp-security-test/);
    assert.match(body, /protocolVersion/);
  } finally {
    await transport.close();
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});
