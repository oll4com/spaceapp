export type EntryRoute = "public-site" | "demo" | "app";

/** The public site lives in the spaceapp.dev repository; Space only redirects to it. */
export const PUBLIC_SITE_URL = "https://spaceapp.dev/";
const publicHomepageHostname = "spaceapp.dev";

export function resolveEntryRoute(pathname: string, hostname: string): EntryRoute {
  const normalized = pathname.replace(/\/+$/, "") || "/";
  const normalizedHostname = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (normalized === "/demo-workspace") return "demo";
  const isPublicRoot = normalized === "/" && normalizedHostname === publicHomepageHostname;
  return isPublicRoot || normalized === "/homepage" ? "public-site" : "app";
}
