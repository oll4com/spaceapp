import { formatNousClientHeader, type NousClientContext } from "@space/contracts";

/**
 * The X-Space-Client header the web app sends on every write (plan clipboard:4TXfIZzj8ITW): it only describes where the operator is
 * (the server derives the app from the session and the UA first). The desktop app strips Electron from its UA, so its bridge names it.
 */
const DESKTOP: Record<string, NousClientContext["app"]> = { linux: "DESKTOP_LINUX", win32: "DESKTOP_WINDOWS", darwin: "DESKTOP_MAC" };
let desktop: Partial<NousClientContext> = {};
let view: string | undefined;

type DesktopInfo = { platform?: string; version?: string };
const bridge = typeof window === "undefined" ? undefined : (window as unknown as { spaceDesktop?: { getSystemInfo?: () => Promise<DesktopInfo> } }).spaceDesktop;
void bridge?.getSystemInfo?.().then((info) => {
  const app = DESKTOP[info?.platform ?? ""];
  if (app) desktop = { app, form: "DESKTOP", ...(info.version && /^[A-Za-z0-9._-]{1,40}$/.test(info.version) ? { version: info.version } : {}) };
}).catch(() => undefined);

/** SpaceApp Android's Web tab (its WebView bridge): the server knows the app from the session, only the app's version comes from here. */
function androidVersion(): string | undefined {
  try {
    const version = (window as unknown as { SpaceNative?: { appVersion?: () => string } }).SpaceNative?.appVersion?.();
    return version && /^[A-Za-z0-9._-]{1,40}$/.test(version) ? version : undefined;
  } catch {
    return undefined;
  }
}

/** The view the operator is on ("nous:conversation"); the Nous dock sets it while open. */
export function setClientView(next: string | undefined): void {
  view = next;
}

export function clientHeader(): string {
  if (typeof window === "undefined") return "";
  const width = Math.round(window.innerWidth), height = Math.round(window.innerHeight);
  // A touch screen's short side says phone or tablet (an iPad's Safari says Macintosh in its UA).
  const touch = window.matchMedia?.("(pointer: coarse)").matches === true;
  const form = desktop.form ?? (touch ? (Math.min(width, height) < 600 ? "PHONE" : "TABLET") : undefined);
  const version = desktop.version ?? androidVersion();
  return formatNousClientHeader({ ...desktop, ...(version ? { version } : {}), ...(form ? { form } : {}), ...(view ? { view } : {}), ...(width && height ? { viewport: `${width}x${height}` } : {}) });
}
