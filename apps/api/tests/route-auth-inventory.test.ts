import { readFile } from "node:fs/promises";
import { InMemorySpaceStore } from "@space/runtime";
import { expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { getApiConfig } from "../src/config.js";
import { isCliBridgeRoutePath } from "../src/cli-bridge-paths.js";

// Review F13 (2026-10-14): every route that answers a request without a session is listed
// in fixtures/routes-without-session.json, so a new unauthenticated surface needs review. Its "<METHOD> *" entries are
// Fastify's built-in not-found handler (fastify/lib/four-oh-four.js, it answers 404, never data); the ":token*" demo
// preview routes check their own preview token (security addendum step 12 traced both).
const fixtureUrl = new URL("./fixtures/routes-without-session.json", import.meta.url);

// printRoutes() prints a radix tree: each line holds a segment below its parent (4 columns per level).
function registeredRoutes(tree: string): string[] {
  const routes = new Set<string>();
  const stack: string[] = [];
  for (const line of tree.split("\n")) {
    const match = /^([\s│├└─]*)(\S+?)(?: \(([A-Z, ]+)\))?$/.exec(line);
    if (!match || !match[2]) continue;
    const depth = match[1]!.length / 4;
    stack.length = depth;
    stack.push(match[2].split("|")[0]!);
    for (const method of match[3]?.split(", ") ?? []) {
      if (method !== "HEAD" && method !== "OPTIONS") routes.add(`${method} ${stack.join("")}`);
    }
  }
  return [...routes].sort();
}

it("answers 401 without a session on every route except the reviewed list", async () => {
  const app = await createApp({ store: new InMemorySpaceStore(), config: getApiConfig({ SPACE_LOG_LEVEL: "silent" }), auth: { sessionSecret: "route-inventory-secret", devLogin: false, secureCookies: false } });
  try {
    const open: string[] = [];
    const bridgeAnswers: string[] = [];
    for (const route of registeredRoutes(app.printRoutes({ commonPrefix: false }))) {
      const [method, path] = route.split(" ") as [string, string];
      const url = path.replace(/:[A-Za-z0-9_]+/g, "x").replace(/\*/g, "x");
      const body = method === "GET" || method === "DELETE" ? {} : { headers: { "content-type": "application/json" }, payload: "{}" };
      const response = await app.inject({ method: method as "GET", url, remoteAddress: "203.0.113.10", ...body });
      // CLI bridge routes check their own bridge token instead of a session: they must reject, but not with 401.
      if (isCliBridgeRoutePath(path)) bridgeAnswers.push(`${route} ${response.statusCode}`);
      else if (response.statusCode !== 401) open.push(route);
    }
    if (process.env.UPDATE_ROUTE_INVENTORY) console.log(JSON.stringify(open, null, 2));
    expect(open).toEqual(JSON.parse(await readFile(fixtureUrl, "utf8")));
    // The CDP status probe reports the refusal in its body ({ ready: false, reason }) and names no pane or session.
    const statusProbes = new Set(["GET /api/cli/browser/cdp/status"]);
    expect(bridgeAnswers.filter((answer) => Number(answer.split(" ").at(-1)) < 400 && !statusProbes.has(answer.split(" ").slice(0, 2).join(" ")))).toEqual([]);
  } finally {
    await app.close();
  }
}, 600_000);
