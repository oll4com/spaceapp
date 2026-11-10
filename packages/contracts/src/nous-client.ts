import { z } from "zod";

/**
 * Where the operator writes to Nous from (operator 31/10 16:22 BKK, plan clipboard:4TXfIZzj8ITW): stored on every operator message as
 * `meta.client` so Nous fits its answer to the device. Derived on the server first; the `X-Space-Client` header only describes (no
 * route, permission or gate reads it).
 */
export const NOUS_CLIENT_APPS = ["WEB", "SPACEAPP_ANDROID", "NOUS_ANDROID", "DESKTOP_LINUX", "DESKTOP_WINDOWS", "DESKTOP_MAC", "TELEGRAM", "LIVE", "UNKNOWN"] as const;
export const NOUS_CLIENT_FORMS = ["PHONE", "TABLET", "DESKTOP"] as const;
export const NOUS_CLIENT_OSES = ["ANDROID", "IOS", "WINDOWS", "LINUX", "MACOS", "CHROMEOS"] as const;
export const NOUS_CLIENT_HEADER = "x-space-client";

const token = z.string().regex(/^[A-Za-z0-9._:/-]{1,40}$/);
export const nousClientContextSchema = z.object({
  app: z.enum(NOUS_CLIENT_APPS),
  form: z.enum(NOUS_CLIENT_FORMS).optional(),
  os: z.enum(NOUS_CLIENT_OSES).optional(),
  version: token.optional(),
  view: token.optional(),
  viewport: z.string().regex(/^\d{2,5}x\d{2,5}$/).optional()
}).strict();
export type NousClientContext = z.infer<typeof nousClientContextSchema>;
export type NousClientApp = NousClientContext["app"];

/** `app=NOUS_ANDROID; v=0.2.10; os=ANDROID; form=PHONE; view=requests; vp=412x915`: bad keys and values are dropped, never an error. */
export function parseNousClientHeader(header: string | null | undefined): Partial<NousClientContext> {
  if (!header || header.length > 300) return {};
  const keys: Record<string, keyof NousClientContext> = { app: "app", v: "version", os: "os", form: "form", view: "view", vp: "viewport" };
  const out: Partial<NousClientContext> = {};
  for (const part of header.split(";")) {
    const [rawKey, ...rest] = part.split("=");
    const key = keys[rawKey?.trim() ?? ""];
    if (!key) continue;
    const parsed = nousClientContextSchema.shape[key].safeParse(rest.join("=").trim());
    if (parsed.success && parsed.data !== undefined) (out as Record<string, unknown>)[key] = parsed.data;
  }
  return out;
}

/** The header a client sends for `context` (the web app, and the patch note for the Android apps). */
export function formatNousClientHeader(context: Partial<NousClientContext>): string {
  const pairs: Array<[string, string | undefined]> = [["app", context.app], ["v", context.version], ["os", context.os], ["form", context.form], ["view", context.view], ["vp", context.viewport]];
  return pairs.filter(([, value]) => value).map(([key, value]) => `${key}=${value}`).join("; ");
}

function fromUserAgent(ua: string): Pick<NousClientContext, "os" | "form"> {
  if (/Android/i.test(ua)) return { os: "ANDROID", form: /Mobile/i.test(ua) ? "PHONE" : "TABLET" };
  if (/iPhone|iPod/i.test(ua)) return { os: "IOS", form: "PHONE" };
  if (/iPad/i.test(ua)) return { os: "IOS", form: "TABLET" };
  if (/CrOS/i.test(ua)) return { os: "CHROMEOS", form: "DESKTOP" };
  if (/Windows NT/i.test(ua)) return { os: "WINDOWS", form: "DESKTOP" };
  if (/Macintosh|Mac OS X/i.test(ua)) return { os: "MACOS", form: "DESKTOP" };
  if (/X11|Linux/i.test(ua)) return { os: "LINUX", form: "DESKTOP" };
  return {};
}

const DESKTOP_APP: Record<string, NousClientApp> = { WINDOWS: "DESKTOP_WINDOWS", LINUX: "DESKTOP_LINUX", MACOS: "DESKTOP_MAC" };
const DESKTOP_APP_OS: Partial<Record<NousClientApp, NousClientContext["os"]>> = { DESKTOP_WINDOWS: "WINDOWS", DESKTOP_LINUX: "LINUX", DESKTOP_MAC: "MACOS" };
const HEADER_APPS = new Set<NousClientApp>(["WEB", "SPACEAPP_ANDROID", "NOUS_ANDROID", "DESKTOP_LINUX", "DESKTOP_WINDOWS", "DESKTOP_MAC"]);

/**
 * The client of one operator message. Firm server signals decide the app first (Space's own Telegram poller, the device session's
 * `app` claim, the Android WebView marker, an Electron UA); the header names the app only when they say nothing (the desktop app strips
 * Electron from its UA) and never TELEGRAM or LIVE. The UA gives the OS and form; the header fills what it cannot say.
 */
export function nousClientContext(input: { via?: "TELEGRAM" | "LIVE"; appClaim?: string | undefined; userAgent?: string | null; header?: string | null }): NousClientContext {
  if (input.via) return { app: input.via };
  const ua = input.userAgent ?? "";
  const header = parseNousClientHeader(input.header);
  const seen = fromUserAgent(ua);
  const app: NousClientApp = input.appClaim === "nous" ? "NOUS_ANDROID"
    : input.appClaim === "spaceapp" ? "SPACEAPP_ANDROID"
    : /;\s*wv\)/.test(ua) ? "SPACEAPP_ANDROID"
    : /Electron\//.test(ua) && seen.os && DESKTOP_APP[seen.os] ? DESKTOP_APP[seen.os]!
    : header.app && HEADER_APPS.has(header.app) ? header.app
    : /^Mozilla\//.test(ua) ? "WEB" : "UNKNOWN";
  const os = seen.os ?? header.os ?? (app === "NOUS_ANDROID" || app === "SPACEAPP_ANDROID" ? "ANDROID" : app.startsWith("DESKTOP_") ? DESKTOP_APP_OS[app] : undefined);
  const form = header.form ?? seen.form ?? (app.startsWith("DESKTOP_") ? "DESKTOP" : undefined);
  return { app, ...(form ? { form } : {}), ...(os ? { os } : {}),
    ...(header.version ? { version: header.version } : {}), ...(header.view ? { view: header.view } : {}), ...(header.viewport ? { viewport: header.viewport } : {}) };
}

const APP_NAMES: Record<NousClientApp, string> = {
  WEB: "the web app", SPACEAPP_ANDROID: "the SpaceApp Android app", NOUS_ANDROID: "the Nous app", DESKTOP_LINUX: "the Linux desktop app",
  DESKTOP_WINDOWS: "the Windows desktop app", DESKTOP_MAC: "the macOS desktop app", TELEGRAM: "Telegram", LIVE: "Live voice", UNKNOWN: "an unknown client"
};
const OS_NAMES: Record<NonNullable<NousClientContext["os"]>, string> = { ANDROID: "Android", IOS: "iOS", WINDOWS: "Windows", LINUX: "Linux", MACOS: "macOS", CHROMEOS: "ChromeOS" };

/** "the Nous app 0.2.10 on an Android phone, view requests": one phrase for the turn text. */
export function describeNousClient(context: NousClientContext): string {
  const os = context.os ? OS_NAMES[context.os] : "";
  const where = context.form === "DESKTOP" ? `on a computer${os ? ` (${os})` : ""}`
    : context.form ? `on ${/^[AEIOU]/.test(os) ? "an" : "a"}${os ? ` ${os}` : ""} ${context.form.toLowerCase()}` : os ? `on ${os}` : "";
  return `${APP_NAMES[context.app]}${context.version ? ` ${context.version}` : ""}${where ? ` ${where}` : ""}${context.view ? `, view ${context.view}` : ""}`;
}
