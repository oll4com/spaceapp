/**
 * Main-content extraction from HTML pages in tool output (a fetched web page, a scraper result), after Headroom 0.37's
 * `html_extractor.py` (Apache-2.0, Headroom Contributors). Headroom uses trafilatura; this keeps its contract without
 * it: scripts, styles, comments and page chrome (navigation, footer, sidebar, forms) go, the title, headings, lists,
 * paragraphs and link targets stay, as plain text. It is lossy, so the engine runs it only when lossy transforms are
 * allowed (Token profile, never a file read). Null when nothing worth keeping was found: the page passes through.
 */
const DROPPED_ELEMENTS = /<(script|style|noscript|svg|template|iframe|object|canvas|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const CHROME_ELEMENTS = /<(nav|footer|aside|form)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const COMMENTS = /<!--[\s\S]*?-->/g;
const TITLE = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i;
const MIN_TEXT_CHARS = 50;

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…",
  copy: "©", reg: "®", laquo: "«", raquo: "»", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", middot: "·", bull: "•" };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[name.toLowerCase()] ?? match;
  });
}

/** The inner HTML of the first element named `tag`, or null. */
function inner(html: string, tag: string): string | null {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, "i").exec(html);
  return match ? match[1]! : null;
}

function textOf(html: string): string {
  return html
    .replace(/<a\b[^>]*\bhref\s*=\s*["']?(https?:\/\/[^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/a\s*>/gi, (_match, href: string, label: string) => {
      const text = label.replace(/<[^>]+>/g, "").trim();
      return text && decodeEntities(text) !== href ? `${text} (${href})` : href;
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<h([1-6])\b[^>]*>/gi, (_match, level: string) => `\n${"#".repeat(Number(level))} `)
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(p|div|section|article|main|header|h[1-6]|li|ul|ol|tr|table|pre|blockquote|dd|dt|figure|figcaption)\s*>/gi, "\n")
    .replace(/<(td|th)\b[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, "");
}

function tidy(text: string): string {
  const lines = decodeEntities(text).split("\n").map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim());
  const out: string[] = [];
  for (const line of lines) {
    if (line === "" && (out.length === 0 || out[out.length - 1] === "")) continue;
    out.push(line);
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  return out.join("\n");
}

export function extractHtml(html: string): string | null {
  const titleMatch = TITLE.exec(html);
  const title = titleMatch ? tidy(titleMatch[1]!.replace(/<[^>]+>/g, "")) : "";
  const cleaned = html.replace(COMMENTS, "").replace(DROPPED_ELEMENTS, "");
  // The page's own main content when it marks one; otherwise the body without its chrome.
  const main = inner(cleaned, "main") ?? inner(cleaned, "article");
  const region = (main && tidy(textOf(main)).length >= MIN_TEXT_CHARS ? main : inner(cleaned, "body") ?? cleaned).replace(CHROME_ELEMENTS, "");
  const body = tidy(textOf(region));
  if (body.length < MIN_TEXT_CHARS) return null;
  return title && !body.startsWith(title) && !body.startsWith(`# ${title}`) ? `Title: ${title}\n\n${body}` : body;
}
