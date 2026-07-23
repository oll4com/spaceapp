export type EntryRoute = "homepage" | "demo" | "app";

const publicHomepageHostname = "spaceapp.dev";

export function resolveEntryRoute(pathname: string, hostname: string): EntryRoute {
  const normalized = pathname.replace(/\/+$/, "") || "/";
  const normalizedHostname = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (normalized === "/demo-workspace") return "demo";
  const isPublicRoot = normalized === "/" && normalizedHostname === publicHomepageHostname;
  return isPublicRoot || normalized === "/homepage" ? "homepage" : "app";
}
