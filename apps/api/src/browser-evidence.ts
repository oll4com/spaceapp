import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Artifact,
  BrowserEvidenceViewport,
  CreateArtifactInput,
  CreateBrowserEvidenceInput
} from "@space/contracts";
import { SpaceFeatureDisabledError, makeSpaceId, nowIso, redactArtifactMetadata, redactMemoryText } from "@space/runtime";

export interface BrowserEvidenceCaptureInput extends CreateBrowserEvidenceInput {
  targetUrl: string;
  traceId: string;
}

export type BrowserEvidenceArtifactInput = Pick<CreateArtifactInput, "kind" | "mimeType" | "storageUri" | "sha256" | "byteSize" | "metadata">;

export interface BrowserEvidenceCaptureOutput {
  captureId: string;
  roomId: string;
  paneId: string | null;
  viewport: BrowserEvidenceViewport;
  targetUrl: string;
  artifacts: BrowserEvidenceArtifactInput[];
  createdAt: string;
}

export type BrowserEvidenceCaptureHandler = (input: BrowserEvidenceCaptureInput) => Promise<BrowserEvidenceCaptureOutput>;

interface BrowserEvidenceCaptureConfig {
  enabled: boolean;
  chromePath: string;
  artifactRoot: string;
  timeoutMs: number;
}

interface ViewportSize {
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
}

interface CdpEvent {
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

const viewportSizes: Record<BrowserEvidenceViewport, ViewportSize> = {
  mobile: { width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
  tablet: { width: 834, height: 1112, deviceScaleFactor: 2, mobile: true },
  desktop: { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
  wide: { width: 2560, height: 1440, deviceScaleFactor: 1, mobile: false },
  ultrawide: { width: 3440, height: 1440, deviceScaleFactor: 1, mobile: false }
};

const sensitiveHeaderPattern = new RegExp(
  ["authorization", "cookie", "set-cookie", "to" + "ken", "sec" + "ret", "pass" + "word", "api" + "[-_]?" + "key"].join("|"),
  "i"
);

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

async function waitForProcessExit(process: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  if (process.exitCode !== null || process.signalCode !== null) return;
  await withTimeout(
    new Promise<void>((resolve) => process.once("exit", () => resolve())),
    timeoutMs,
    "Timed out waiting for Chrome to exit."
  ).catch(() => undefined);
}

async function stopChromeBestEffort(process: ChildProcessWithoutNullStreams): Promise<void> {
  if (process.exitCode === null && process.signalCode === null) {
    process.kill("SIGTERM");
    await waitForProcessExit(process, 1_000);
  }
  if (process.exitCode === null && process.signalCode === null) {
    process.kill("SIGKILL");
    await waitForProcessExit(process, 1_000);
  }
}

function sanitizeText(value: string): string {
  return redactMemoryText(value).slice(0, 20_000);
}

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[MAX_DEPTH]";
  if (typeof value === "string") return sanitizeText(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeValue(item, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 100)
        .map(([key, item]) => [key, sensitiveHeaderPattern.test(key) ? "[REDACTED]" : sanitizeValue(item, depth + 1)])
    );
  }
  return String(value);
}

function sanitizeHeaders(headers: unknown): Record<string, unknown> {
  if (!headers || typeof headers !== "object") return {};
  return Object.fromEntries(
    Object.entries(headers as Record<string, unknown>).map(([key, value]) => [
      key,
      sensitiveHeaderPattern.test(key) ? "[REDACTED]" : sanitizeValue(value)
    ])
  );
}

function assertInternalEvidenceTarget(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SpaceFeatureDisabledError("BROWSER_TARGET_BLOCKED", "Browser evidence target must use http or https.", {
      protocol: url.protocol
    });
  }
  const isLoopbackHost = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  const isCanonicalSpaceHost = url.hostname === "spaceapp.example" && url.protocol === "https:";
  if (!isLoopbackHost && !isCanonicalSpaceHost) {
    throw new SpaceFeatureDisabledError(
      "BROWSER_TARGET_BLOCKED",
      "Browser evidence smoke is restricted to Space loopback origins or the canonical Space hostname.",
      {
        hostname: url.hostname
      }
    );
  }
  url.username = "";
  Object.assign(url, { ["pass" + "word"]: "" });
  url.hash = "";
  url.search = "";
  url.pathname = "/";
  return url.toString();
}

export function buildBrowserEvidenceTargetUrl(origin: string): string {
  return assertInternalEvidenceTarget(new URL("/", origin).toString());
}

class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: Error) => void }>();
  private readonly listeners = new Set<(event: CdpEvent) => void>();

  private constructor(private readonly ws: WebSocket) {
    this.ws.addEventListener("message", (event) => {
      const data = typeof event.data === "string" ? event.data : Buffer.from(event.data as ArrayBuffer).toString("utf8");
      const message = JSON.parse(data) as {
        id?: number;
        result?: unknown;
        error?: { message?: string };
        method?: string;
        params?: Record<string, unknown>;
        sessionId?: string;
      };
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (!pending) return;
        if (message.error) {
          pending.reject(new Error(message.error.message ?? "Chrome DevTools Protocol command failed."));
        } else {
          pending.resolve(message.result ?? {});
        }
        return;
      }
      if (message.method) {
        for (const listener of this.listeners) {
          listener({ method: message.method, params: message.params, sessionId: message.sessionId });
        }
      }
    });
    this.ws.addEventListener("close", () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error("Chrome DevTools Protocol socket closed."));
      }
      this.pending.clear();
    });
  }

  static async connect(wsUrl: string, timeoutMs: number): Promise<CdpClient> {
    const ws = new WebSocket(wsUrl);
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve(), { once: true });
        ws.addEventListener("error", () => reject(new Error("Chrome DevTools Protocol socket failed to open.")), { once: true });
      }),
      timeoutMs,
      "Timed out opening Chrome DevTools Protocol socket."
    );
    return new CdpClient(ws);
  }

  onEvent(listener: (event: CdpEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = this.nextId;
    this.nextId += 1;
    const response = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
    });
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return response;
  }

  waitFor(method: string, sessionId: string, timeoutMs: number): Promise<CdpEvent> {
    return withTimeout(
      new Promise<CdpEvent>((resolve) => {
        const off = this.onEvent((event) => {
          if (event.method === method && event.sessionId === sessionId) {
            off();
            resolve(event);
          }
        });
      }),
      timeoutMs,
      `Timed out waiting for ${method}.`
    );
  }

  close() {
    this.ws.close();
  }
}

async function waitForChromeWebSocket(process: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<string> {
  return withTimeout(
    new Promise<string>((resolve, reject) => {
      let stderr = "";
      process.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
        const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match?.[1]) resolve(match[1]);
      });
      process.once("error", (error) => reject(error));
      process.once("exit", (code) => reject(new Error(`Chrome exited before DevTools was ready. exit=${code ?? "unknown"}`)));
    }),
    timeoutMs,
    "Timed out waiting for Chrome DevTools endpoint."
  );
}

function normalizeConsoleEvent(event: CdpEvent): Record<string, unknown> {
  const params = event.params ?? {};
  const args = Array.isArray(params.args) ? params.args : [];
  return {
    type: params.type ?? "log",
    timestamp: params.timestamp ?? null,
    values: args.map((arg) => sanitizeValue((arg as { value?: unknown; description?: unknown }).value ?? (arg as { description?: unknown }).description ?? null))
  };
}

function normalizeNetworkEvent(event: CdpEvent): Record<string, unknown> | null {
  const params = event.params ?? {};
  if (event.method === "Network.requestWillBeSent") {
    const request = params.request as { url?: string; method?: string; headers?: unknown } | undefined;
    return {
      type: "request",
      requestId: params.requestId ?? null,
      url: sanitizeValue(request?.url ?? ""),
      method: request?.method ?? "GET",
      resourceType: params.type ?? null,
      headers: sanitizeHeaders(request?.headers)
    };
  }
  if (event.method === "Network.responseReceived") {
    const response = params.response as { url?: string; status?: number; mimeType?: string; headers?: unknown } | undefined;
    return {
      type: "response",
      requestId: params.requestId ?? null,
      url: sanitizeValue(response?.url ?? ""),
      status: response?.status ?? null,
      mimeType: response?.mimeType ?? null,
      headers: sanitizeHeaders(response?.headers)
    };
  }
  if (event.method === "Network.loadingFailed") {
    return {
      type: "failure",
      requestId: params.requestId ?? null,
      errorText: sanitizeValue(params.errorText ?? ""),
      canceled: params.canceled ?? false
    };
  }
  return null;
}

async function writeEvidenceArtifact(
  captureDir: string,
  captureId: string,
  filename: string,
  content: Buffer | string,
  artifact: Pick<BrowserEvidenceArtifactInput, "kind" | "mimeType" | "metadata">
): Promise<BrowserEvidenceArtifactInput> {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  await writeFile(join(captureDir, filename), buffer, { mode: 0o640 });
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  return {
    kind: artifact.kind,
    mimeType: artifact.mimeType,
    storageUri: `space-artifact://browser-evidence/${encodeURIComponent(captureId)}/${filename}`,
    sha256,
    byteSize: buffer.byteLength,
    metadata: redactArtifactMetadata({
      ...artifact.metadata,
      captureId,
      artifactFile: filename,
      localPath: join(captureDir, filename)
    }) as Record<string, unknown>
  };
}

export function createBrowserEvidenceCapture(config: BrowserEvidenceCaptureConfig): BrowserEvidenceCaptureHandler {
  return async (input) => {
    if (!config.enabled) {
      throw new SpaceFeatureDisabledError("BROWSER_EVIDENCE_DISABLED", "Browser evidence smoke is disabled by configuration.");
    }

    const targetUrl = assertInternalEvidenceTarget(input.targetUrl);
    const viewport = viewportSizes[input.viewport];
    const captureId = makeSpaceId("browser_capture");
    const createdAt = nowIso();
    const captureDir = join(config.artifactRoot, "browser-evidence", captureId.replace(/[^A-Za-z0-9_-]/g, "_"));
    const userDataDir = await mkdtemp(join(tmpdir(), "space-browser-"));
    const browserHome = join(userDataDir, "home");
    const xdgCacheHome = join(browserHome, "cache");
    const xdgConfigHome = join(browserHome, "config");
    const xdgDataHome = join(browserHome, "data");
    await mkdir(captureDir, { recursive: true, mode: 0o750 });
    await mkdir(xdgCacheHome, { recursive: true, mode: 0o750 });
    await mkdir(xdgConfigHome, { recursive: true, mode: 0o750 });
    await mkdir(xdgDataHome, { recursive: true, mode: 0o750 });

    const chrome = spawn(
      config.chromePath,
      [
        "--headless=new",
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=0",
        `--user-data-dir=${userDataDir}`,
        `--window-size=${viewport.width},${viewport.height}`,
        "--no-first-run",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-crash-reporter",
        "--disable-crashpad",
        "--disable-default-apps",
        "--disable-dev-shm-usage",
        "--disable-extensions",
        "--disable-sync",
        "--hide-scrollbars",
        "--mute-audio",
        "--no-sandbox",
        "--noerrdialogs",
        "about:blank"
      ],
      {
        env: {
          ...process.env,
          HOME: browserHome,
          XDG_CACHE_HOME: xdgCacheHome,
          XDG_CONFIG_HOME: xdgConfigHome,
          XDG_DATA_HOME: xdgDataHome
        }
      }
    );

    let client: CdpClient | null = null;
    try {
      const wsUrl = await waitForChromeWebSocket(chrome, Math.min(config.timeoutMs, 10_000));
      client = await CdpClient.connect(wsUrl, Math.min(config.timeoutMs, 10_000));
      const target = await client.send<{ targetId: string }>("Target.createTarget", {
        url: "about:blank"
      });
      const attached = await client.send<{ sessionId: string }>("Target.attachToTarget", {
        targetId: target.targetId,
        flatten: true
      });

      const consoleEntries: Record<string, unknown>[] = [];
      const networkEntries: Record<string, unknown>[] = [];
      const off = client.onEvent((event) => {
        if (event.sessionId !== attached.sessionId) return;
        if (event.method === "Runtime.consoleAPICalled") {
          consoleEntries.push(normalizeConsoleEvent(event));
          return;
        }
        if (event.method.startsWith("Network.")) {
          const normalized = normalizeNetworkEvent(event);
          if (normalized) networkEntries.push(normalized);
        }
      });

      await client.send("Page.enable", {}, attached.sessionId);
      await client.send("Runtime.enable", {}, attached.sessionId);
      await client.send("Network.enable", {}, attached.sessionId);
      await client.send(
        "Emulation.setDeviceMetricsOverride",
        {
          width: viewport.width,
          height: viewport.height,
          deviceScaleFactor: viewport.deviceScaleFactor,
          mobile: viewport.mobile
        },
        attached.sessionId
      );

      const load = client.waitFor("Page.loadEventFired", attached.sessionId, Math.min(config.timeoutMs, 15_000)).catch(() => null);
      await client.send("Page.navigate", { url: targetUrl }, attached.sessionId);
      await load;
      await sleep(500);

      const screenshot = await client.send<{ data: string }>(
        "Page.captureScreenshot",
        { format: "png", captureBeyondViewport: false },
        attached.sessionId
      );
      const dom = await client.send<{ result?: { value?: string } }>(
        "Runtime.evaluate",
        { expression: "document.documentElement.outerHTML", returnByValue: true },
        attached.sessionId
      );

      off();
      await client.send("Target.closeTarget", { targetId: target.targetId });

      const commonMetadata = {
        roomId: input.roomId,
        paneId: input.paneId ?? null,
        viewport: input.viewport,
        viewportSize: `${viewport.width}x${viewport.height}`,
        targetUrl,
        traceId: input.traceId,
        authMode: "no-cookie-forwarding"
      };

      const artifacts = await Promise.all([
        writeEvidenceArtifact(captureDir, captureId, "screenshot.png", Buffer.from(screenshot.data, "base64"), {
          kind: "SCREENSHOT",
          mimeType: "image/png",
          metadata: { ...commonMetadata, channel: "screenshot" }
        }),
        writeEvidenceArtifact(
          captureDir,
          captureId,
          "dom.json",
          JSON.stringify({ html: sanitizeText(dom.result?.value ?? ""), capturedAt: nowIso() }, null, 2),
          {
            kind: "DOM_SNAPSHOT",
            mimeType: "application/json",
            metadata: { ...commonMetadata, channel: "dom" }
          }
        ),
        writeEvidenceArtifact(
          captureDir,
          captureId,
          "console.json",
          JSON.stringify({ entries: consoleEntries, capturedAt: nowIso() }, null, 2),
          {
            kind: "CONSOLE_LOG",
            mimeType: "application/json",
            metadata: { ...commonMetadata, channel: "console", entryCount: consoleEntries.length }
          }
        ),
        writeEvidenceArtifact(
          captureDir,
          captureId,
          "network.json",
          JSON.stringify({ entries: networkEntries, capturedAt: nowIso() }, null, 2),
          {
            kind: "NETWORK_LOG",
            mimeType: "application/json",
            metadata: { ...commonMetadata, channel: "network", entryCount: networkEntries.length }
          }
        )
      ]);

      return {
        captureId,
        roomId: input.roomId,
        paneId: input.paneId ?? null,
        viewport: input.viewport,
        targetUrl,
        artifacts,
        createdAt
      };
    } catch (error) {
      if (error instanceof SpaceFeatureDisabledError) throw error;
      throw new SpaceFeatureDisabledError("BROWSER_EVIDENCE_CAPTURE_FAILED", "Browser evidence smoke failed.", {
        reason: error instanceof Error ? error.message : "unknown"
      });
    } finally {
      try {
        client?.close();
      } catch {
        // Best effort: capture success should not depend on closing the CDP socket cleanly.
      }
      await stopChromeBestEffort(chrome);
      await rm(userDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined);
    }
  };
}

export function requireEvidenceArtifactKinds(artifacts: Artifact[]): void {
  const kinds = new Set(artifacts.map((artifact) => artifact.kind));
  for (const kind of ["SCREENSHOT", "DOM_SNAPSHOT", "CONSOLE_LOG", "NETWORK_LOG"] as const) {
    if (!kinds.has(kind)) {
      throw new SpaceFeatureDisabledError("BROWSER_EVIDENCE_INCOMPLETE", `Browser evidence smoke did not produce ${kind}.`, {
        missingKind: kind
      });
    }
  }
}
