import sanitizeHtml from "sanitize-html";

// Mail HTML for the reader: structure and text only, no scripts, forms or external resources. Remote
// images stay blocked until the operator asks for them; inline `cid:` images point at the attachment route.
export function sanitizeMailHtml(unsafeHtml: string, options: { loadImages: boolean; cidUrl(contentId: string): string | null }): { html: string; blockedImages: boolean } {
  let blockedImages = false;
  const html = sanitizeHtml(unsafeHtml, {
    allowedTags: ["a", "abbr", "b", "blockquote", "br", "caption", "center", "code", "div", "em", "font", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "li",
      "ol", "p", "pre", "s", "small", "span", "strong", "sub", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "u", "ul"],
    allowedAttributes: {
      a: ["href", "title", "target", "rel"], img: ["src", "alt", "title", "width", "height", "data-blocked-src"], font: ["color", "face", "size"], td: ["colspan", "rowspan", "align", "valign", "width"],
      th: ["colspan", "rowspan", "align", "valign", "width"], table: ["width", "cellpadding", "cellspacing", "border", "align"], "*": ["style", "dir"]
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: { img: ["https", "http", "data"] },
    allowedStyles: {
      "*": {
        color: [/^[a-z]+$/i, /^#[0-9a-f]{3,8}$/i, /^rgba?\([\d\s,.%]+\)$/i],
        "background-color": [/^[a-z]+$/i, /^#[0-9a-f]{3,8}$/i, /^rgba?\([\d\s,.%]+\)$/i],
        "font-size": [/^\d+(?:\.\d+)?(?:px|pt|em|rem|%)$/], "font-weight": [/^(?:bold|normal|\d{3})$/], "font-style": [/^(?:italic|normal)$/],
        "text-align": [/^(?:left|right|center|justify)$/], "text-decoration": [/^(?:underline|line-through|none)$/],
        margin: [/^[\d\s.px%auto-]+$/], padding: [/^[\d\s.px%-]+$/], width: [/^\d+(?:px|%)$/], "max-width": [/^\d+(?:px|%)$/], "line-height": [/^[\d.]+(?:px|em|%)?$/]
      }
    },
    disallowedTagsMode: "discard",
    transformTags: {
      a: (tagName, attribs) => ({ tagName, attribs: { ...attribs, target: "_blank", rel: "noopener noreferrer nofollow" } }),
      img: (tagName, attribs) => {
        const src = attribs.src ?? "";
        if (/^cid:/i.test(src)) {
          const url = options.cidUrl(src.slice(4).replace(/^<|>$/g, ""));
          return { tagName, attribs: url ? { ...attribs, src: url } : { alt: attribs.alt ?? "" } };
        }
        if (/^https?:/i.test(src) && !options.loadImages) {
          blockedImages = true;
          return { tagName, attribs: { ...attribs, src: "", "data-blocked-src": src } };
        }
        return { tagName, attribs };
      }
    },
    exclusiveFilter: (frame) => frame.tag === "img" && ((Number(frame.attribs.width) || 0) === 1 || (Number(frame.attribs.height) || 0) === 1)
  });
  return { html, blockedImages };
}
