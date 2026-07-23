const MAX_CLIPBOARD_HTML_CHARS = 1_000_000;
const MAX_CLIPBOARD_IMAGE_DATA_URL_CHARS = 1_000_000;
const MAX_CLIPBOARD_HTML_IMAGES = 20;
const IMAGE_DATA_URL_PREFIXES = [
  "data:image/png;base64,",
  "data:image/jpeg;base64,",
  "data:image/webp;base64,"
] as const;

export function extractClipboardImageDataUrls(html: string): string[] {
  if (!html || html.length > MAX_CLIPBOARD_HTML_CHARS) return [];

  const dataUrls: string[] = [];
  let cursor = 0;
  while (cursor < html.length && dataUrls.length < MAX_CLIPBOARD_HTML_IMAGES) {
    if (html[cursor] !== "<" || !startsWithAsciiIgnoreCase(html, cursor + 1, "img")) {
      cursor += 1;
      continue;
    }

    const nameEnd = cursor + 4;
    if (nameEnd < html.length && !isTagBoundary(html[nameEnd] ?? "")) {
      cursor += 1;
      continue;
    }

    cursor = nameEnd;
    let src: string | null = null;
    while (cursor < html.length) {
      cursor = skipAsciiWhitespace(html, cursor);
      if (cursor >= html.length || html[cursor] === ">") {
        cursor += 1;
        break;
      }
      if (html[cursor] === "/" && html[cursor + 1] === ">") {
        cursor += 2;
        break;
      }

      const attributeStart = cursor;
      while (cursor < html.length && isAttributeNameCharacter(html[cursor] ?? "")) {
        cursor += 1;
      }
      if (cursor === attributeStart) {
        cursor += 1;
        continue;
      }

      const attributeName = html.slice(attributeStart, cursor).toLowerCase();
      cursor = skipAsciiWhitespace(html, cursor);
      if (html[cursor] !== "=") continue;
      cursor = skipAsciiWhitespace(html, cursor + 1);

      const quote = html[cursor] === "\"" || html[cursor] === "'" ? html[cursor] : null;
      if (quote) cursor += 1;
      const valueStart = cursor;
      while (
        cursor < html.length &&
        (quote ? html[cursor] !== quote : !isUnquotedAttributeBoundary(html[cursor] ?? ""))
      ) {
        cursor += 1;
      }
      const value = html.slice(valueStart, cursor);
      if (quote && html[cursor] === quote) cursor += 1;

      if (attributeName === "src" && src === null && isSupportedImageDataUrl(value)) {
        src = value;
      }
    }

    if (src) dataUrls.push(src);
  }
  return dataUrls;
}

function isSupportedImageDataUrl(value: string): boolean {
  if (!value || value.length > MAX_CLIPBOARD_IMAGE_DATA_URL_CHARS) return false;
  const prefix = value.slice(0, 32).toLowerCase();
  return IMAGE_DATA_URL_PREFIXES.some((candidate) => prefix.startsWith(candidate));
}

function startsWithAsciiIgnoreCase(input: string, start: number, expected: string): boolean {
  if (start + expected.length > input.length) return false;
  for (let offset = 0; offset < expected.length; offset += 1) {
    if ((input[start + offset] ?? "").toLowerCase() !== expected[offset]) return false;
  }
  return true;
}

function skipAsciiWhitespace(input: string, start: number): number {
  let cursor = start;
  while (cursor < input.length && isAsciiWhitespace(input[cursor] ?? "")) cursor += 1;
  return cursor;
}

function isAsciiWhitespace(character: string): boolean {
  return character === " " || character === "\t" || character === "\n" || character === "\r" || character === "\f";
}

function isTagBoundary(character: string): boolean {
  return character === "" || character === ">" || character === "/" || isAsciiWhitespace(character);
}

function isAttributeNameCharacter(character: string): boolean {
  if (character === ":" || character === "_" || character === "-") return true;
  const code = character.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122)
  );
}

function isUnquotedAttributeBoundary(character: string): boolean {
  return character === "" || character === ">" || character === "/" || isAsciiWhitespace(character);
}
