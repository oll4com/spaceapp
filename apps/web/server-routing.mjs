const readOnlyMethods = new Set(["GET", "HEAD"]);

export function resolveLegacyAppRedirect(rawUrl, method) {
  const requestUrl = new URL(rawUrl ?? "/", "http://space.local");
  if (
    (requestUrl.pathname === "/app" || requestUrl.pathname === "/app/") &&
    readOnlyMethods.has(method)
  ) {
    return "/";
  }
  return null;
}
