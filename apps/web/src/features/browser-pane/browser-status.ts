import { api, type BrowserStatusPayload } from "../../api.js";

let browserStatusRequest: Promise<BrowserStatusPayload> | null = null;

export function loadSharedBrowserStatus(): Promise<BrowserStatusPayload> {
  if (browserStatusRequest) return browserStatusRequest;

  const request = api.browserStatus();
  browserStatusRequest = request;
  void request.then(
    () => {
      if (browserStatusRequest === request) browserStatusRequest = null;
    },
    () => {
      if (browserStatusRequest === request) browserStatusRequest = null;
    }
  );
  return request;
}
