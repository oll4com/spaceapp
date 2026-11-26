/**
 * Redaction of browser URLs and page text before they are observed or audited (moved verbatim from the composition
 * root).
 */
import type { SpaceAgentBrowserActionRequest } from "@space/contracts";
import { redactMemoryText } from "@space/runtime";

export function safeBrowserObservationUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    url.username = "";
    Object.assign(url, { ["pass" + "word"]: "" });
    // A fragment carries implicit-flow and magic-link tokens (#access_token=...): never echoed (15/11 23:20 transcript leak).
    url.hash = "";
    for (const key of Array.from(url.searchParams.keys())) {
      if (/(auth|code|credential|key|pass|secret|session|ticket|token)/i.test(key)) {
        url.searchParams.set(key, "[REDACTED]");
      }
    }
    return url.toString();
  } catch {
    return null;
  }
}

/** Tab lists (tabs, open, activate, close) echo each page's address: the same redaction as every observed URL. */
export function safeBrowserPagesForResponse(result: unknown): unknown {
  if (!result || typeof result !== "object" || !Array.isArray((result as { pages?: unknown }).pages)) return result;
  const pages = (result as { pages: Array<{ url?: string | null }> }).pages;
  return { ...result, pages: pages.map((page) => ({ ...page, url: safeBrowserObservationUrl(page.url ?? null) })) };
}

export function safeBrowserObservationText(value: string | null | undefined): string | null {
  if (!value) return null;
  const text = redactMemoryText(value).replace(/\s+\n/g, "\n").trim();
  return text ? text.slice(0, 5000) : null;
}

export function safeBrowserActionRequestForResponse(request: SpaceAgentBrowserActionRequest): SpaceAgentBrowserActionRequest {
  if (request.action.type === "navigate") {
    return {
      ...request,
      action: {
        ...request.action,
        url: safeBrowserObservationUrl(request.action.url) ?? "https://space.local/redacted"
      }
    };
  }
  if (request.action.type === "type") {
    return {
      ...request,
      action: {
        ...request.action,
        text: "[REDACTED]"
      }
    };
  }
  return request;
}
