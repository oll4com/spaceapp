// Shared by the route tests: the registered "METHOD /pattern" strings, as the router matches them (routeOptions.url).
// printRoutes() prints a radix tree: each line holds a segment below its parent (4 columns per level).
export function registeredRoutes(tree: string): string[] {
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
