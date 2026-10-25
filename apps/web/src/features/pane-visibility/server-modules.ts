// Optional modules the server has on (review F14): a public install starts without them unless
// SPACE_OPTIONAL_MODULES enables them. A payload without the list (older server) means all are on.
export const SERVER_MODULES_EVENT = "space:server-modules-changed";
let enabled: ReadonlySet<string> | null = null;

export function noteServerModules<T>(payload: T): T {
  const list = (payload as { optionalModules?: unknown } | null)?.optionalModules;
  if (Array.isArray(list)) {
    enabled = new Set(list.filter((id): id is string => typeof id === "string"));
    if (typeof window !== "undefined") window.dispatchEvent(new Event(SERVER_MODULES_EVENT));
  }
  return payload;
}

export function serverModuleOn(id: string): boolean {
  return enabled === null || enabled.has(id);
}
