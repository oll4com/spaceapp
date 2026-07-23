import { CliHostError } from "./session-registry.js";
import type { CliHostIdentity, CliHostSpawnSpec } from "./types.js";

export const rootRuntimeId = "cli:root";

export function normalizeRootSpawn(identity: CliHostIdentity, requested: CliHostSpawnSpec): CliHostSpawnSpec {
  if (identity.runtimeId !== rootRuntimeId) {
    throw new CliHostError("CLI_HOST_RUNTIME_FORBIDDEN", `Admin CLI host refuses runtime ${identity.runtimeId}.`);
  }
  return {
    command: "/bin/bash",
    args: ["--login"],
    cwd: "/etc",
    env: {
      COLORTERM: "truecolor",
      HOME: "/root",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      LOGNAME: "root",
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      SHELL: "/bin/bash",
      SPACE_CLI_RUNTIME_ID: rootRuntimeId,
      SPACE_CLI_SESSION_ID: identity.cliSessionId,
      SPACE_PANE_ID: identity.paneId,
      SPACE_ROOM_ID: identity.roomId,
      TERM: "xterm-256color",
      USER: "root"
    },
    cols: requested.cols,
    rows: requested.rows
  };
}
