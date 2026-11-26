import sanitizeHtml from "sanitize-html";

// Campaign template HTML is SENT to customers, so it is cleaned when it is saved (what is approved is what goes out): e-mail-safe
// structure and inline styles only; no scripts, forms, frames, embeds, event handlers, external CSS or fonts; links https or mailto;
// images https only (a tracking pixel 1x1 is dropped). Styles keep their declarations except ones that load or run anything.
const UNSAFE_STYLE = /expression\s*\(|javascript:|behavior\s*:|-moz-binding|@import|url\s*\(\s*(?!['"]?https:)/i;

function cleanStyle(style: string): string {
  return style.split(";").map((declaration) => declaration.trim()).filter((declaration) => declaration && /^[a-z-]+\s*:/i.test(declaration) && !UNSAFE_STYLE.test(declaration)).join("; ");
}

// Gmail's Promotions annotations (schema.org JSON-LD in <head>) are data, not code: each block is parsed and written back as JSON with
// every "<" escaped, so nothing in it can close the tag; a block that does not parse is dropped.
const JSON_LD = /<script\b[^>]*\btype\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script\s*>/gi;
function jsonLdBlocks(html: string): string[] {
  const head = /<head\b[^>]*>([\s\S]*?)<\/head\s*>/i.exec(html)?.[1] ?? "";
  return [...head.matchAll(JSON_LD)].flatMap(([, body]) => {
    try { return [`<script type="application/ld+json">${JSON.stringify(JSON.parse(body!)).replace(/</g, "\\u003c")}</script>`]; } catch { return []; }
  });
}

export function sanitizeTemplateHtml(unsafeHtml: string): string {
  const ld = jsonLdBlocks(unsafeHtml);
  const clean = sanitizeHtmlBody(unsafeHtml);
  return ld.length && /<\/head>/i.test(clean) ? clean.replace(/<\/head>/i, () => `${ld.join("")}</head>`) : clean;
}

function sanitizeHtmlBody(unsafeHtml: string): string {
  return sanitizeHtml(unsafeHtml, {
    allowedTags: ["a", "b", "blockquote", "br", "caption", "center", "div", "em", "font", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "li", "ol", "p", "pre", "s",
      "small", "span", "strong", "sub", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "u", "ul", "html", "head", "body", "meta", "title"],
    allowedAttributes: {
      a: ["href", "title", "target", "name"], img: ["src", "alt", "title", "width", "height", "border"], font: ["color", "face", "size"],
      td: ["colspan", "rowspan", "align", "valign", "width", "height", "bgcolor"], th: ["colspan", "rowspan", "align", "valign", "width", "height", "bgcolor"],
      table: ["width", "cellpadding", "cellspacing", "border", "align", "bgcolor", "role"], tr: ["align", "valign", "bgcolor"], meta: ["charset", "name", "content"],
      body: ["bgcolor"], "*": ["style", "dir", "lang", "align", "class"]
    },
    allowedSchemes: ["https", "mailto"],
    allowedSchemesByTag: { img: ["https"] },
    allowProtocolRelative: false,
    disallowedTagsMode: "discard",
    transformTags: {
      "*": (tagName, attribs) => attribs.style === undefined ? { tagName, attribs } : { tagName, attribs: { ...attribs, style: cleanStyle(attribs.style) } },
      a: (tagName, attribs) => ({ tagName, attribs: { ...attribs, ...(attribs.style === undefined ? {} : { style: cleanStyle(attribs.style) }), target: "_blank" } })
    },
    exclusiveFilter: (frame) => frame.tag === "img" && (!frame.attribs.src || (Number(frame.attribs.width) || 0) <= 1 && (Number(frame.attribs.height) || 0) <= 1 && (frame.attribs.width !== undefined || frame.attribs.height !== undefined))
  });
}
