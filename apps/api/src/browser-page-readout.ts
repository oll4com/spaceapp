import type { Pane, PaneBrowserSession } from "@space/contracts";
import { SpaceConflictError } from "@space/runtime";
import { activeTabProfilePath, readChromeAutomationEndpoint } from "./cli-browser-cdp.js";
import { BROWSER_REVEAL_TARGETS } from "./browser-reveal.js";
import { CdpClient } from "./browser-sessions.js";
import type { SpaceApiConfig } from "./config.js";

/**
 * A masked readout of the pane browser's active tab (operator nous_msg:fcea1c9e1c704703949edd86, 7/11 Oracle: after a Vault fill the
 * fence hid the page, so an agent pressed Reset and Sign In blind and never saw «Invalid username or password»). It returns the URL
 * path, the title and the page's visible error, alert, status and heading texts; it never reads a field's value, and every word that
 * could be a secret, token or code is masked. Fixed script, the API's own connection (never the agent's CDP proxy): the document stays
 * clean for the next fill, and the fence lets the pane holding it (or the handoff's agent) read it like a masked screenshot.
 */

// Visible message-like elements; anything holding a field is skipped, and only the innermost match is kept.
const SCRIPT = `(() => {
  const sel = '[role=alert],[role=status],[aria-live]:not([aria-live=off]),[class*=error i],[class*=alert i],[class*=success i],[class*=warning i],[class*=notice i],[class*=message i],[class*=notification i],h1,h2';
  const field = 'input,textarea,select,[contenteditable]:not([contenteditable=false])';
  const shown = (el) => { const box = el.getBoundingClientRect(); const style = getComputedStyle(el); return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'; };
  const found = [...document.querySelectorAll(sel)].filter((el) => !el.matches(field) && !el.querySelector(field) && shown(el));
  const inner = found.filter((el) => !found.some((other) => other !== el && el.contains(other)));
  return { host: location.host, path: location.pathname, title: document.title, messages: inner.map((el) => el.innerText) };
})()`;

/** Per message: login errors are a line; the rest of a long text stays behind the fence (space_browser_masked_screenshot shows it). */
const MESSAGE_CHARS = 500;

/** A word that could be a password, token or code: 6+ characters with a digit, or 8+ mixing three of lower, upper, digit and symbol. */
function secretLike(word: string): boolean {
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z\d]/].filter((re) => re.test(word)).length;
  return (word.length >= 6 && /\d/.test(word)) || (word.length >= 8 && classes >= 3);
}
export function maskReadoutText(text: string): string {
  return text.replace(/\s+/g, " ").trim().split(" ").map((word) => {
    const core = word.replace(/^[("'«[]+|[)"'».,:;!?\]]+$/g, "");
    // The whole word: punctuation around a password may be part of it.
    return core && secretLike(core) ? "•••" : word;
  }).join(" ");
}
export function maskReadoutPath(path: string): string {
  return path.split("/").map((segment) => secretLike(decodeURIComponentSafe(segment)) ? "•••" : segment).join("/");
}
const decodeURIComponentSafe = (value: string) => { try { return decodeURIComponent(value); } catch { return value; } };

type TabOptions = { config: Pick<SpaceApiConfig, "browserSessionsProfileRoot">; pane: Pane; session: PaneBrowserSession };
type Connect = (endpoint: string, timeoutMs: number) => Promise<Pick<CdpClient, "send" | "close">>;

/** A fixed script's value in the active tab's top document, in an isolated world over the API's own connection. */
async function evaluateActiveTab<T>({ config, pane, session }: TabOptions, expression: string, connect: Connect): Promise<T> {
  const targetId = session.activePageId;
  if (!targetId || !session.pages.some((page) => page.pageId === targetId)) throw new SpaceConflictError("The browser's active tab is unavailable.");
  const endpoint = await readChromeAutomationEndpoint(await activeTabProfilePath(config.browserSessionsProfileRoot, pane, session));
  if (!endpoint) throw new SpaceConflictError("The browser's live connection is unavailable.");
  const client = await connect(endpoint, 3_000);
  let sessionId: string | undefined;
  try {
    ({ sessionId } = await client.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true }));
    // shortcut: the top document only; a message inside an iframe needs that frame's world, add it when a site needs it.
    const { frameTree } = await client.send<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree", {}, sessionId);
    const { executionContextId } = await client.send<{ executionContextId: number }>("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: "space-page-readout" }, sessionId);
    const reply = await client.send<{ exceptionDetails?: unknown; result?: { value?: T } }>("Runtime.evaluate",
      { expression, contextId: executionContextId, returnByValue: true, awaitPromise: true, silent: true }, sessionId);
    const value = reply.result?.value;
    if (reply.exceptionDetails || !value) throw new SpaceConflictError("The page changed while it was read; read it again.");
    return value;
  } finally {
    if (sessionId) await client.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
    client.close();
  }
}

export async function pageReadout(options: TabOptions, connect: Connect = CdpClient.connect) {
  const page = await evaluateActiveTab<{ host: string; path: string; title: string; messages: string[] }>(options, SCRIPT, connect);
  const messages = [...new Set(page.messages.map((text) => maskReadoutText(String(text)).slice(0, MESSAGE_CHARS)).filter(Boolean))];
  return { host: page.host, path: maskReadoutPath(page.path), title: maskReadoutText(page.title), messages,
    note: "Field values are never read; words that could be a secret, token or code show as •••. Act on these messages: an error means the step failed." };
}

// A shown, editable text-like field whose value differs from the page's own default: someone typed it. Only the boolean leaves the page.
const TYPED_SCRIPT = `(() => ({ typed: [...document.querySelectorAll('input,textarea')].some((el) => {
  if (el.disabled || el.readOnly || /^(?:hidden|search|submit|button|reset|image|checkbox|radio|range|color|file)$/i.test(el.type || '')) return false;
  const box = el.getBoundingClientRect();
  return box.width > 0 && box.height > 0 && el.value !== '' && el.value !== el.defaultValue;
}) }))()`;
/** Whether the active tab's form holds typed text (a filled form waiting for the operator, browser-reaper.ts); never a field's value. */
export async function pageHasTypedText(options: TabOptions, connect: Connect = CdpClient.connect): Promise<boolean> {
  // shortcut: the active tab's top document; a form in another tab or an iframe is not seen, read every tab when one is lost that way.
  return (await evaluateActiveTab<{ typed: boolean }>(options, TYPED_SCRIPT, connect)).typed === true;
}

// A real bot check: reCAPTCHA, hCaptcha and Turnstile (Go now's own selectors), or a puzzle (Arkose/FunCaptcha, GeeTest, AWS WAF).
const CAPTCHA_WIDGET = [...BROWSER_REVEAL_TARGETS.filter(([kind]) => ["recaptcha", "hcaptcha", "turnstile"].includes(kind)).map(([, selector]) => selector),
  'iframe[src*="arkoselabs"], iframe[src*="funcaptcha"], [class*="geetest_"], awswaf-captcha'].join(", ");
// The URL without its fragment, like readPageMetadata: a fragment can carry a page's state or tokens.
const CHALLENGE_SCRIPT = `(() => ({ host: location.hostname, url: location.origin + location.pathname + location.search, text: document.body ? document.body.innerText : "", widget: Boolean(document.querySelector(${JSON.stringify(CAPTCHA_WIDGET)})) }))()`;
/** The active tab's address, visible text and whether a bot check widget shows: only classified here (mailCodeHandoff), never returned to an agent. */
export function pageChallenge(options: TabOptions, connect: Connect = CdpClient.connect) {
  return evaluateActiveTab<{ host: string; url?: string; text: string; widget: boolean }>(options, CHALLENGE_SCRIPT, connect);
}

// Accent-folded, lower case (Greek pages write «Κωδικός επαλήθευσης» with and without accents).
const CODE_WORDS = /verification code|security code|confirmation code|one[- ]time (?:code|password|passcode)|\botp\b|enter (?:the|your|a|this) (?:\d[- ]digit )?code|code (?:we |was |has been )?sent|sent (?:you )?a (?:\d[- ]digit )?code|check your (?:e-?mail|inbox)|κωδικ\S* (?:επαληθευσης|επιβεβαιωσης|μιας χρησης)|(?:εισαγετε|πληκτρολογηστε) (?:τον )?κωδικ|ελεγξτε (?:το |τα |την )?(?:e-?mail|εισερχομενα|αλληλογραφια)/;
const PHONE_WORDS = /\bsms\b|text message|phone|mobile|authenticator|authentication app|whatsapp|κινητ|τηλεφων|γραπτ\S* μηνυμα/;
// A code sent to or read from the mailbox, not a mail word anywhere (19/11 Braintrust: the sign-in form's "Email" label under an authenticator dialog).
const MAIL_ROUTE = /\b(?:sent|send|sending|emailed|mailed)\b[^.\n]{0,40}(?:e-?mail|inbox|mailbox)|check your (?:e-?mail|inbox)|e-?mail (?:me )?(?:a |the )?(?:code|link)|(?:code|link) (?:by|via|to your) e-?mail|σταλ\S*[^.\n]{0,40}(?:e-?mail|ηλεκτρονικ\S* ταχυδρομ|εισερχομενα)|ελεγξτε (?:το |τα |την )?(?:e-?mail|εισερχομενα|αλληλογραφια)/;
const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
/** A page or text asking for a one-time code that a mailbox gets: code wording that names no phone or app, or names one and a mail route too. */
export function mailCodeAsk(text: string): boolean {
  const folded = fold(text);
  return CODE_WORDS.test(folded) && (!PHONE_WORDS.test(folded) || MAIL_ROUTE.test(folded));
}
/** A page asking for the code of an authenticator app with no mail route: the card says so plainly (19/11 Braintrust). */
export function authenticatorCodeAsk(text: string): boolean {
  const folded = fold(text);
  return CODE_WORDS.test(folded) && /authenticator|authentication app/.test(folded) && !MAIL_ROUTE.test(folded);
}
/** The agent says it read the mailbox already (the way past the mail-code gate when no code came). */
const MAIL_READ = /\bspace_mail_(?:search|read)\b|\b(?:read|searched|checked)\b[^.\n]{0,20}\b(?:mail(?:box)?|inbox|e-?mails?|gmail)\b|διαβασα[^.\n]{0,20}(?:mail|αλληλογραφ)/;
const CAPTCHA_WORDS = /captcha|turnstile|puzzle|i am human|not a robot|verify (?:that )?you are human/;
/** A text CAPTCHA ("enter the code shown in the image") has no widget; its page words are the check. */
const IMAGE_CAPTCHA = /(?:shown|you see) (?:in|on) the (?:image|picture)|characters (?:you see|shown|in the image)|type the (?:text|characters|letters) (?:you see|shown|in|below)/;
/**
 * Operator nous_msg:243370cb (7/11 20:27 ICT: a "Solve the check on hub.upcloud.com" card while the page only wanted an e-mailed code): a
 * CAPTCHA, code or other hands handoff whose page asks for a mailed code goes back to the agent with the mail route, unless the page shows a
 * real bot check widget. Unread page: the agent's reason is classified instead. Returns the agent's instruction, or null to hand over.
 */
export function mailCodeHandoff(page: { host: string; text: string; widget: boolean } | null, reason: string, host: string | null): string | null {
  const widget = page ? page.widget || IMAGE_CAPTCHA.test(fold(page.text)) : CAPTCHA_WORDS.test(fold(reason));
  if (widget || MAIL_READ.test(fold(reason)) || !mailCodeAsk(page?.text ?? reason)) return null;
  // shortcut: the last two labels as the sender's domain (hub.upcloud.com mails from upcloud.com); a co.uk-style site searches wider.
  const from = (page?.host ?? host ?? "").replace(/^www\./, "").split(".").slice(-2).join(".");
  return `Not handed over: the page asks for a code sent by e-mail, not a bot check. Read the code from the mailbox (space_mail_search${from ? ` from:${from}` : ""}) `
    + "and type it in. Request the handoff again only if no code arrived, saying so (\"read the mailbox: …\").";
}

/** A tap focuses its field this soon after its touchEnd is acked (Chrome's tap gesture follows the ack). */
const TAP_FOCUS_WAIT_MS = 250;
// Waits out the tap (Chrome focuses after the touch is acked) and answers whether a text field holds the focus: null when the focus is
// in a frame it cannot see into. Only that answer leaves the page, never a value.
const FOCUS_SCRIPT = `new Promise((resolve) => {
  const known = () => {
    let el = document.activeElement;
    while (el && (el.shadowRoot?.activeElement || el.tagName === 'IFRAME' || el.tagName === 'FRAME')) {
      if (el.shadowRoot?.activeElement) { el = el.shadowRoot.activeElement; continue; }
      const inner = (() => { try { return el.contentDocument; } catch { return null; } })();
      if (!inner) return null;
      el = inner.activeElement;
    }
    if (!el) return false;
    if (el.isContentEditable) return true;
    if (el.disabled || el.readOnly) return false;
    if (el.tagName === 'TEXTAREA') return true;
    return el.tagName === 'INPUT' && !/^(?:hidden|submit|button|reset|image|checkbox|radio|range|color|file)$/i.test(el.type || '');
  };
  const done = () => { document.removeEventListener('focusin', early, true); resolve({ editable: known() }); };
  const early = () => { if (known()) { clearTimeout(timer); done(); } };
  const timer = setTimeout(done, ${TAP_FOCUS_WAIT_MS});
  document.addEventListener('focusin', early, true);
})`;
/** Whether the active tab's focused element takes typing (teleport: the phone opens its keyboard like a phone browser), never its value. */
export async function pageFocusEditable(options: TabOptions, connect: Connect = CdpClient.connect): Promise<boolean | null> {
  return (await evaluateActiveTab<{ editable: boolean | null }>(options, FOCUS_SCRIPT, connect)).editable;
}

// Plan clipboard:nsWKwUFhUFWA slice 5: the visible form controls instead of a whole-page snapshot or text. A control that could hold a
// password, code, card or other secret reports only whether it is filled; hidden inputs are skipped. Click points are viewport CSS pixels.
export const FORMS_SCRIPT = `(() => {
  const clean = (text) => String(text || '').replace(/\\s+/g, ' ').trim();
  const shown = (el) => { const box = el.getBoundingClientRect(); const style = getComputedStyle(el); return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'; };
  const byIds = (ids) => clean((ids || '').split(/\\s+/).map((id) => document.getElementById(id)?.innerText || '').join(' '));
  const label = (el) => clean([...(el.labels || [])].map((l) => l.innerText).join(' ')) || el.getAttribute('aria-label') || byIds(el.getAttribute('aria-labelledby')) || el.placeholder || el.title || '';
  const secret = /password|passcode|one-time-code|\\botp\\b|token|secret|\\bpin\\b|cvv|cvc|\\bcc-|card|\\bssn\\b|security code|verification code/i;
  const point = (el) => { const box = el.getBoundingClientRect(); return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) }; };
  const controls = [...document.querySelectorAll('input,textarea,select,[contenteditable]:not([contenteditable=false]),[role=combobox],[role=checkbox],[role=radio],button,[role=button]')]
    .filter((el) => !(el.tagName === 'INPUT' && el.type === 'hidden') && shown(el));
  return { host: location.host, path: location.pathname, title: document.title, controls: controls.map((el) => {
    const type = el.tagName === 'INPUT' ? (el.type || 'text') : el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' || el.tagName === 'BUTTON' ? el.tagName.toLowerCase() : el.isContentEditable ? 'contenteditable' : el.getAttribute('role');
    const row = { type, label: clean(label(el)), name: el.getAttribute('name') || el.id || '', ...point(el) };
    if (el.required || el.getAttribute('aria-required') === 'true') row.required = true;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') row.disabled = true;
    if (type === 'button' || type === 'submit' || type === 'reset') { row.text = clean(el.innerText || el.value); return row; }
    if (type === 'checkbox' || type === 'radio') { row.checked = el.tagName === 'INPUT' ? el.checked : el.getAttribute('aria-checked') === 'true'; if (el.value && el.value !== 'on') row.value = clean(el.value); return row; }
    // DEV3D-070: a card expiry or other secret dropdown says only whether it is filled, like a secret text field.
    if (type === 'select' && secret.test([type, el.autocomplete, row.name, row.label].join(' '))) { row.filled = [...el.selectedOptions].some((o) => o.value !== ''); return row; }
    if (type === 'select') { row.options = [...el.options].map((o) => clean(o.text)); row.selected = [...el.selectedOptions].map((o) => clean(o.text)); return row; }
    if (type === 'file') { row.files = [...(el.files || [])].map((f) => f.name); return row; }
    const value = el.isContentEditable ? el.innerText : 'value' in el ? el.value : el.getAttribute('aria-valuetext') || el.innerText;
    if (secret.test([type, el.autocomplete, row.name, row.label].join(' '))) row.filled = clean(value) !== '';
    else row.value = clean(value);
    return row;
  }) };
})()`;
type FormControl = { type: string; label: string; name: string; x: number; y: number; value?: string; [key: string]: unknown };
/** The active tab's visible form controls: label, name, type, required, value or state and a click point. Secret-like fields: filled only. */
export async function pageForms(options: TabOptions, connect: Connect = CdpClient.connect) {
  // shortcut: the top document only (evaluateActiveTab); a form inside an iframe or a shadow root needs browser_snapshot until one is read here.
  const page = await evaluateActiveTab<{ host: string; path: string; title: string; controls: FormControl[] }>(options, FORMS_SCRIPT, connect);
  return { host: page.host, path: maskReadoutPath(page.path), title: maskReadoutText(page.title), controls: page.controls,
    note: "Visible controls of the top document; x/y are viewport CSS pixels. Password, code, card and token fields show only filled: true/false. A form inside an iframe is not listed: use browser_snapshot there." };
}
