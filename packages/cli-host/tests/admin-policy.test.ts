import { describe, expect, it } from "vitest";
import { CliHostError, normalizeRootSpawn } from "../src/index.js";

describe("root CLI host policy", () => {
  it("replaces the client spawn request with one fixed root login shell", () => {
    expect(
      normalizeRootSpawn(
        {
          cliSessionId: "cli_session:root",
          paneId: "pane:root",
          roomId: "room:root",
          runtimeId: "cli:root",
          codexThreadId: null,
          modelId: null,
          reasoningEffort: null
        },
        { command: "malicious", args: ["--anything"], cwd: "/tmp", env: { OPENAI_API_KEY: "must-drop" }, cols: 120, rows: 40 }
      )
    ).toEqual({
      command: "/bin/bash",
      args: ["--login"],
      cwd: "/tmp",
      env: {
        COLORTERM: "truecolor",
        HOME: "/root",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        LOGNAME: "root",
        PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        SHELL: "/bin/bash",
        SPACE_CLI_RUNTIME_ID: "cli:root",
        SPACE_CLI_SESSION_ID: "cli_session:root",
        SPACE_PANE_ID: "pane:root",
        SPACE_ROOM_ID: "room:root",
        TERM: "xterm-256color",
        USER: "root"
      },
      cols: 120,
      rows: 40
    });
  });

  it("falls back to /etc if requested cwd is missing or invalid", () => {
    const spec = normalizeRootSpawn(
      {
        cliSessionId: "cli_session:root",
        paneId: "pane:root",
        roomId: "room:root",
        runtimeId: "cli:root",
        codexThreadId: null,
        modelId: null,
        reasoningEffort: null
      },
      { command: "bash", args: [], cwd: "", env: {}, cols: 80, rows: 24 }
    );
    expect(spec.cwd).toBe("/etc");
  });

  it("rejects identities outside the dedicated root runtime", () => {
    expect(() =>
      normalizeRootSpawn(
        {
          cliSessionId: "cli_session:codex",
          paneId: "pane:codex",
          roomId: "room:codex",
          runtimeId: "cli:codex",
          codexThreadId: null,
          modelId: null,
          reasoningEffort: null
        },
        { command: "codex", args: [], cwd: "/etc", env: {}, cols: 80, rows: 24 }
      )
    ).toThrowError(expect.objectContaining<Partial<CliHostError>>({ code: "CLI_HOST_RUNTIME_FORBIDDEN" }));
  });
});
