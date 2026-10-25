import { describe, expect, it } from "vitest";
import { browserNavigateInputSchema } from "@space/contracts";
import { resolveBrowserAddress } from "../src/features/browser-pane/browser-address.js";

describe("browser address bar", () => {
  it.each([
    ["google.com", "https://google.com/"],
    ["  www.google.com  ", "https://www.google.com/"],
    ["example.com/docs?q=one#two", "https://example.com/docs?q=one#two"],
    ["spaceapp.example:4911/browser-live-proof.html", "https://spaceapp.example:4911/browser-live-proof.html"],
    ["http://example.com/path", "http://example.com/path"],
    ["//example.com/path", "https://example.com/path"],
    ["example.com/a b", "https://example.com/a%20b"],
    ["about:blank", "about:blank"],
    ["Space browser test", "https://www.google.com/search?q=Space%20browser%20test"],
    ["δοκιμή browser", "https://www.google.com/search?q=%CE%B4%CE%BF%CE%BA%CE%B9%CE%BC%CE%AE%20browser"]
  ])("submits %s as a valid API URL", (input, expected) => {
    const url = resolveBrowserAddress(input);
    expect(url).toBe(expected);
    expect(browserNavigateInputSchema.safeParse({ url }).success).toBe(true);
  });

  it.each(["", "https://", "javascript:alert(1)", "data:text/html,test", "file:///etc/passwd", "about:config", "https://user:pass@example.com/"])("rejects %s before sending a browser request", (input) => {
    expect(() => resolveBrowserAddress(input)).toThrow();
  });
});
