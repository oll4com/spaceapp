import http from "node:http";
import zlib from "node:zlib";
import { harnessSharedEventsBootstrap } from "./harness-shared-events.js";
import { createHash, randomUUID } from "node:crypto";
import type { Duplex } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { SpaceApiConfig } from "./config.js";
import { publishHarnessAgentTokens, type HarnessAgentTokenOptions } from "./harness-agent-tokens.js";
import type {} from "./request-context.js";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

// Space's own credentials stay on this side of the proxy: the Harness never
// needs the operator session cookie, CSRF token or internal tokens.
const SPACE_COOKIE_PREFIX = "space_";
const SPACE_PRIVATE_HEADER_PREFIX = "x-space-";

function isSpacePrivateHeader(name: string): boolean {
  return name.toLowerCase().startsWith(SPACE_PRIVATE_HEADER_PREFIX);
}

export function stripSpaceCookies(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value.join("; ") : value;
  if (!raw) {
    return undefined;
  }
  const kept = raw
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !part.toLowerCase().startsWith(SPACE_COOKIE_PREFIX));
  return kept.length > 0 ? kept.join("; ") : undefined;
}

function requireHarnessSession(request: FastifyRequest, reply: FastifyReply): boolean {
  if (request.user) {
    return true;
  }
  sendProxyError(reply, 401, "UNAUTHENTICATED", "Authentication is required.");
  return false;
}

const BROWSER_TRUST_HEADERS = new Set([
  "origin",
  "referer",
  "sec-fetch-site",
  "sec-fetch-mode",
  "sec-fetch-dest",
  "sec-fetch-user"
]);

const HARNESS_WEBSOCKET_PATHS = new Set([
  "/api/events.mux",
  "/api/events.host",
  "/api/remote.mux"
]);

const HARNESS_ROOT_HTTP_PATHS = new Set([
  "/plugins/events",
  "/api/respond",
  "/api/commands/list",
  "/api/commands/execute",
  "/api/pluginInventory/list",
  "/api/dynamicCordisRunner/inventory",
  "/api/dynamicCordisRunner/syncInspectManifest",
  "/api/session/uploadFileBinary"
]);

const SPACE_PANE_ID_PATTERN = /^pane:[A-Za-z0-9_-]{6,80}$/;
const HARNESS_CURRENT_SESSION_KEY = "dsh.sessions.current";
const HARNESS_DEFAULT_WORKSPACE = "/opt/spaceapp/var/deepseek-harness/workspace";
const HARNESS_IMMUTABLE_CACHE_CONTROL = "private, max-age=31536000, immutable";
const HARNESS_FINGERPRINTED_ASSET_PATTERN = /-[A-Za-z0-9_-]{6,}\.[A-Za-z0-9]{1,8}$/;
const HARNESS_REVISION_PATTERN = /^[a-f0-9]{8,64}$/i;
// Every deploy restarts the Harness (about 5 s to listen); an open pane that reloads its plugins then must not crash.
const HARNESS_RESTART_GRACE_MS = 15_000;
const HARNESS_RESTART_RETRY_MS = 250;

export function isHarnessRootHttpPath(rawUrl: string | undefined): boolean {
  const pathname = (rawUrl ?? "").split("?", 1)[0] ?? "";
  return HARNESS_ROOT_HTTP_PATHS.has(pathname) || pathname.startsWith("/plugins/");
}

const HTML_REWRITE_RULES: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  { pattern: /src="\/assets\//g, replacement: 'src="/api/harness/assets/' },
  { pattern: /href="\/assets\//g, replacement: 'href="/api/harness/assets/' },
  { pattern: /href="\/plugins\//g, replacement: 'href="/api/harness/plugins/' },
  { pattern: /href="plugins\//g, replacement: 'href="/api/harness/plugins/' },
  { pattern: /"url":"\/plugins\//g, replacement: '"url":"/api/harness/plugins/' },
  { pattern: /"url":"plugins\//g, replacement: '"url":"/api/harness/plugins/' },
  { pattern: /src="\/plugins\//g, replacement: 'src="/api/harness/plugins/' },
  { pattern: /src="plugins\//g, replacement: 'src="/api/harness/plugins/' },
  { pattern: /href="\/manifest\.webmanifest"/g, replacement: 'href="/api/harness/manifest.webmanifest"' },
  { pattern: /href="\/favicon\.svg"/g, replacement: 'href="/api/harness/favicon.svg"' }
];

function harnessPaneSessionId(rawUrl: string): string | null {
  const url = new URL(rawUrl, "http://space.local");
  const paneId = url.searchParams.get("spacePane");
  if (!paneId || !SPACE_PANE_ID_PATTERN.test(paneId)) return null;
  return `space-pane-${paneId.slice("pane:".length)}`;
}

export function harnessUpstreamPath(rawUrl: string): string {
  let relative = rawUrl.replace(/^\/api\/harness\/?/, "/");
  if (!relative.startsWith("/")) {
    relative = `/${relative}`;
  }
  if (!relative.includes("spacePane=")) {
    return relative;
  }
  return relative
    .replace(/([?&])spacePane=[^&#]*(&|$)/, (_, p1, p2) => (p2 ? p1 : ""))
    .replace(/\?&/, "?")
    .replace(/[?&]$/, "");
}

export function harnessStaticCacheControl(rawUrl: string, method: string): string | null {
  if (method !== "GET" && method !== "HEAD") return null;
  const url = new URL(rawUrl, "http://space.local");
  const pathname = url.pathname.replace(/^\/api\/harness/, "") || "/";
  if (pathname.startsWith("/assets/") && HARNESS_FINGERPRINTED_ASSET_PATTERN.test(pathname)) {
    return HARNESS_IMMUTABLE_CACHE_CONTROL;
  }
  if (pathname.startsWith("/plugins/") && HARNESS_REVISION_PATTERN.test(url.searchParams.get("rev") ?? "")) {
    return HARNESS_IMMUTABLE_CACHE_CONTROL;
  }
  return null;
}

function harnessPaneStorageBootstrap(sessionId: string): string {
  const currentKey = JSON.stringify(HARNESS_CURRENT_SESSION_KEY);
  const scopedKey = JSON.stringify(
    `${HARNESS_CURRENT_SESSION_KEY}.${sessionId}`,
  );
  const initialValue = JSON.stringify(JSON.stringify({ sessionId }));
  return `<script data-space-harness-pane-session>(function(){
    const currentKey=${currentKey},scopedKey=${scopedKey},paneSessionId=${JSON.stringify(sessionId)};
    const realStorage=window.localStorage;
    realStorage.setItem(scopedKey,${initialValue});
    realStorage.setItem(currentKey,${initialValue});
    function publish(){try{const selected=JSON.parse(realStorage.getItem(scopedKey)||"null");if(typeof selected?.sessionId==="string")window.parent.postMessage({type:"space:harness-session",paneSessionId,sessionId:selected.sessionId},window.location.origin);}catch{}}
    const scopedStorage=new Proxy(realStorage,{get:function(target,property){
      if(property==="getItem")return function(key){return target.getItem(key===currentKey?scopedKey:key);};
      if(property==="setItem")return function(key,value){
        const result=target.setItem(key===currentKey?scopedKey:key,value);
        if(key===currentKey){
          target.setItem(currentKey,value);
          publish();
        }
        return result;
      };
      if(property==="removeItem")return function(key){
        target.removeItem(key===currentKey?scopedKey:key);
        if(key===currentKey)target.removeItem(currentKey);
      };
      const value=Reflect.get(target,property,target);return typeof value==="function"?value.bind(target):value;
    },set:function(target,property,value){return Reflect.set(target,property,value,target);}});
    Object.defineProperty(window,"localStorage",{configurable:true,enumerable:true,value:scopedStorage});
    publish();

    function isComposerInert(){
      try{
        const input=document.querySelector('[data-composer-input]');
        if(!input) return true;
        const phase=input.getAttribute('data-phase');
        const editable=input.getAttribute('contenteditable');
        return phase==='inert'||editable==='false';
      }catch(e){return false;}
    }

    function isInteractiveFocused(){
      try{
        const active=document.activeElement;
        if(!active) return false;
        if(active.closest('[role="menu"]')||active.closest('[role="dialog"]')||active.closest('[aria-haspopup="menu"]')||active.closest('button')||active.closest('input')||active.closest('select')||active.closest('[data-model-select]')) return true;
      }catch(e){}
      return false;
    }

    function focusComposer(){
      try{
        if(document.querySelector('[role="menu"]')) return false;
        if(isInteractiveFocused()) return false;
        const el=document.querySelector('[data-slate-editor="true"],textarea,[contenteditable="true"]');
        if(el){el.focus();return true;}
      }catch(e){}
      return false;
    }

    function clickElement(el){
      if(!el) return false;
      try{
        el.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true,cancelable:true}));
        el.dispatchEvent(new MouseEvent("mousedown",{bubbles:true,cancelable:true}));
        el.dispatchEvent(new PointerEvent("pointerup",{bubbles:true,cancelable:true}));
        el.dispatchEvent(new MouseEvent("mouseup",{bubbles:true,cancelable:true}));
        el.click();
        return true;
      }catch(e){
        try{el.click();return true;}catch(err){return false;}
      }
    }

    function isWorkspaceMenu(menu){
      if(!menu) return false;
      try{
        const txt=(menu.textContent||"").toLowerCase();
        if(txt.includes("effort")||menu.querySelector('[data-model-select]')) return false;
        if(txt.includes("workspace")||txt.includes("/opt/spaceapp")||txt.includes("space")) return true;
        const trigger=document.querySelector('button[aria-label*="Choose workspace"],button.pXSMma_workspace,button[class*="workspace"]');
        if(trigger&&trigger.getAttribute('aria-expanded')==='true') return true;
      }catch(e){}
      return false;
    }

    function autoSelectWorkspace(){
      if(!isComposerInert()) return false;
      try{
        const menus=Array.from(document.querySelectorAll('[role="menu"]'));
        const menu=menus.find(isWorkspaceMenu);
        if(!menu) return false;
        const items=Array.from(menu.querySelectorAll('button[role="menuitem"],button'));
        if(items.length===0) return false;

        const targetItem=items.find(function(btn){
          const txt=(btn.textContent||"").trim();
          return txt==="space"||txt==="/opt/spaceapp";
        })||items.find(function(btn){
          const txt=(btn.textContent||"").trim();
          return /\\bspace\\b/i.test(txt)&&!/space[0-9]/i.test(txt)&&!/workspace/i.test(txt);
        });

        if(targetItem){
          clickElement(targetItem);
          setTimeout(function(){
            if(!isComposerInert()){
              cleanupWatchdog();
              focusComposer();
            }
          },100);
          return true;
        }
      }catch(e){}
      return false;
    }

    let observer=null;
    let autoSelectTimer=null;
    function cleanupWatchdog(){
      if(autoSelectTimer){clearInterval(autoSelectTimer);autoSelectTimer=null;}
      if(observer){observer.disconnect();observer=null;}
    }

    function checkAndAutoSelect(){
      if(!isComposerInert()){
        cleanupWatchdog();
        focusComposer();
        return;
      }
      if(autoSelectWorkspace()) return;
      try{
        const chip=document.querySelector('button[aria-label*="Choose workspace"],button.pXSMma_workspace,button[class*="workspace"]');
        if(chip){
          clickElement(chip);
          setTimeout(autoSelectWorkspace,50);
          setTimeout(autoSelectWorkspace,150);
        }
      }catch(e){}
    }

    let intervalCount=0;
    autoSelectTimer=setInterval(function(){
      intervalCount++;
      if(!isComposerInert()){
        cleanupWatchdog();
        focusComposer();
        return;
      }
      checkAndAutoSelect();
      if(intervalCount>60) cleanupWatchdog();
    },150);

    observer=new MutationObserver(function(){
      if(!isComposerInert()){
        cleanupWatchdog();
        focusComposer();
        return;
      }
      if(document.querySelector('[role="menu"]')){
        autoSelectWorkspace();
      }
    });
    try{
      observer.observe(document.documentElement||document.body,{childList:true,subtree:true});
    }catch(e){}

    window.addEventListener("DOMContentLoaded",function(){checkAndAutoSelect();});
    window.addEventListener("load",function(){checkAndAutoSelect();});
    document.addEventListener("click",function(e){
      const target=e.target;
      if(target&&target.closest&&target.closest('[data-composer-card],[data-composer-input],[class*="composer"],[class*="heroWorkspaceRow"]')){
        if(isComposerInert()){
          setTimeout(autoSelectWorkspace,30);
          setTimeout(checkAndAutoSelect,100);
        }
      }
    },true);
  })();</script>`;
}

export function harnessDebugBootstrap(sessionId: string): string {
  return `<script data-space-harness-debug>(function(){
    function escapeHtml(value) {
      return String(value == null ? "" : value).replace(/[&<>"']/g, function(c) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
      });
    }
    // Chromium reports a ResizeObserver whose callback resized observed elements as an ErrorEvent
    // without an error object; the spec only defers those notifications to the next frame.
    function isBenignErrorEvent(evt) {
      return !evt.error && /ResizeObserver loop (completed with undelivered notifications|limit exceeded)/.test(String(evt.message || ""));
    }
    const state = {
      paneSessionId: ${JSON.stringify(sessionId)},
      errors: [],
      rejections: [],
      failedResources: [],
      startTime: Date.now(),
      isRendered: false,
      collapsed: false,
      appDebugEnabled: false
    };
    window.__SPACE_HARNESS_DEBUG__ = state;

    try {
      fetch("/api/app-diagnostics", { credentials: "include" })
        .then(function(r){ return r.json(); })
        .then(function(d){
          if (d && d.enabled) {
            state.appDebugEnabled = true;
            renderStatus(false);
          }
        }).catch(function(){});
    } catch(e) {}

    function createOverlay() {
      let overlay = document.getElementById("space-harness-debug-overlay");
      if (!overlay) {
        overlay = document.createElement("div");
        overlay.id = "space-harness-debug-overlay";
        overlay.style.cssText = "position:fixed;bottom:12px;right:12px;max-width:540px;max-height:80vh;overflow-y:auto;background:rgba(15,23,42,0.96);color:#f1f5f9;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;padding:12px;border-radius:8px;box-shadow:0 12px 36px rgba(0,0,0,0.5);border:1px solid #334155;z-index:999999;line-height:1.4;";
        (document.body || document.documentElement).appendChild(overlay);
      }
      return overlay;
    }

    function renderStatus(isFatal) {
      if (!document.body && !document.documentElement) return;
      const hasErrors = state.errors.length > 0 || state.failedResources.length > 0 || state.rejections.length > 0;
      if (!hasErrors && !isFatal && !state.appDebugEnabled) {
        const existing = document.getElementById("space-harness-debug-overlay");
        if (existing) existing.remove();
        return;
      }
      const overlay = createOverlay();
      if (state.collapsed) {
        overlay.style.padding = "4px 8px";
        overlay.style.cursor = "pointer";
        let mini = '';
        if (hasErrors) {
          mini += '<span style="color:#f87171;font-weight:600;">● ' + (state.errors.length + state.failedResources.length + state.rejections.length) + ' Issue(s)</span>';
        }
        if (state.appDebugEnabled) {
          mini += ' <span style="background:#dc2626;color:#fff;font-size:9px;padding:1px 4px;border-radius:3px;font-weight:bold;margin-left:4px;">DEBUG ON</span>';
        }
        overlay.innerHTML = mini;
        overlay.onclick = function() { state.collapsed = false; renderStatus(false); };
        return;
      }

      overlay.style.padding = "12px";
      overlay.style.cursor = "default";
      overlay.onclick = null;
      let html = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;font-weight:bold;border-bottom:1px solid #334155;padding-bottom:6px;">';
      html += '<span>Space Harness Diagnostics</span>';
      html += '<div style="display:flex;gap:6px;align-items:center;">';
      if (state.appDebugEnabled) {
        html += '<span style="background:#dc2626;color:#fff;font-size:9px;padding:2px 5px;border-radius:3px;font-weight:bold;">DEBUG ON</span>';
      }
      html += '<span style="font-size:10px;padding:2px 6px;border-radius:4px;background:' + (state.isRendered ? '#065f46;color:#34d399' : (isFatal || hasErrors ? '#7f1d1d;color:#f87171' : '#1e293b;color:#94a3b8')) + ';">' + (state.isRendered ? 'Ready' : (isFatal || hasErrors ? 'Load Issue' : 'Initializing')) + '</span>';
      if (state.isRendered) {
        html += '<button id="space-harness-debug-collapse-btn" style="background:#334155;border:none;color:#cbd5e1;padding:2px 6px;border-radius:4px;cursor:pointer;font-size:10px;">Minimize</button>';
      }
      html += '</div></div>';
      html += '<div style="color:#94a3b8;font-size:11px;margin-bottom:6px;">Pane Session: <span style="color:#38bdf8;">' + escapeHtml(state.paneSessionId) + '</span></div>';
      if (state.failedResources.length > 0) {
        html += '<div style="color:#f87171;font-weight:bold;margin-top:6px;">Failed Resources (' + state.failedResources.length + '):</div>';
        state.failedResources.forEach(function(r) {
          html += '<div style="color:#fca5a5;word-break:break-all;margin-left:8px;">• ' + escapeHtml(r) + '</div>';
        });
      }
      if (state.errors.length > 0) {
        html += '<div style="color:#ef4444;font-weight:bold;margin-top:6px;">Uncaught JavaScript Errors (' + state.errors.length + '):</div>';
        state.errors.forEach(function(e) {
          html += '<div style="color:#fca5a5;word-break:break-all;margin-left:8px;margin-bottom:4px;">• ' + escapeHtml(e.message || e) + (e.stack ? '<pre style="font-size:10px;color:#cbd5e1;overflow-x:auto;margin:2px 0 0 0;padding:4px;background:#0f172a;border-radius:4px;">' + escapeHtml(e.stack) + '</pre>' : '') + '</div>';
        });
      }
      if (state.rejections.length > 0) {
        html += '<div style="color:#f97316;font-weight:bold;margin-top:6px;">Unhandled Rejections (' + state.rejections.length + '):</div>';
        state.rejections.forEach(function(r) {
          html += '<div style="color:#fdba74;word-break:break-all;margin-left:8px;">• ' + escapeHtml(r.reason || r) + '</div>';
        });
      }
      if (!state.isRendered && (isFatal || hasErrors) && state.errors.length === 0 && state.failedResources.length === 0) {
        html += '<div style="color:#fbbf24;margin-top:6px;">Waiting for client bundle to mount. Scripts are loading.</div>';
      }
      overlay.innerHTML = html;
      const btn = document.getElementById("space-harness-debug-collapse-btn");
      if (btn) {
        btn.onclick = function(e) { e.stopPropagation(); state.collapsed = true; renderStatus(false); };
      }
    }

    window.addEventListener("error", function(evt) {
      if (evt.target && evt.target !== window && (evt.target.src || evt.target.href)) {
        state.failedResources.push(evt.target.src || evt.target.href);
        renderStatus(true);
        return;
      }
      if (isBenignErrorEvent(evt)) return;
      state.errors.push({ message: evt.message || String(evt), stack: evt.error?.stack || "" });
      renderStatus(true);
    }, true);

    window.addEventListener("unhandledrejection", function(evt) {
      state.rejections.push({ reason: evt.reason?.message || String(evt.reason) });
      renderStatus(true);
    });

    const checkInterval = setInterval(function() {
      const root = document.getElementById("root") || document.querySelector("#app, main, .dsh-app, [data-ds-theme]");
      if (root && root.children.length > 0) {
        state.isRendered = true;
        clearInterval(checkInterval);
        if (!state.appDebugEnabled && state.errors.length === 0 && state.failedResources.length === 0) {
          state.collapsed = true;
        }
        renderStatus(false);
      } else if (Date.now() - state.startTime > 4000) {
        clearInterval(checkInterval);
        renderStatus(true);
      }
    }, 250);
  })();</script>`;
}

const harnessTransportBootstrap = `<script data-space-harness-transport>(function(){
  window.__DSH_TRANSPORT__ = Object.assign(window.__DSH_TRANSPORT__ || {}, { ownsHost: true });
})();</script>`;

function rewriteHarnessHtml(body: string, paneSessionId?: string): string {
  let out = body;
  for (const rule of HTML_REWRITE_RULES) {
    out = out.replace(rule.pattern, rule.replacement);
  }
  const paneBootstrap = paneSessionId
    ? harnessDebugBootstrap(paneSessionId) + harnessPaneStorageBootstrap(paneSessionId) + harnessSharedEventsBootstrap
    : "";
  const bootstrap = `${harnessTransportBootstrap}${paneBootstrap}`;
  out = /<head(?:\s[^>]*)?>/i.test(out)
    ? out.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${bootstrap}`)
    : `${bootstrap}${out}`;
  return out;
}

function callHarnessRpcOnce(
  target: URL,
  path: string,
  method: string,
  rpcPayload: unknown,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; value?: unknown; error?: Error }> {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      type: "client-request",
      rpcId: `space-pane-${randomUUID()}`,
      method,
      payload: rpcPayload,
    });
    const upstream = http.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        method: "POST",
        path: `/api/${path}`,
        headers: {
          host: harnessLoopbackAuthority(target),
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
        timeout: timeoutMs,
      },
      (response) => {
        const statusCode = response.statusCode ?? 500;
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.byteLength;
          if (bytes > 512_000) {
            response.destroy(
              new Error("Harness metadata response exceeded its limit."),
            );
            return;
          }
          chunks.push(chunk);
        });
        response.once("error", (err) => resolve({ ok: false, status: statusCode, error: err }));
        response.on("end", () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
              result?: { ok?: boolean; value?: unknown; error?: { code?: string; message?: string } };
            };
            if (
              statusCode < 200 ||
              statusCode >= 300 ||
              body.result?.ok !== true
            ) {
              const errorMessage = body.result?.error?.message || `Harness RPC failed with status ${statusCode}.`;
              const err = new Error(errorMessage);
              if (body.result?.error?.code) {
                (err as { code?: string }).code = body.result.error.code;
              }
              resolve({ ok: false, status: statusCode, error: err });
              return;
            }
            resolve({ ok: true, status: statusCode, value: body.result.value });
          } catch {
            resolve({
              ok: false,
              status: statusCode,
              error: new Error("Harness pane session response was invalid."),
            });
          }
        });
      },
    );
    upstream.once("timeout", () => {
      upstream.destroy();
      resolve({
        ok: false,
        status: 504,
        error: new Error("Harness pane session request timed out."),
      });
    });
    upstream.once("error", (err) => resolve({ ok: false, status: 502, error: err }));
    upstream.end(payload);
  });
}

const knownTypertHosts = new Set<string>();

async function callHarnessRpc(
  target: URL,
  method: string,
  rpcPayload: unknown,
  timeoutMs: number,
): Promise<unknown> {
  const isTypertPayload =
    rpcPayload !== null &&
    typeof rpcPayload === "object" &&
    "args" in (rpcPayload as Record<string, unknown>);
  const slashMethod = method.includes(".") ? method.replace(".", "/") : method;
  const typertPayload = isTypertPayload ? rpcPayload : { args: { request: rpcPayload } };

  // If already known to be Typert Gateway, or if method uses slash notation, use Typert directly
  if (knownTypertHosts.has(target.host) || !method.includes(".")) {
    const res = await callHarnessRpcOnce(
      target,
      slashMethod,
      slashMethod,
      typertPayload,
      timeoutMs,
    );
    if (res.ok) {
      knownTypertHosts.add(target.host);
      return res.value;
    }
    // If Typert call failed and method was originally dot-separated, fallback to dot
    if (method.includes(".") && res.status === 404) {
      knownTypertHosts.delete(target.host);
      const dotRes = await callHarnessRpcOnce(target, method, method, rpcPayload, timeoutMs);
      if (dotRes.ok) return dotRes.value;
      throw dotRes.error || new Error("Harness RPC failed.");
    }
    throw res.error || new Error("Harness RPC failed.");
  }

  // Otherwise, try legacy/dot format first (compatible with existing test fixtures and older versions)
  const dotRes = await callHarnessRpcOnce(target, method, method, rpcPayload, timeoutMs);
  if (dotRes.ok) {
    return dotRes.value;
  }

  // If dot format returned 404, fallback to Typert Gateway format
  if (dotRes.status === 404) {
    const typertRes = await callHarnessRpcOnce(
      target,
      slashMethod,
      slashMethod,
      typertPayload,
      timeoutMs,
    );
    if (typertRes.ok) {
      knownTypertHosts.add(target.host);
      return typertRes.value;
    }
    throw typertRes.error || new Error("Harness RPC failed.");
  }

  throw dotRes.error || new Error("Harness RPC failed.");
}

/** Metadata-only RPCs for the exact session assigned to this Space pane. */
export async function readHarnessTaskTitle(
  config: SpaceApiConfig,
  paneId: string,
  selectedSessionId?: string,
): Promise<{
  sessionId: string;
  requests: string[];
  title: string | null;
} | null> {
  if (!config.harnessEnabled || !SPACE_PANE_ID_PATTERN.test(paneId))
    return null;
  const sessionId = selectedSessionId ?? `space-pane-${paneId.slice(5)}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/.test(sessionId)) return null;

  let title: unknown = null;
  const requests: string[] = [];

  try {
    const history = (await callHarnessRpc(
      new URL(config.harnessOrigin),
      "session.history",
      { sessionId, maxMessages: 30 },
      5000,
    )) as {
      events?: Array<{ event?: { type?: string; data?: any } }>;
      projections?: { values?: { title?: unknown } };
    };
    const events = history.events ?? [];
    for (const item of events) {
      if (
        item.event?.type === "user/message" &&
        item.event.data?.source?.kind === "user"
      ) {
        const parts = Array.isArray(item.event?.data?.content) ? item.event.data.content : [];
        const text = parts
          .filter((part: any) => part.type === "text" && typeof part.text === "string")
          .map((part: any) => part.text)
          .join(" ");
        if (text) requests.push(text);
      }
    }
    title = history.projections?.values?.title;
  } catch {
    try {
      const proj = (await callHarnessRpc(
        new URL(config.harnessOrigin),
        "session/projections",
        { sessionId },
        5000,
      )) as { asOfSeq?: number; values?: { title?: unknown } };
      title = proj?.values?.title;
      if (typeof proj?.asOfSeq === "number" && proj.asOfSeq > 0) {
        try {
          const page = (await callHarnessRpc(
            new URL(config.harnessOrigin),
            "session/page",
            { address: { kind: "session", sessionId }, throughSeq: proj.asOfSeq },
            5000,
          )) as { records?: Array<{ type?: string; event?: { type?: string; data?: any } }> };
          const records = page?.records ?? [];
          for (const item of records) {
            if (
              item.event?.type === "user/message" &&
              item.event.data?.source?.kind === "user"
            ) {
              const parts = Array.isArray(item.event?.data?.content) ? item.event.data.content : [];
              const text = parts
                .filter((part: any) => part.type === "text" && typeof part.text === "string")
                .map((part: any) => part.text)
                .join(" ");
              if (text) requests.push(text);
            }
          }
        } catch {}
      }
    } catch {
      return null;
    }
  }

  return {
    sessionId,
    requests: requests.slice(-12).map((value) => value.slice(0, 3000)),
    title: typeof title === "string" ? title.slice(0, 160) : null,
  };
}
export async function renameHarnessTaskTitle(
  config: SpaceApiConfig,
  paneId: string,
  sessionId: string,
  title: string,
  expectedSessionId = `space-pane-${paneId.slice(5)}`,
): Promise<void> {
  if (
    !config.harnessEnabled ||
    !SPACE_PANE_ID_PATTERN.test(paneId) ||
    !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/.test(sessionId) ||
    sessionId !== expectedSessionId
  )
    throw new Error("Harness task identity mismatch.");
  const result = (await callHarnessRpc(
    new URL(config.harnessOrigin),
    "session.rename",
    { sessionId, title },
    5000,
  )) as { title?: string };
  if (result.title !== title)
    throw new Error("Harness title was not confirmed.");
  if ((await readHarnessTaskTitle(config, paneId, sessionId))?.title !== title)
    throw new Error("Harness title read-back did not match.");
}

async function ensureHarnessPaneSession(
  target: URL,
  sessionId: string,
  timeoutMs: number,
  workspacePath = HARNESS_DEFAULT_WORKSPACE
): Promise<string> {
  const workspaceResult = await callHarnessRpc(
    target,
    "workspace.create",
    { path: workspacePath },
    timeoutMs
  ) as { workspace?: { workspaceId?: string } };
  const workspaceId = workspaceResult.workspace?.workspaceId;
  if (!workspaceId) throw new Error("Harness workspace creation failed.");

  try {
    const sessionResult = await callHarnessRpc(
      target,
      "session.create",
      { sessionId, workspaceId },
      timeoutMs
    ) as { sessionId?: string };
    if (sessionResult.sessionId === sessionId) return sessionId;
  } catch (error: any) {
    if (
      error?.code === "session-conflict" ||
      error?.code === "session/conflict" ||
      String(error?.code).includes("conflict") ||
      String(error?.message).includes("conflict") ||
      String(error?.message).includes("already exists with cwd")
    ) {
      return sessionId;
    }
    throw error;
  }
  return sessionId;
}

export function isHarnessUpgradePath(rawUrl: string | undefined): boolean {
  const pathname = (rawUrl ?? "").split("?", 1)[0] ?? "";
  return (
    pathname === "/api/harness" ||
    pathname.startsWith("/api/harness/") ||
    HARNESS_WEBSOCKET_PATHS.has(pathname)
  );
}

function stripHopByHop(headerName: string): boolean {
  return !HOP_BY_HOP_HEADERS.has(headerName.toLowerCase());
}

function appendForwardedFor(existing: string | string[] | undefined, remoteAddress: string | undefined): string {
  const chain = Array.isArray(existing) ? existing.join(", ") : (existing ?? "");
  const next = remoteAddress ?? "";
  if (!chain) return next;
  if (!next) return chain;
  return `${chain}, ${next}`;
}

function harnessLoopbackAuthority(target: URL): string {
  return target.port ? `127.0.0.1:${target.port}` : "127.0.0.1";
}

function sendProxyError(reply: FastifyReply, statusCode: number, code: string, message: string): FastifyReply {
  return reply.code(statusCode).send({
    error: {
      code,
      message,
      requestId: "space-api"
    }
  });
}

function buildUpstreamHeaders(
  request: FastifyRequest,
  target: URL,
  extra?: Record<string, string | string[] | number | undefined>,
  forceIdentityEncoding?: boolean
): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {
    ...Object.fromEntries(
      Object.entries(request.headers)
        .filter(([name, value]) =>
          stripHopByHop(name) && !BROWSER_TRUST_HEADERS.has(name.toLowerCase()) && !isSpacePrivateHeader(name) && value !== undefined
        )
    ),
    host: harnessLoopbackAuthority(target),
    "x-forwarded-host": request.headers.host ?? "",
    "x-forwarded-for": appendForwardedFor(request.headers["x-forwarded-for"], request.socket.remoteAddress),
    "x-forwarded-port": request.headers["x-forwarded-port"] ?? String(target.port),
    "x-forwarded-proto": request.headers["x-forwarded-proto"] ?? "http",
    "x-forwarded-prefix": "/api/harness",
    ...extra
  };
  const upstreamCookie = stripSpaceCookies(request.headers.cookie);
  if (upstreamCookie) {
    headers.cookie = upstreamCookie;
  } else {
    delete headers.cookie;
  }
  if (forceIdentityEncoding) {
    headers["accept-encoding"] = "identity";
  }
  return headers;
}

function proxyToHarness(
  request: FastifyRequest,
  reply: FastifyReply,
  target: URL,
  pathname: string,
  timeoutMs: number,
  extraHeaders?: Record<string, string | string[] | number | undefined>,
  body?: unknown,
  paneSessionId?: string,
  retryUntil = request.method === "GET" || request.method === "HEAD" ? Date.now() + HARNESS_RESTART_GRACE_MS : 0
): Promise<FastifyReply | void> {
  return new Promise<FastifyReply | void>((resolve) => {
    const isHtmlCandidate =
      Boolean(paneSessionId) ||
      (request.headers.accept?.includes("text/html") ?? false) ||
      (() => {
        const p = pathname.split("?", 1)[0] ?? "";
        return p === "/" || p === "" || p.endsWith(".html") || p.endsWith(".htm");
      })();

    const serializedBody =
      body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
    const isEventStream =
      pathname.startsWith("/plugins/events") ||
      pathname.includes("/events.") ||
      pathname.includes("/events/") ||
      pathname.endsWith("/events") ||
      (typeof request.headers.accept === "string" && request.headers.accept.includes("text/event-stream"));
    const effectiveTimeout = isEventStream ? 0 : timeoutMs;

    const upstream = http.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        method: request.method,
        path: pathname,
        headers: buildUpstreamHeaders(
          request,
          target,
          {
            ...(serializedBody !== undefined ? { "content-length": Buffer.byteLength(serializedBody) } : {}),
            ...extraHeaders
          },
          isHtmlCandidate
        ),
        timeout: effectiveTimeout
      },
      (upstreamResponse) => {
        const contentType = upstreamResponse.headers["content-type"];
        const isHtml =
          typeof contentType === "string" &&
          (contentType.includes("text/html") || contentType.includes("application/xhtml+xml"));

        const responseHeaders: Record<string, string | string[] | number | undefined> = {};
        for (const [name, value] of Object.entries(upstreamResponse.headers)) {
          if (stripHopByHop(name) && value !== undefined) {
            responseHeaders[name] = value;
          }
        }
        responseHeaders["x-frame-options"] = "SAMEORIGIN";
        const staticCacheControl = harnessStaticCacheControl(pathname, request.method);
        if (staticCacheControl && (upstreamResponse.statusCode ?? 200) >= 200 && (upstreamResponse.statusCode ?? 200) < 300) {
          responseHeaders["cache-control"] = staticCacheControl;
        }

        if (isHtml && (request.method === "GET" || request.method === "HEAD")) {
          responseHeaders["cache-control"] = "no-store";
          const chunks: Buffer[] = [];
          upstreamResponse.on("data", (chunk: Buffer) => chunks.push(chunk));
          upstreamResponse.on("end", () => {
            if (reply.sent || reply.raw.headersSent) {
              resolve();
              return;
            }
            try {
              let buffer = Buffer.concat(chunks);
              const encoding = String(upstreamResponse.headers["content-encoding"] ?? "").toLowerCase().trim();
              if (encoding === "gzip") {
                buffer = zlib.gunzipSync(buffer);
              } else if (encoding === "deflate") {
                buffer = zlib.inflateSync(buffer);
              } else if (encoding === "br") {
                buffer = zlib.brotliDecompressSync(buffer);
              }
              delete responseHeaders["content-encoding"];
              delete responseHeaders["content-length"];
              const raw = buffer.toString("utf8");
              const rewritten = request.method === "HEAD" ? "" : rewriteHarnessHtml(raw, paneSessionId);
              resolve(reply.code(upstreamResponse.statusCode ?? 200).headers(responseHeaders).send(rewritten));
            } catch (err) {
              request.log.error(err, "Failed to decompress or rewrite harness HTML response");
              if (!reply.sent && !reply.raw.headersSent) {
                resolve(sendProxyError(reply, 502, "HARNESS_DECODE_FAILED", "Failed to decode Harness HTML response."));
              } else {
                resolve();
              }
            }
          });
          upstreamResponse.on("error", () => {
            if (!reply.sent && !reply.raw.headersSent) {
              resolve(sendProxyError(reply, 502, "HARNESS_UNAVAILABLE", "The Harness upstream is unavailable."));
            } else {
              resolve();
            }
          });
          return;
        }

        if (reply.sent || reply.raw.headersSent) {
          resolve();
          return;
        }
        resolve(reply.code(upstreamResponse.statusCode ?? 502).headers(responseHeaders).send(upstreamResponse));
      }
    );

    upstream.once("timeout", () => {
      upstream.destroy();
      if (!reply.sent && !reply.raw.headersSent) {
        resolve(sendProxyError(reply, 504, "HARNESS_TIMEOUT", "The Harness upstream timed out."));
      } else {
        resolve();
      }
    });
    upstream.once("error", (err: NodeJS.ErrnoException) => {
      // The namespace relay (socat) accepts and then drops the connection while the Harness is down: ECONNRESET.
      if ((err.code === "ECONNREFUSED" || err.code === "ECONNRESET") && Date.now() < retryUntil) {
        setTimeout(() => resolve(proxyToHarness(request, reply, target, pathname, timeoutMs, extraHeaders, body, paneSessionId, retryUntil)),
          HARNESS_RESTART_RETRY_MS);
        return;
      }
      if (!reply.sent && !reply.raw.headersSent) {
        resolve(sendProxyError(reply, 502, "HARNESS_UNAVAILABLE", "The Harness upstream is unavailable."));
      } else {
        resolve();
      }
    });

    if (serializedBody !== undefined) {
      upstream.write(serializedBody);
      upstream.end();
    } else if (request.method === "GET" || request.method === "HEAD") {
      upstream.end();
    } else {
      request.raw.pipe(upstream);
    }
  });
}

function proxyHarnessUpgrade(
  app: FastifyInstance,
  config: SpaceApiConfig,
  request: http.IncomingMessage,
  clientSocket: Duplex,
  head: Buffer
): void {
  if (!config.harnessEnabled) {
    clientSocket.destroy();
    return;
  }
  const target = new URL(config.harnessOrigin);
  const pathname = (request.url ?? "/").replace(/^\/api\/harness/, "");
  const upstreamHeaders: http.OutgoingHttpHeaders = {
    ...Object.fromEntries(
      Object.entries(request.headers)
        .filter(([name, value]) => stripHopByHop(name) && !isSpacePrivateHeader(name) && value !== undefined)
    ),
    host: harnessLoopbackAuthority(target),
    origin: `${target.protocol}//${harnessLoopbackAuthority(target)}`,
    connection: "Upgrade",
    upgrade: "websocket",
    "x-forwarded-host": request.headers.host ?? "",
    "x-forwarded-for": appendForwardedFor(request.headers["x-forwarded-for"], request.socket.remoteAddress),
    "x-forwarded-port": request.headers["x-forwarded-port"] ?? String(target.port),
    "x-forwarded-proto": request.headers["x-forwarded-proto"] ?? "http",
    "x-forwarded-prefix": "/api/harness"
  };
  const upgradeCookie = stripSpaceCookies(request.headers.cookie);
  if (upgradeCookie) {
    upstreamHeaders.cookie = upgradeCookie;
  } else {
    delete upstreamHeaders.cookie;
  }
  const upstream = http.request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port,
    method: "GET",
    path: pathname || "/",
    headers: upstreamHeaders,
  });

  upstream.once("upgrade", (upstreamResponse, upstreamSocket, upstreamHead) => {
    upstream.setTimeout(0);
    const responseHeaders: Record<string, string | string[] | number | undefined> = {};
    for (const [name, value] of Object.entries(upstreamResponse.headers)) {
      if (stripHopByHop(name) && value !== undefined) {
        responseHeaders[name] = value;
      }
    }
    clientSocket.write(
      `HTTP/1.1 101 Switching Protocols\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        Object.entries(responseHeaders)
          .map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join(", ") : String(value)}\r\n`)
          .join("") +
        `\r\n`
    );
    if (Buffer.isBuffer(upstreamHead) && upstreamHead.length > 0) {
      upstreamSocket.unshift(upstreamHead);
    }
    upstreamSocket.pipe(clientSocket);
    clientSocket.pipe(upstreamSocket);
    if (head && head.length > 0) {
      upstreamSocket.write(head);
    }
  });

  upstream.once("error", (err) => {
    app.log.error({ err, path: request.url }, "harness ws upstream error");
    clientSocket.destroy();
  });
  upstream.once("timeout", () => {
    upstream.destroy();
    clientSocket.destroy();
  });
  upstream.setTimeout(config.harnessProxyTimeoutMs);

  upstream.end();
}

type HarnessPaneFields = { cwd?: string | null; roomId?: string; mode?: string; isClosed?: boolean;
  taskMetadata?: { harnessSessionId?: string | null } | null };
export interface HarnessStoreWorkspaceResolver {
  getPane(id: string): Promise<HarnessPaneFields | null> | HarnessPaneFields | null;
  getRoom(id: string): Promise<{ projectPath?: string | null } | null> | { projectPath?: string | null } | null;
}

export interface HarnessRouteOptions {
  /** Decides whether a raw WebSocket upgrade carries a valid Space session. */
  authorizeUpgrade?: (request: http.IncomingMessage) => boolean;
  /** Publishes each loaded Harness pane's tool tokens for its harness session (harness-agent-tokens.ts). */
  agentTokens?: HarnessAgentTokenOptions | null;
}

export function registerHarnessRoutes(
  app: FastifyInstance,
  config: SpaceApiConfig,
  store?: HarnessStoreWorkspaceResolver | null,
  options: HarnessRouteOptions = {}
): void {
  const harnessUpgradeHandler: (request: http.IncomingMessage, socket: Duplex, head: Buffer) => void = (
    request,
    socket,
    head
  ) => {
    proxyHarnessUpgrade(app, config, request, socket, head);
  };

  const originalUpgradeHandlers = app.server.listeners("upgrade");
  app.server.removeAllListeners("upgrade");
  app.server.on("upgrade", (request, socket, head) => {
    if (isHarnessUpgradePath(request.url)) {
      if (options.authorizeUpgrade && !options.authorizeUpgrade(request)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        socket.destroy();
        return;
      }
      harnessUpgradeHandler(request, socket, head);
      return;
    }
    for (const handler of originalUpgradeHandlers) {
      (handler as (req: http.IncomingMessage, s: Duplex, h: Buffer) => void)(request, socket, head);
    }
  });

  app.get("/api/harness/healthz", async (_request, reply) => {
    if (!config.harnessEnabled) {
      return sendProxyError(reply, 404, "HARNESS_DISABLED", "The Harness pane is disabled.");
    }
    const target = new URL(config.harnessOrigin);
    const started = Date.now();
    const result = await new Promise<{ ok: boolean; status: number }>((resolve) => {
      const probe = http.request(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port,
          method: "GET",
          path: "/",
          timeout: config.harnessHealthTimeoutMs
        },
        (probeResponse) => {
          probeResponse.resume();
          const ok = (probeResponse.statusCode ?? 500) >= 200 && (probeResponse.statusCode ?? 500) < 500;
          resolve({ ok, status: probeResponse.statusCode ?? 502 });
        }
      );
      probe.once("timeout", () => probe.destroy());
      probe.once("error", () => resolve({ ok: false, status: 502 }));
      probe.end();
    });
    return {
      ok: result.ok,
      status: result.status,
      checkedAt: new Date().toISOString(),
      durationMs: Date.now() - started
    };
  });

  app.all("/api/harness", async (request, reply) => {
    const queryIndex = request.url.indexOf("?");
    const query = queryIndex >= 0 ? request.url.slice(queryIndex) : "";
    return reply.redirect(`/api/harness/${query}`, 307);
  });

  app.all("/api/harness/*", async (request, reply) => {
    if (!config.harnessEnabled) {
      return sendProxyError(reply, 404, "HARNESS_DISABLED", "The Harness pane is disabled.");
    }
    const target = new URL(config.harnessOrigin);
    const pathname = harnessUpstreamPath(request.url);
    const paneSessionId = request.method === "GET" && (new URL(pathname, target).pathname === "/" || new URL(pathname, target).pathname === "/index.html")
      ? harnessPaneSessionId(request.url)
      : null;
    if (!paneSessionId) {
      return proxyToHarness(request, reply, target, pathname, config.harnessProxyTimeoutMs, undefined, request.body);
    }

    let workspacePath = HARNESS_DEFAULT_WORKSPACE;
    let pane: HarnessPaneFields | null = null;
    const url = new URL(request.url, "http://space.local");
    const rawPaneId = url.searchParams.get("spacePane");
    if (rawPaneId && SPACE_PANE_ID_PATTERN.test(rawPaneId) && store) {
      try {
        pane = await store.getPane(rawPaneId);
        if (pane?.cwd && pane.cwd.startsWith("/") && pane.cwd !== "/etc") {
          workspacePath = pane.cwd;
        } else if (pane?.roomId) {
          const room = await store.getRoom(pane.roomId);
          if (room?.projectPath && room.projectPath.startsWith("/")) {
            workspacePath = room.projectPath;
          }
        }
      } catch {
        // Fall back to default workspace
      }
    }

    try {
      const effectiveSessionId = await ensureHarnessPaneSession(target, paneSessionId, config.harnessProxyTimeoutMs, workspacePath);
      // shortcut: tokens refresh when the pane (re)loads; a Harness pane left open over 12 hours needs a reload
      // for its pane tools, upgrade to a periodic refresh if that bites.
      if (options.agentTokens && rawPaneId && pane?.mode === "HARNESS" && !pane.isClosed && pane.roomId) {
        await publishHarnessAgentTokens(options.agentTokens, { roomId: pane.roomId, paneId: rawPaneId,
          boundSessionId: pane.taskMetadata?.harnessSessionId })
          .catch((err) => app.log.warn({ err, paneId: rawPaneId }, "harness agent tokens were not published"));
      }
      if (!reply.sent) {
        return await proxyToHarness(request, reply, target, pathname, config.harnessProxyTimeoutMs, undefined, undefined, effectiveSessionId);
      }
    } catch {
      if (!reply.sent) {
        return sendProxyError(reply, 502, "HARNESS_PANE_SESSION_UNAVAILABLE", "The Harness pane session is unavailable.");
      }
    }
  });

  app.all("/plugins/*", (request, reply) => {
    if (!requireHarnessSession(request, reply)) {
      return reply;
    }
    if (!config.harnessEnabled) {
      return sendProxyError(reply, 404, "HARNESS_DISABLED", "The Harness pane is disabled.");
    }
    const target = new URL(config.harnessOrigin);
    return proxyToHarness(request, reply, target, request.url, config.harnessProxyTimeoutMs, {
      "x-forwarded-prefix": "/"
    }, request.body);
  });

  for (const pathname of HARNESS_ROOT_HTTP_PATHS) {
    app.all(pathname, (request, reply) => {
      if (!requireHarnessSession(request, reply)) {
        return reply;
      }
      if (!config.harnessEnabled) {
        return sendProxyError(reply, 404, "HARNESS_DISABLED", "The Harness pane is disabled.");
      }
      const target = new URL(config.harnessOrigin);
      return proxyToHarness(request, reply, target, request.url, config.harnessProxyTimeoutMs, {
        "x-forwarded-prefix": "/"
      }, request.body);
    });
  }

  app.all("/api/:method", (request, reply) => {
    if (!config.harnessEnabled) {
      return sendProxyError(reply, 404, "HARNESS_DISABLED", "The Harness pane is disabled.");
    }
    const { method } = request.params as { method: string };
    if (!method.includes(".") || method.startsWith("/") || method.includes("/")) {
      return sendProxyError(reply, 404, "NOT_FOUND", "Unknown route.");
    }
    const target = new URL(config.harnessOrigin);
    const queryIndex = request.url.indexOf("?");
    const query = queryIndex >= 0 ? request.url.slice(queryIndex) : "";
    return proxyToHarness(request, reply, target, `/api/${method}${query}`, config.harnessProxyTimeoutMs, {
      "x-forwarded-prefix": "/api"
    }, request.body);
  });
}
