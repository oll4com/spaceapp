import { councilEvidenceSchema, type CouncilEvidence } from "@space/contracts";
import { CODEX_LB_BASE_URL, getCodexApiKey, ProviderFailure, runWithProviderSlot } from "../asteroids-arena/providers.js";
import { extractJsonObject } from "../asteroids-arena/protocol.js";
import { buildSearchPrompt } from "./prompts.js";
import { clip } from "./ranking.js";

/** The gateway model that runs the searches with the Codex backend's built-in web_search tool (no extra cost). */
export const COUNCIL_SEARCH_MODEL = "gpt-6-astra";
const SEARCH_TIMEOUT_MS = 150_000;

/** The final message of a streamed Responses reply and its url citations (the gateway streams items; response.completed carries no output). */
export function finalMessageFromResponsesStream(stream: string): { text: string; citations: Array<{ title: string; url: string; start: number; end: number }> } {
  let message = { text: "", citations: [] as Array<{ title: string; url: string; start: number; end: number }> };
  for (const line of stream.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    try {
      const event = JSON.parse(line.slice(6)) as { type?: string; item?: { type?: string; content?: Array<{ type?: string; text?: string;
        annotations?: Array<{ type?: string; url?: string; title?: string; start_index?: number; end_index?: number }> }> } };
      if (event.type !== "response.output_item.done" || event.item?.type !== "message") continue;
      const parts = (event.item.content ?? []).filter((part) => part.type === "output_text");
      let offset = 0;
      const citations: typeof message.citations = [];
      for (const part of parts) {
        for (const note of part.annotations ?? []) {
          if (note.type === "url_citation" && note.url) citations.push({ title: note.title ?? "", url: note.url, start: offset + (note.start_index ?? 0), end: offset + (note.end_index ?? 0) });
        }
        offset += (part.text ?? "").length;
      }
      message = { text: parts.map((part) => part.text ?? "").join(""), citations };
    } catch {
      // Keep-alive and partial lines are not JSON.
    }
  }
  return message;
}

export function finalTextFromResponsesStream(stream: string): string {
  return finalMessageFromResponsesStream(stream).text;
}

const evidenceOf = (title: string, url: string, finding: string) =>
  councilEvidenceSchema.safeParse({ title: clip(title.trim(), 200), url: url.trim(), finding: clip(finding.replace(/\s+/g, " ").trim(), 400) });

/**
 * Findings the search model reported as JSON; when it answered in prose instead, its url citations with the cited
 * sentence. Only well-formed http(s) links survive.
 */
export function parseSearchFindings(text: string, citations: ReadonlyArray<{ title: string; url: string; start: number; end: number }> = []): CouncilEvidence[] {
  const json = extractJsonObject(text);
  if (json) {
    try {
      const findings = (JSON.parse(json) as { findings?: unknown }).findings;
      if (Array.isArray(findings)) {
        const parsed = findings.flatMap((raw) => {
          const item = raw as Record<string, unknown>;
          const result = evidenceOf(String(item.title ?? ""), String(item.url ?? ""), String(item.finding ?? ""));
          return result.success ? [result.data] : [];
        });
        if (parsed.length) return parsed.slice(0, 3);
      }
    } catch {
      // Fall through to the citations.
    }
  }
  const seen = new Set<string>();
  return citations.flatMap((citation) => {
    if (seen.has(citation.url)) return [];
    seen.add(citation.url);
    // The sentence that carries the citation, without the markdown link itself.
    const before = text.slice(0, citation.start);
    const sentence = text.slice(Math.max(before.lastIndexOf(". "), before.lastIndexOf("\n"), 0), citation.start).replace(/^[.\s]+/, "");
    const result = evidenceOf(citation.title || citation.url, citation.url, sentence || citation.title);
    return result.success ? [result.data] : [];
  }).slice(0, 3);
}

/** One web search through Space Gateway's /v1/responses with the web_search tool; an empty result is tried once more. */
export async function searchWebThroughGateway(query: string, question: string, signal: AbortSignal): Promise<CouncilEvidence[]> {
  const found = await searchOnce(query, question, signal);
  return found.length ? found : searchOnce(query, question, signal);
}

function searchOnce(query: string, question: string, signal: AbortSignal): Promise<CouncilEvidence[]> {
  return runWithProviderSlot("codex", async () => {
    const key = await getCodexApiKey();
    if (!key) throw new ProviderFailure("error", "The Space Gateway key is unavailable.");
    const response = await fetch(`${CODEX_LB_BASE_URL}/v1/responses`, {
      method: "POST",
      signal: AbortSignal.any([signal, AbortSignal.timeout(SEARCH_TIMEOUT_MS)]),
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: COUNCIL_SEARCH_MODEL,
        input: [{ role: "user", content: buildSearchPrompt(query, question) }],
        tools: [{ type: "web_search" }],
        reasoning: { effort: "low" },
        stream: true,
        store: false
      })
    });
    if (!response.ok) throw new ProviderFailure(response.status === 429 ? "quota" : "error", `Web search HTTP ${response.status}`);
    const message = finalMessageFromResponsesStream(await response.text());
    return parseSearchFindings(message.text, message.citations);
  }, signal);
}
