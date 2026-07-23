import { createContext, useContext, type ReactNode } from "react";

export const DEMO_LOCAL_REPLY = "Demo mode: this input was handled locally. No agent, process, browser host, or production service was contacted.";

export type SpaceApiClient = typeof import("../live-api.js").api;

export class SpaceApiError extends Error {
  readonly code?: string;
  readonly status: number;
  readonly requestId?: string;
  readonly details?: unknown;

  constructor(message: string, input: { code?: string; status: number; requestId?: string; details?: unknown }) {
    super(message);
    this.name = "SpaceApiError";
    this.code = input.code;
    this.status = input.status;
    this.requestId = input.requestId;
    this.details = input.details;
  }
}

export interface SpaceEventGateway {
  readonly supported: boolean;
  open(url: string, init?: EventSourceInit): EventSource;
}

export interface SpaceSocketGateway {
  readonly supported: boolean;
  connect(url: string): WebSocket;
}

export interface PlatformGateway {
  readonly localStorage: Storage;
  readonly sessionStorage: Storage;
  readonly clipboard: Pick<Clipboard, "read" | "readText" | "write" | "writeText"> | null;
  readonly userMediaSupported: boolean;
  readonly peerConnectionSupported: boolean;
  readonly displayMediaSupported: boolean;
  resolveExternalResource(url: string): string | null;
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  openLink(url: string, target?: string, features?: string): Window | null;
  print(): void;
  reloadPage(): void;
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  createPeerConnection(configuration?: RTCConfiguration): RTCPeerConnection;
  getDisplayMedia(constraints?: DisplayMediaStreamOptions): Promise<MediaStream>;
  createAudio(): HTMLAudioElement;
}

export interface SpaceRuntime {
  readonly kind: "live" | "demo";
  readonly api: SpaceApiClient;
  readonly events: SpaceEventGateway;
  readonly terminal: SpaceSocketGateway;
  readonly browser: SpaceSocketGateway;
  readonly platform: PlatformGateway;
  reset(): void;
}

let installedRuntime: SpaceRuntime | null = null;
const SpaceRuntimeContext = createContext<SpaceRuntime | null>(null);

export function installSpaceRuntime(runtime: SpaceRuntime): void {
  installedRuntime = runtime;
}

export function getSpaceRuntime(): SpaceRuntime {
  if (!installedRuntime) throw new Error("SpaceRuntimeProvider is required before using Space runtime services.");
  return installedRuntime;
}

export function getSpaceRuntimeKind(): SpaceRuntime["kind"] {
  return getSpaceRuntime().kind;
}

export function resolveExternalResource(url: string): string | null {
  return getSpaceRuntime().platform.resolveExternalResource(url);
}

const apiDispatchers = new Map<PropertyKey, (...args: unknown[]) => unknown>();

export const api = new Proxy({} as SpaceApiClient, {
  get(_target, property) {
    const client = getSpaceRuntime().api as unknown as Record<PropertyKey, unknown>;
    const value = client[property];
    if (typeof value !== "function") return value;

    let dispatcher = apiDispatchers.get(property);
    if (!dispatcher) {
      dispatcher = (...args: unknown[]) => {
        const activeClient = getSpaceRuntime().api as unknown as Record<PropertyKey, unknown>;
        const method = activeClient[property];
        if (typeof method !== "function") {
          throw new TypeError(`Space API property ${String(property)} is not callable.`);
        }
        return Reflect.apply(method, activeClient, args) as unknown;
      };
      apiDispatchers.set(property, dispatcher);
    }
    return dispatcher;
  }
});

export const eventGateway: SpaceEventGateway = {
  get supported() {
    return getSpaceRuntime().events.supported;
  },
  open: (url, init) => getSpaceRuntime().events.open(url, init)
};

export const terminalGateway: SpaceSocketGateway = {
  get supported() {
    return getSpaceRuntime().terminal.supported;
  },
  connect: (url) => getSpaceRuntime().terminal.connect(url)
};

export const browserGateway: SpaceSocketGateway = {
  get supported() {
    return getSpaceRuntime().browser.supported;
  },
  connect: (url) => getSpaceRuntime().browser.connect(url)
};

export function SpaceRuntimeProvider({ runtime, children }: { runtime: SpaceRuntime; children: ReactNode }) {
  installSpaceRuntime(runtime);
  return <SpaceRuntimeContext.Provider value={runtime}>{children}</SpaceRuntimeContext.Provider>;
}

export function useSpaceRuntime(): SpaceRuntime {
  const runtime = useContext(SpaceRuntimeContext);
  if (!runtime) throw new Error("SpaceRuntimeProvider is required.");
  return runtime;
}
