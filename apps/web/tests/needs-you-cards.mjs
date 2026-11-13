// Shared by PROVE_NEEDS_YOU_TARGET (scripts/space-needs-you-target-proof.mjs) and the web tests: kept here because the public tree ships apps/web/tests, not that script.
/**
 * Runs in the page (request nous_msg:40900116): every card Needs you shows, ids and checks only, never their words. A card (a notification) must
 * read in the run's language, say its heading once and its «Τι χρειάζεται» once, each section and fact label once; a translated one carries the
 * original toggle. A card's sections and facts are read only while it is open (plan clipboard:ytwWl09xNH0Z: closed it is its title and one answer).
 * Nous's decisions only have to read in the language (their account facts are Space's own lines). Self-contained: it is sent as source.
 */
export function readNeedsYouCards(words, root = document) {
  const norm = (text) => String(text ?? "").replace(/\s+/g, " ").trim();
  const times = (text, part) => (part ? text.split(part).length - 1 : 0);
  // An element's text with its lines (a block or a <br> ends one), the same in the page and in jsdom (innerText needs a layout).
  const lines = (element, drop = "") => {
    if (!element) return "";
    const copy = element.cloneNode(true);
    if (drop) for (const node of copy.querySelectorAll(drop)) node.remove();
    for (const br of copy.querySelectorAll("br")) br.replaceWith("\n");
    for (const block of copy.querySelectorAll("p, li, div, dd, dt, h1, h2, h3, h4, h5, h6, pre, tr, header, blockquote")) block.append("\n");
    return copy.textContent;
  };
  const greek = (text) => {
    const letters = text.match(/\p{L}/gu) ?? [];
    return letters.length > 0 && letters.filter((letter) => /\p{Script=Greek}/u.test(letter)).length * 2 >= letters.length;
  };
  // What the server writes must read in the language; what it keeps as written says nothing: the value after a label in the language (a subject,
  // a list's name, a sender), quoted names, addresses, links, ids, {{placeholders}} and fingerprints (stable 1/11: campaign cards ab76acad and
  // c7269f7a, Greek labels over English values). A label in English keeps its value, so an untranslated card still fails. Under 12 letters says nothing.
  const inLanguage = (text) => {
    if (words.language !== "el") return true;
    const said = String(text ?? "").split("\n").map((line) => {
      const label = /^\s*(?:[-•*]\s*|\d+[.)]\s*)?([^:\n]{1,40}?):\s+\S/u.exec(line)?.[1];
      return label && greek(label) ? label : line;
    }).join("\n").replace(/"[^"\n]*"|“[^”\n]*”|«[^»\n]*»|\{\{[^}\n]*\}\}|`[^`\n]*`/g, " ")
      // Technical terms the translator keeps as written (stable bff6dfcb: an image tag, sha256:…, DSA-…, secfind:…, public-host, space-postgres-1, xz-utils):
      // any word holding a digit, / : @ _ or a dot or hyphen between letters (URLs, addresses, ids, hashes, hosts, paths, packages). Plain words stay.
      .split(/\s+/u).filter((token) => !/[\d/:@_]|\p{L}[.-]\p{L}/u.test(token)).join(" ");
    return (said.match(/\p{L}/gu) ?? []).length < 12 || greek(said);
  };
  const drop = ".nous-decision-actions, form, button, select, details";
  const own = (article) => norm(lines(article, drop));
  return [...root.querySelectorAll(".nous-decisions article.nous-decision")].filter((article) => article.checkVisibility?.() !== false).map((article) => {
    const text = own(article);
    if (!article.dataset.notificationId) return { id: article.dataset.decisionId ?? null, type: "decision", inLanguage: inLanguage(lines(article, drop)) };
    const facts = [...article.querySelectorAll(".ny-details section > h4, .ny-facts > dt")];
    const labels = facts.map((dt) => norm(dt.textContent));
    const factLines = (label) => lines(facts.find((dt) => norm(dt.textContent) === label)?.nextElementSibling);
    const fact = (label) => norm(factLines(label));
    const heading = norm(article.querySelector("h3")?.textContent);
    const why = fact(words.why);
    const stem = heading.replace(/[\s.…]+$/, "").slice(0, 40);
    return { id: article.dataset.notificationId, type: "card", source: norm(article.querySelector(".ny-source")?.textContent),
      inLanguage: inLanguage(`${heading}\n${factLines(words.why)}\n${factLines(words.steps)}`),
      headingOnce: stem.length < 12 || times(text, stem) === 1,
      whyOnce: labels.filter((label) => label === words.why).length <= 1 && (why.length < 12 || times(text, why.slice(0, 40)) === 1),
      factLabelsOnce: new Set(labels).size === labels.length,
      translated: [...article.querySelectorAll(".ny-translated button")].some((button) => norm(button.textContent) === words.original) };
  });
}
