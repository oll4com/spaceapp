import { api } from "../live-api.js";
import type { PlatformGateway, SpaceRuntime } from "../runtime/SpaceRuntime.js";

function requiredStorage(kind: "localStorage" | "sessionStorage"): Storage {
  return window[kind];
}

const platform: PlatformGateway = {
  get localStorage() {
    return requiredStorage("localStorage");
  },
  get sessionStorage() {
    return requiredStorage("sessionStorage");
  },
  get clipboard() {
    return navigator.clipboard ?? null;
  },
  get userMediaSupported() {
    return typeof navigator.mediaDevices?.getUserMedia === "function";
  },
  get peerConnectionSupported() {
    return typeof window.RTCPeerConnection === "function";
  },
  get displayMediaSupported() {
    return typeof navigator.mediaDevices?.getDisplayMedia === "function";
  },
  resolveExternalResource: (url) => url,
  fetch: (input, init) => window.fetch(input, init),
  openLink: (url, target, features) => window.open(url, target, features),
  print: () => window.print(),
  reloadPage: () => window.location.reload(),
  getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
  createPeerConnection: (configuration) => new window.RTCPeerConnection(configuration),
  getDisplayMedia: (constraints) => {
    const getDisplayMedia = navigator.mediaDevices?.getDisplayMedia;
    if (!getDisplayMedia) return Promise.reject(new DOMException("Display capture is unavailable.", "NotSupportedError"));
    return getDisplayMedia.call(navigator.mediaDevices, constraints);
  },
  createAudio: () => new Audio()
};

export const liveRuntime: SpaceRuntime = {
  kind: "live",
  api,
  events: {
    get supported() {
      return typeof window.EventSource !== "undefined";
    },
    open: (url, init) => new window.EventSource(url, init)
  },
  terminal: {
    get supported() {
      return typeof window.WebSocket !== "undefined";
    },
    connect: (url) => new window.WebSocket(url)
  },
  browser: {
    get supported() {
      return typeof window.WebSocket !== "undefined";
    },
    connect: (url) => new window.WebSocket(url)
  },
  platform,
  reset() {}
};
