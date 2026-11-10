// Fixed observation of Microsoft's letters-in-an-image challenge. This code runs
// only in an isolated world. No caller-supplied selectors/script or field values.
export function microsoftCaptchaPage(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.port && !url.username && !url.password
      && ["portal.azure.com", "portal.azure.us", "portal.azure.cn", "signup.live.com", "login.live.com", "account.live.com"].includes(url.hostname);
  } catch { return false; }
}

export function microsoftCaptchaFrame(value: string): boolean {
  if (microsoftCaptchaPage(value)) return true;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.port && !url.username && !url.password
      && (url.hostname === "hip.live.com" || url.hostname.endsWith(".hip.live.com") || url.hostname.endsWith(".ext.azure.com")
        || url.hostname.endsWith(".reactblade.portal.azure.net"));
  } catch { return false; }
}

export const TEXT_CAPTCHA_OBSERVE = String.raw`(() => {
  const visible = el => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    for (let node = el; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0) return false;
    }
    return true;
  };
  const rect = el => { const r = el.getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height }; };
  const selector = el => {
    const parts = [];
    for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
      parts.unshift(node.localName + ':nth-child(' + ([...node.parentElement.children].indexOf(node) + 1) + ')');
    }
    return 'html>' + parts.join('>');
  };
  const editable = el => visible(el) && !['hidden','submit','button','checkbox','radio','image'].includes(el.type);
  const inputs = [...document.querySelectorAll('input')].filter(el => visible(el) && ['text',''].includes(el.type)
    && !el.readOnly && !el.disabled && /(?:type|enter).*(?:letters|characters)|captcha|hip(?:answer|solution)/i.test(
      [el.placeholder, el.getAttribute('aria-label'), el.id, el.name, ...[...el.labels || []].map(label => label.innerText)].join(' ')));
  const candidates = [];
  for (const input of inputs) {
    for (let container = input.parentElement; container && container !== document.body; container = container.parentElement) {
      // A CAPTCHA-only container: never select a site's account/Create form.
      const fields = [...container.querySelectorAll('input,textarea,select,[contenteditable=true]')].filter(editable);
      if (fields.length !== 1 || fields[0] !== input) break;
      const images = [...container.querySelectorAll('img')].filter(img => visible(img)
        && img.getBoundingClientRect().width >= 60 && img.getBoundingClientRect().height >= 20);
      const buttons = [...container.querySelectorAll('button,input[type=submit],[role=button]')].filter(el => visible(el)
        && /^(?:submit|verify)$/i.test((el.tagName === 'INPUT' ? el.getAttribute('value') : el.innerText || el.getAttribute('aria-label') || '').trim()));
      if (images.length !== 1 || buttons.length !== 1) continue;
      const img = images[0], button = buttons[0], box = rect(img);
      // Every image pixel must belong to the visible image, not a covered field.
      const clear = [[.1,.1],[.9,.1],[.5,.5],[.1,.9],[.9,.9]].every(([x,y]) =>
        document.elementFromPoint(box.x + box.width*x, box.y + box.height*y) === img);
      candidates.push({ image: selector(img), input: selector(input), submit: selector(button),
        box, inputBox: rect(input), submitBox: rect(button),
        ready: img.complete && img.naturalWidth > 0 && clear,
        disabled: !!button.disabled || button.getAttribute('aria-disabled') === 'true',
        focused: document.activeElement === input,
        // Fixed booleans only; error text and input values never leave the page.
        rejected: [...container.querySelectorAll('[role=alert],.error,[class*=error]')].some(el => visible(el)
          && /incorrect|invalid|does not match|did not match|try again/i.test(el.innerText || '')) });
      break;
    }
  }
  return { candidates, marker: inputs.length > 0, width: innerWidth, height: innerHeight };
})()`;
