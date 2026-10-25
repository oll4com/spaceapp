import { describe, expect, it, vi } from "vitest";
import { CLIENT_ERROR_REPORT_LIMIT, clientErrorReport, installClientErrorReporter } from "../src/client-error-reporter.js";

const origin = "https://space.example";

function errorWithStack(name: string, message: string, stack: string) {
  const error = new Error(message);
  error.name = name;
  error.stack = stack;
  return error;
}

describe("client error reports", () => {
  it("keep only the error name and same-origin bundle locations", () => {
    const error = errorWithStack("TypeError", "secret pasted text", [
      "TypeError: secret pasted text",
      "    at render (https://space.example/assets/index-Ab12.js:10:4)",
      "    at https://cdn.other.example/lib.js?token=abc:3:9",
      "    at chrome-extension://abc/x.js:1:1"
    ].join("\n"));
    const report = clientErrorReport("error", error, origin);
    expect(report).toEqual({
      kind: "error",
      name: "TypeError",
      locations: [{ file: "/assets/index-Ab12.js", line: 10, column: 4 }, { file: "/external", line: 3, column: 9 }],
      repeats: 1
    });
    expect(JSON.stringify(report)).not.toMatch(/secret|token|cdn\.other/);
  });

  it("replace unsafe names and non-errors", () => {
    expect(clientErrorReport("rejection", "plain string reason", origin).name).toBe("UnhandledRejection");
    expect(clientErrorReport("error", errorWithStack("Error: with message", "", ""), origin).name).toBe("Error");
  });

  it("are sent once per distinct error and at most the page limit", async () => {
    const target = new EventTarget();
    const send = vi.fn().mockResolvedValue(null);
    const uninstall = installClientErrorReporter({ send, target: target as unknown as Window, origin });
    const fire = (line: number) => target.dispatchEvent(new ErrorEvent("error", {
      error: errorWithStack("TypeError", "x", ""), filename: `${origin}/assets/a.js`, lineno: line, colno: 1
    }));
    fire(1);
    fire(1);
    for (let line = 2; line <= CLIENT_ERROR_REPORT_LIMIT + 5; line += 1) fire(line);
    target.dispatchEvent(new Event("error"));
    expect(send).toHaveBeenCalledTimes(CLIENT_ERROR_REPORT_LIMIT);
    expect(send.mock.calls[0]![0]).toMatchObject({ kind: "error", name: "TypeError", locations: [{ file: "/assets/a.js", line: 1, column: 1 }] });
    uninstall();
    fire(999);
    expect(send).toHaveBeenCalledTimes(CLIENT_ERROR_REPORT_LIMIT);
  });

  it("never throw when sending fails", async () => {
    const target = new EventTarget();
    const send = vi.fn().mockRejectedValue(new Error("offline"));
    installClientErrorReporter({ send, target: target as unknown as Window, origin });
    const event = new Event("unhandledrejection") as Event & { reason?: unknown };
    event.reason = new Error("boom");
    target.dispatchEvent(event);
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(1);
  });
});
