import { describe, expect, it } from "vitest";
import {
  CLI_UPLOAD_WRAPPED_PATH_PATTERN,
  hiddenEchoCandidates,
  maskUploadPaths,
  plainTextHiddenEchoCandidates
} from "../src/features/terminal-pane/TerminalPane.js";

describe("terminal hidden echo candidate filtering", () => {
  it("handles large whitespace and incomplete attachment paths without backtracking stalls", () => {
    const whitespace = " \t\r\n".repeat(5_000);
    expect((whitespace + "agent output").replace(CLI_UPLOAD_WRAPPED_PATH_PATTERN, "")).toBe(whitespace + "agent output");
    const incomplete = "/cli-uploads/room/" + " \r\n \t".repeat(5_000) + "missing_extension";
    expect(incomplete.replace(CLI_UPLOAD_WRAPPED_PATH_PATTERN, "")).toBe(incomplete);
  });

  it("labels an upload under any artifacts root, a bare /cli-uploads/ path and a path glued to a word at the path start", () => {
    // The upload root differs per install: /opt/spaceapp/var/artifacts (stable), /var/lib/spaceapp/artifacts (public).
    for (const root of ["/opt/spaceapp/var/artifacts", "/var/lib/spaceapp/artifacts", ""]) {
      const input = `prompt ${root}/cli-uploads/upload_abcdefghijkl-photo.png and more`;
      const masked = maskUploadPaths(input);
      expect(masked.startsWith("prompt [upload: photo.png]"), root || "bare").toBe(true);
      expect(masked).toHaveLength(input.length);
      expect(masked.endsWith("and more")).toBe(true);
    }
    const glued = "word/var/lib/spaceapp/artifacts/cli-uploads/upload_abcdefghijkl-photo.png done";
    const maskedGlued = maskUploadPaths(glued);
    expect(maskedGlued.startsWith("word[upload: photo.png]")).toBe(true);
    expect(maskedGlued).toHaveLength(glued.length);
  });

  it("never shows an artifacts root with a dotted folder in clear (accepted limit: the label follows blanks)", () => {
    const input = "prompt /home/a.b/artifacts/cli-uploads/upload_abcdefghijkl-photo.png and more";
    const masked = maskUploadPaths(input);
    expect(masked).toHaveLength(input.length);
    expect(masked).not.toContain("/home");
    expect(masked).not.toContain("a.b");
    expect(masked).toMatch(/^prompt +\[upload: photo\.png\] *and more$/);
  });

  it("masks in linear time: 64 KB of PTY padding, and 64 KB of path segments with no artifacts root", () => {
    for (const input of [" ".repeat(65_536) + "\r\n/cli-uploads/x.png", "/a".repeat(32_768) + "/cli-uploads/x.png"]) {
      // Best of three: a loaded host can stall one run, a quadratic pattern takes seconds in every run.
      const runs = Array.from({ length: 3 }, () => {
        const started = performance.now();
        maskUploadPaths(input);
        return performance.now() - started;
      });
      expect(Math.min(...runs)).toBeLessThan(50);
    }
  });

  it("registers plain-text secrets and attachment paths as echo candidates", () => {
    expect(plainTextHiddenEchoCandidates("super-secret-token-12345")).toEqual([
      "super-secret-token-12345"
    ]);
    const bracketedPath = "\u001b[200~/opt/spaceapp/var/artifacts/cli-uploads/abc.png\u001b[201~";
    expect(plainTextHiddenEchoCandidates(bracketedPath)).toEqual([
      "/opt/spaceapp/var/artifacts/cli-uploads/abc.png"
    ]);
  });

  it("drops control-character protocol replies so chunked TUI output keeps its ESC bytes", () => {
    for (const reply of ["\u001b[1;1R", "\u001b]11;rgb:0000/0000/0000\u001b\\", "\u001b[?1;2c"]) {
      expect(plainTextHiddenEchoCandidates(reply)).toEqual([]);
    }
  });

  it("keeps the unfiltered candidate list unchanged for protocol replies", () => {
    expect(hiddenEchoCandidates("\u001b[1;1R")).toEqual(["\u001b[1;1R"]);
  });

  const controls = /\x1b\[[0-9;?]*[ -/]*[@-~]|\r|\n/g;
  const expectLayoutPreserved = (masked: string, original: string) => {
    expect(masked).not.toContain("/cli-uploads/");
    expect(masked.match(controls)).toEqual(original.match(controls));
    expect(masked.replace(controls, "").length).toBe(original.replace(controls, "").length);
  };

  it("masks wrapped upload paths in terminal prompt output without changing rows or cells", () => {
    const wrappedOutput =
      "> [Image #1]  βλεπεις την φωτο? ειναι για δοκιμη! [Image #2]\r\n" +
      "/opt/spaceapp/var/artifacts/cli-uploads/room_cth7FrwQusSi/pane_yBvi6Mi0\r\n" +
      "laxc/cli_session_JMEkpt9ZCuYM/2026-09-13/upload_zul3XQfR5A4U-clipboa\r\n" +
      "rd-image-1.png\r\n" +
      "/opt/spaceapp/var/artifacts/cli-uploads/room_cth7FrwQusSi/pane_yBvi6Mi0\r\n" +
      "laxc/cli_session_JMEkpt9ZCuYM/2026-09-13/upload_vqfU0wNj7EQz-clipboa\r\n" +
      "rd-image-1.png\r\n" +
      "agent response begins";
    const masked = maskUploadPaths(wrappedOutput);
    expectLayoutPreserved(masked, wrappedOutput);
    const rows = masked.split("\r\n");
    expect(rows[0]).toBe("> [Image #1]  βλεπεις την φωτο? ειναι για δοκιμη! [Image #2]");
    expect(rows[1]).toBe("[upload: clipboard-image-1.png]".padEnd(rows[1]!.length, " "));
    expect(rows[2]!.trim()).toBe("");
    expect(rows[4]).toBe("[upload: clipboard-image-1.png]".padEnd(rows[4]!.length, " "));
    expect(rows.at(-1)).toBe("agent response begins");
  });

  it("never drops output that follows an upload directory without a file extension", () => {
    const frame =
      "\x1b[10A\x1b[38;2;153;153;153m● Bash(ls -la /opt/spaceapp/var/artifacts/cli-uploads/room_x/)\x1b[39m\x1b[K\r" +
      "\x1b[1B  ⎿  total 123648\x1b[K\r\x1b[2B●\x1b[3GDONE\x1b[K\r";
    expect(maskUploadPaths(frame)).toBe(frame);
    const incompleteChunk = "> [Image #1] test\r\n/opt/spaceapp/var/artifacts/cli-uploads/room_1/pane_1/session_1/upload_";
    expect(maskUploadPaths(incompleteChunk)).toBe(incompleteChunk);
  });

  it("masks wrapped upload paths containing ANSI escape codes and indentation", () => {
    const ansiWrappedOutput =
      "> [Image #1] test\x1b[0m\r\n" +
      "\x1b[38;2;120;120;120m/opt/spaceapp/var/artifacts/cli-uploads/room_cth7FrwQusSi/pane_yBvi6Mi0\x1b[0m\r\n" +
      "  laxc/cli_session_JMEkpt9ZCuYM/2026-09-13/upload_c1bKAWSahnJK-clipboa\r\n" +
      "  rd-image-1.png\x1b[0m\r\n" +
      "\r\n" +
      "L Interrupted • What should Antigravity CLI do instead?\r\n" +
      "> ";
    const masked = maskUploadPaths(ansiWrappedOutput);
    expectLayoutPreserved(masked, ansiWrappedOutput);
    expect(masked).toContain("\x1b[38;2;120;120;120m[upload: clipboard-image-1.png]");
    expect(masked.endsWith("\r\n\r\nL Interrupted • What should Antigravity CLI do instead?\r\n> ")).toBe(true);
    expect(maskUploadPaths(masked)).toBe(masked);
  });

  it("masks upload paths with leading and trailing whitespace in place", () => {
    const path = "/opt/spaceapp/var/artifacts/cli-uploads/room_1/pane_1/session_1/upload_1.png";
    const spaced = `> [Image #1] test ${path} \r\n`;
    expect(maskUploadPaths(spaced)).toBe(`> [Image #1] test ${"[upload: upload_1.png]".padEnd(path.length, " ")} \r\n`);
  });
});
