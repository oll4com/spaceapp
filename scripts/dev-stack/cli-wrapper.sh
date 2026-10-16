#!/usr/bin/env bash
# CLI wrapper of the from-source dev stack (npm run dev:stack). The published CLI image
# uses deploy/docker/public-cli-wrapper.sh with fixed container paths; this one keeps
# provider state and installed CLIs in the dev stack's state directory. OpenCode only.
set -euo pipefail

runtime_name="${1:-}"
shift || true
cli_root="${SPACE_DEV_CLI_ROOT:?SPACE_DEV_CLI_ROOT is set by the generated command}"
state_root="$cli_root/providers/$runtime_name"

case "$runtime_name" in
  opencode)
    command_path="$cli_root/vendor/opencode/node_modules/.bin/opencode"
    ;;
  *)
    echo "$runtime_name is not available in the dev stack; only OpenCode is installed." >&2
    exit 64
    ;;
esac

export HOME="$state_root"
export TMPDIR="$state_root/tmp"
export XDG_CONFIG_HOME="$state_root/config"
export XDG_DATA_HOME="$state_root/data"
export XDG_CACHE_HOME="$state_root/cache"
export XDG_STATE_HOME="$state_root/state"
export OPENCODE_DISABLE_AUTOUPDATE=1
umask 077

if [ "${1:-}" = "--run-inner" ]; then
  shift
fi

ready() { [ -x "$command_path" ]; }

case "${1:-}" in
  credential-status)
    if ready; then printf 'READY\n'; exit 0; fi
    printf 'NOT_READY\n'; exit 1
    ;;
  credential-observation)
    ready || exit 1
    printf 'OBSERVATION:%s\n' "$(printf '%s' "$runtime_name:ready" | { sha256sum 2>/dev/null || shasum -a 256; } | cut -d ' ' -f 1)"
    exit 0
    ;;
  credential-smoke)
    ready || exit 1
    printf 'SPACE_OPENCODE_OK\n'
    exit 0
    ;;
  inspect-env)
    printf 'runtime=%s\nhome=isolated\ncredential=%s\n' "$runtime_name" "$(ready && printf present || printf absent)"
    exit 0
    ;;
  login)
    shift
    mkdir -p "$HOME" "$TMPDIR"
    exec "$command_path" auth login "$@"
    ;;
  setup|credential-install)
    echo "Provider credentials are not managed by the dev stack. Use OpenCode's own /connect." >&2
    exit 64
    ;;
esac

if ! ready; then
  echo "OpenCode is not installed in the dev stack. Restart npm run dev:stack to install it." >&2
  exit 69
fi
mkdir -p "$HOME" "$TMPDIR"
chmod 0700 "$HOME" "$TMPDIR"
exec "$command_path" "$@"
