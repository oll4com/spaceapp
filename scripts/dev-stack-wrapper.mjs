import { createHash } from "node:crypto";
import { posix } from "node:path";

const { join, dirname } = posix;

const quote = value => `'${String(value).replaceAll("'", `'"'"'`)}'`;

/** Only the installed state-local OpenCode is executable through this wrapper. */
export function openCodeWrapper(state, nodePath = process.execPath) {
  const binary = join(state.stateDir, "vendor", "node_modules", ".bin", "opencode");
  const home = join(state.stateDir, "providers", "opencode");
  const observation = createHash("sha256").update(`dev-stack:${state.project}:opencode:installed`).digest("hex");
  const environment = {
    PATH: `${dirname(nodePath)}:/usr/local/bin:/usr/bin:/bin`, HOME: home,
    XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"),
    XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"),
    TMPDIR: join(home, "tmp"), LANG: "C.UTF-8",
    OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1"
  };
  const invocation = `exec /usr/bin/env -i ${Object.entries(environment).map(([key, value]) => `${key}=${quote(value)}`).join(" ")} TERM="\${TERM:-xterm-256color}" ${quote(binary)}`;
  return `#!/bin/sh
set -eu
if [ "\${1:-}" = "--run-inner" ]; then shift; fi
if [ ! -x ${quote(binary)} ]; then echo 'State-local OpenCode is not installed.' >&2; exit 69; fi
case "\${1:-}" in
  credential-status) printf 'READY\\n'; exit 0 ;;
  credential-observation) printf 'OBSERVATION:${observation}\\n'; exit 0 ;;
  credential-smoke)
    ${invocation.replace(/^exec /, "")} --version >/dev/null
    printf 'SPACE_OPENCODE_OK\\n'; exit 0 ;;
  credential-install|login|setup) echo 'Provider account operations are not part of the contributor stack.' >&2; exit 64 ;;
esac
# All provider state stays inside this stack; no host account or API key is inherited.
# Reaching a terminal UI does not certify a working model or generated answer.
${invocation} "$@"
`;
}
