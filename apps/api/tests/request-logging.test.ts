import { expect, it } from "vitest";
import { redactRequestUrlForLog } from "../src/request-logging.js";

it.each([
  ["/api/links?q=private-title&APIKey=private-key", "/api/links?q=%5BREDACTED%5D&APIKey=%5BREDACTED%5D"],
  ["/api/memory/search?query=private-memory&prompt=private-prompt", "/api/memory/search?query=%5BREDACTED%5D&prompt=%5BREDACTED%5D"],
  ["/api/auth/callback?accessToken=private-token&apiKey=private-key&safe=1", "/api/auth/callback?accessToken=%5BREDACTED%5D&apiKey=%5BREDACTED%5D&safe=1"],
  ["/api/clipboard-items/?q=private-prompt&source=COPY", "/api/clipboard-items/?q=%5BREDACTED%5D&source=COPY"],
  ["/api/auth/callback#access_token=private-token", "/api/auth/callback"],
  ["http://[invalid?token=private-token", "[INVALID_REQUEST_URL]"]
])("does not log secrets or private search text from %s", (input, expected) => {
  expect(redactRequestUrlForLog(input)).toBe(expected);
});


// OBS-006: the Fastify request serializer redacts query secrets, so a handler must not log a raw request URL beside it
// (harness-proxy.ts logged `path: request.url` for a WebSocket upstream error, query string included). Any logger call
// that names a request's url must go through redactRequestUrlForLog.
it("no API logger call writes a raw request url", async () => {
  const { readdirSync, readFileSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");
  const root = new URL("../src/", import.meta.url).pathname;
  const files: string[] = [];
  const walk = (dir: string) => { for (const name of readdirSync(dir)) { const path = join(dir, name); if (statSync(path).isDirectory()) walk(path); else if (path.endsWith(".ts")) files.push(path); } };
  walk(root);
  const call = /\b(?:app\.log|request\.log|req\.log|reply\.log|log|logger)\.(?:trace|debug|info|warn|error|fatal)\(([\s\S]{0,400}?)\);/g;
  const leaks: string[] = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(call)) {
      const withoutRedacted = match[1]!.replace(/redactRequestUrlForLog\([^)]*\)/g, "");
      if (/\b(?:request|req)\.(?:raw\.)?url\b|\boriginalUrl\b/.test(withoutRedacted)) leaks.push(`${file.slice(root.length)}: ${match[0].slice(0, 90).replace(/\s+/g, " ")}`);
    }
  }
  expect(leaks, "Wrap the url in redactRequestUrlForLog (apps/api/src/request-logging.ts).").toEqual([]);
});
