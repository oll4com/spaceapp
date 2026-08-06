#!/usr/bin/env bash
set -euo pipefail

runtime_name="$(basename "$0" -vscode-parity)"
state_root="/var/lib/spaceapp-cli/providers/$runtime_name"
credential_root="/var/lib/spaceapp-cli/imported-credentials"
credential_file="$credential_root/$runtime_name.key"

export USER=spaceapp
export LOGNAME=spaceapp
export HOME="$state_root"
export TMPDIR="$state_root/tmp"
umask 077

case "$runtime_name" in
  codex)
    command_name="codex"
    export CODEX_HOME="$state_root"
    export OPENAI_API_KEY="$(cat "$credential_file" 2>/dev/null || true)"
    ;;
  claude)
    command_name="/var/lib/spaceapp-cli/vendor/claude/node_modules/.bin/claude"
    export CLAUDE_CONFIG_DIR="$state_root"
    export ANTHROPIC_API_KEY="$(cat "$credential_file" 2>/dev/null || true)"
    export DISABLE_UPDATES=1
    ;;
  gemini)
    command_name="gemini"
    export GEMINI_CLI_HOME="$state_root"
    export GEMINI_API_KEY="$(cat "$credential_file" 2>/dev/null || true)"
    ;;
  opencode)
    command_name="opencode"
    export XDG_CONFIG_HOME="$state_root/config"
    export XDG_DATA_HOME="$state_root/data"
    export XDG_CACHE_HOME="$state_root/cache"
    export XDG_STATE_HOME="$state_root/state"
    export OPENCODE_API_KEY="$(cat "$credential_file" 2>/dev/null || true)"
    ;;
  qwen)
    command_name="qwen"
    export QWEN_HOME="$state_root"
    export QWEN_API_KEY="$(cat "$credential_file" 2>/dev/null || true)"
    ;;
  kimi)
    command_name="kimi"
    export KIMI_CODE_HOME="$state_root"
    export KIMI_API_KEY="$(cat "$credential_file" 2>/dev/null || true)"
    ;;
  grok)
    command_name="grok"
    export GROK_HOME="$state_root"
    export XAI_API_KEY="$(cat "$credential_file" 2>/dev/null || true)"
    ;;
  deepseek)
    command_name="deepseek-cli"
    credential_file="$credential_root/deepseek.key"
    export DEEPSEEK_HOME="$state_root"
    export DEEPSEEK_API_KEY="$(cat "$credential_file" 2>/dev/null || true)"
    ;;
  autohand)
    command_name="autohand"
    export AUTOHAND_HOME="$state_root"
    export AUTOHAND_API_KEY="$(cat "$credential_file" 2>/dev/null || true)"
    ;;
  cursor)
    command_name="cursor-agent"
    export CURSOR_CONFIG_DIR="$state_root"
    export AGENT_CLI_CREDENTIAL_STORE="file"
    ;;
  copilot)
    command_name="copilot"
    export COPILOT_HOME="$state_root"
    ;;
  *)
    echo "Unsupported SpaceApp CLI wrapper." >&2
    exit 64
    ;;
esac

if [ "${1:-}" = "--run-inner" ]; then
  shift
fi

ensure_runtime_dirs() {
  mkdir -p "$HOME" "$TMPDIR" "$credential_root"
  chmod 0700 "$HOME" "$TMPDIR" "$credential_root"
}

credential_ready() {
  [ -s "$credential_file" ] && return 0
  case "$runtime_name" in
    codex) [ -s "$state_root/auth.json" ] ;;
    gemini) [ -s "$state_root/.gemini/oauth_creds.json" ] ;;
    opencode) [ -s "$state_root/data/opencode/auth.json" ] ;;
    qwen) [ -s "$state_root/.qwen/oauth_creds.json" ] ;;
    kimi) [ -s "$state_root/.kimi/credentials.json" ] ;;
    grok) [ -s "$state_root/.grok/credentials.json" ] ;;
    claude) [ -s "$state_root/.credentials.json" ] ;;
    deepseek) [ -s "$credential_file" ] ;;
    autohand) [ -s "$state_root/config.json" ] ;;
    cursor) [ -s "$state_root/.config/cursor/auth.json" ] ;;
    copilot) [ -s "$state_root/config.json" ] ;;
  esac
}

case "${1:-}" in
  credential-status)
    if credential_ready; then
      printf 'READY\n'
      exit 0
    fi
    printf 'NOT_READY\n'
    exit 1
    ;;
  credential-observation)
    credential_ready || exit 1
    printf 'OBSERVATION:%s\n' \
      "$(printf '%s' "$runtime_name:ready" | sha256sum | cut -d ' ' -f 1)"
    exit 0
    ;;
  credential-smoke)
    credential_ready || exit 1
    printf '%s\n' "SPACE_$(printf '%s' "$runtime_name" | tr '[:lower:]' '[:upper:]')_OK"
    exit 0
    ;;
  inspect-env)
    printf 'runtime=%s\nhome=isolated\ncredential=%s\n' \
      "$runtime_name" "$(credential_ready && printf present || printf absent)"
    exit 0
    ;;
  login)
    ensure_runtime_dirs
    shift
    case "$runtime_name" in
      codex) exec "$command_name" login --device-auth "$@" ;;
      kimi|grok|claude) exec "$command_name" login "$@" ;;
      opencode) exec "$command_name" auth login "$@" ;;
      gemini|qwen) exec "$command_name" "$@" ;;
      deepseek)
        echo "Set DeepSeek credentials with: spaceapp credentials set deepseek" >&2
        exit 64
        ;;
      autohand)
        echo "Set Autohand credentials with: spaceapp credentials set autohand" >&2
        exit 64
        ;;
      cursor) exec "$command_name" login "$@" ;;
      copilot) exec "$command_name" login "$@" ;;
      *) echo "Login is unavailable for this runtime." >&2; exit 64 ;;
    esac
    ;;
  setup)
    echo "Set API-key credentials with the host-side spaceapp credentials command." >&2
    exit 64
    ;;
esac

ensure_runtime_dirs
if ! command -v "$command_name" >/dev/null 2>&1; then
  echo "$runtime_name is not installed in this image." >&2
  exit 69
fi

exec "$command_name" "$@"
