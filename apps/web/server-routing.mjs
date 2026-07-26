const readOnlyMethods = new Set(["GET", "HEAD"]);

export function localAppSecurityHeaders() {
  return {
    "content-security-policy": "base-uri 'none'; object-src 'none'; frame-ancestors 'none'",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY"
  };
}

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
