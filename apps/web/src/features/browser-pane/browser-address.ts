// Address-bar input is broader than the URL-only browser API contract.
export function resolveBrowserAddress(raw: string): string {
  const input = raw.trim();
  if (!input) throw new Error("Enter a web address or search terms.");
  if (input === "about:blank") return input;
  const host = input.split(/[/?#]/, 1)[0]!;
  const hostWithPort = /^[^\s:@]+:\d+$/.test(host) || /^\[[\da-f:]+\](?::\d+)?$/i.test(host);
  const explicitScheme = /^[a-z][a-z\d+.-]*:/i.test(input) && !hostWithPort;
  if (explicitScheme && !/^https?:/i.test(input)) {
    throw new Error("Use an http or https web address, or about:blank.");
  }
  const looksLikeHost = !/[\s@]/u.test(host) && (host.includes(".") || host === "localhost" || hostWithPort);
  if (!explicitScheme && !input.startsWith("//") && !looksLikeHost) {
    return `https://www.google.com/search?q=${encodeURIComponent(input)}`;
  }
  try {
    const url = new URL(explicitScheme ? input : input.startsWith("//") ? `https:${input}` : `https://${input}`);
    if (!url.hostname || url.username || url.password) throw new Error("Invalid address");
    return url.href;
  } catch {
    throw new Error("Enter a valid web address, such as google.com.");
  }
}
