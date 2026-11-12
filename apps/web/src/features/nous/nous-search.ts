// Find in the Nous conversation (operator nous_msg:a44eacc4): what the list shows, ignoring case and Greek accents, as the house fold does.
const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/ς/g, "σ");

/** Every place the query appears in the text the list shows, in reading order. Text in a closed fold (a run of steps) is skipped. */
export function findConversationText(root: HTMLElement, query: string): Range[] {
  const needle = fold(query.trim());
  if (!needle) return [];
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => node.parentElement?.closest("details:not([open]) > :not(summary)") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent ?? "";
    // Fold one code unit at a time so each folded position still names its place in the original text.
    let folded = "";
    const origin: number[] = [];
    for (let index = 0; index < text.length; index += 1) {
      const part = fold(text[index]!);
      folded += part;
      for (let count = 0; count < part.length; count += 1) origin.push(index);
    }
    for (let at = folded.indexOf(needle); at >= 0; at = folded.indexOf(needle, at + needle.length)) {
      const range = document.createRange();
      range.setStart(node, origin[at]!);
      range.setEnd(node, origin[at + needle.length - 1]! + 1);
      ranges.push(range);
    }
  }
  return ranges;
}

/** Paints every match and the current one (CSS Custom Highlight API: the messages' DOM is left as React made it). */
export function paintConversationMatches(ranges: Range[], current: number) {
  // shortcut: no highlight colours where the browser lacks CSS.highlights (Chrome 105+, Safari 17.2+, Firefox 140+); scrolling and the count still work.
  const registry = typeof CSS !== "undefined" ? CSS.highlights : undefined;
  if (!registry || typeof Highlight === "undefined") return;
  registry.set("nous-search", new Highlight(...ranges));
  const now = ranges[current];
  if (now) registry.set("nous-search-current", new Highlight(now)); else registry.delete("nous-search-current");
}

export function clearConversationMatches() {
  if (typeof CSS === "undefined" || !CSS.highlights) return;
  CSS.highlights.delete("nous-search");
  CSS.highlights.delete("nous-search-current");
}
