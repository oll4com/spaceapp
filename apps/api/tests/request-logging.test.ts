import { expect, it } from "vitest";
import { redactRequestUrlForLog } from "../src/request-logging.js";

it.each([
  ["/api/links?q=private-title&APIKey=private-key", "/api/links?q=%5BREDACTED%5D&APIKey=%5BREDACTED%5D"],
  ["/api/memory/search?query=private-memory&prompt=private-prompt", "/api/memory/search?query=%5BREDACTED%5D&prompt=%5BREDACTED%5D"],
  ["/api/auth/callback?accessToken=private-token&apiKey=private-key&safe=1", "/api/auth/callback?accessToken=%5BREDACTED%5D&apiKey=%5BREDACTED%5D&safe=1"],
  ["/api/clipboard-items/?q=private-prompt&source=COPY", "/api/clipboard-items/?q=%5BREDACTED%5D&source=COPY"],
  ["/api/auth/callback#access_token=private-token", "/api/auth/callback"],
  ["http://[invalid?token=private-token", "[INVALID_REQUEST_URL]"]
])("does not log secrets or private search text from %s", (input, expected) => {
  expect(redactRequestUrlForLog(input)).toBe(expected);
});

