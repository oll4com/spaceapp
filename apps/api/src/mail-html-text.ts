// Plain text of an HTML-only email (CodeSignal and HackerRank invitations have no text/plain part):
// styles, scripts and comments go, block elements become line breaks, links keep their text and target,
// entities are decoded and whitespace collapses. The caller caps the length, as with plain-text parts.
const named: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", rsquo: "'", lsquo: "'", rdquo: "\"", ldquo: "\"",
  ndash: "-", mdash: "-", hellip: "...", copy: "(c)", reg: "(R)", trade: "(TM)", bull: "*", middot: "*", zwnj: "", zwj: "" };

export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const code = entity[1] === "x" || entity[1] === "X" ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return named[entity.toLowerCase()] ?? match;
  });
}

/** A text/plain part that is really an HTML document (27/10: a bank's mail reached Nous as raw tags). */
export function looksLikeHtml(text: string): boolean {
  return /^\s*<(?:!doctype html|html|head|body)\b/i.test(text) || (text.match(/<\/?(?:html|body|div|table|tr|td|p|br|span|font|center)\b[^>]*>/gi)?.length ?? 0) >= 10;
}

export function htmlToText(html: string): string {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(style|script|head|title|noscript)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a\s*>/gi, (_match, _quote: string, href: string, inner: string) => {
      const label = inner.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      const target = decodeHtmlEntities(href.trim());
      if (!/^https?:\/\//i.test(target)) return ` ${label} `;
      return label && label !== target ? ` ${label} (${target}) ` : ` ${target} `;
    })
    // Inline formatting joins its neighbours ("by <b>Oct 20</b>." stays "by Oct 20.").
    .replace(/<\/?(b|strong|i|em|u|span|font|small|big|sub|sup|mark|code|abbr)\b[^>]*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|table|section|article|header|footer|blockquote)\s*>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<[^>]+>/g, " ");
  return decodeHtmlEntities(text)
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
