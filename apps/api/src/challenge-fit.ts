/**
 * Teleport (operator 14/11 nous_msg:f93235c0, «Κόβεται δεξιά»): reCAPTCHA opens its 400 px image challenge beside the checkbox,
 * past a phone's right edge, so its Verify button was off the page. On a mobile page this moves an open challenge left until it
 * fits (to the page's left edge at most). It runs in its own isolated world: the page sees no global, only the challenge's new left.
 */
export function challengeFitScript(): string {
  return `(() => {
  const found = new WeakSet();
  const fit = (box) => {
    const rect = box.getBoundingClientRect();
    const shift = Math.min(rect.right - document.documentElement.clientWidth, rect.left);
    if (shift > 0.5) box.style.left = parseFloat(getComputedStyle(box).left) - shift + "px";
  };
  // reCAPTCHA places its challenge again (open, resize, scroll) by rewriting the box's style: each time it is fitted again.
  const placed = new MutationObserver((records) => { for (const record of records) fit(record.target); });
  const find = () => {
    for (const frame of document.getElementsByTagName("iframe")) {
      if (found.has(frame) || !/\\/recaptcha\\/(api2|enterprise)\\/bframe/.test(frame.src)) continue;
      let box = frame.parentElement;
      while (box && getComputedStyle(box).position !== "absolute") box = box.parentElement;
      if (!box) continue;
      found.add(frame);
      placed.observe(box, { attributes: true, attributeFilter: ["style"] });
      fit(box);
    }
  };
  new MutationObserver(find).observe(document, { childList: true, subtree: true });
  find();
})();`;
}
