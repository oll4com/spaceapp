import type { z } from "zod";

/** Business rule shared by the stored link and the create request: an HTTP link opens only in a new tab (ARCH-002). */
export function httpLinksOpenInNewTab(link: { url: string; openMode: string }, context: z.RefinementCtx): void {
  if (link.url.startsWith("http:") && link.openMode !== "NEW_TAB") {
    context.addIssue({ code: "custom", path: ["openMode"], message: "HTTP links can only open in a new tab." });
  }
}

/** A web address Space accepts: https (http too when httpAllowed) with no user name or password in it (ARCH-002). */
export function webUrlWithoutCredentials(url: URL, httpAllowed = false): boolean {
  return (url.protocol === "https:" || (httpAllowed && url.protocol === "http:")) && !url.username && !url.password;
}
