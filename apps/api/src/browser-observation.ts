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
    for (const key of Array.from(url.searchParams.keys())) {
      if (/(auth|credential|key|pass|secret|session|token)/i.test(key)) {
        url.searchParams.set(key, "[REDACTED]");
      }
    }
    return url.toString();
  } catch {
    return null;
  }
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
