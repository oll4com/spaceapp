#!/bin/sh
set -eu

install -d -o spaceapp -g spaceapp -m 0700 \
  /var/lib/spaceapp-cli \
  /var/lib/spaceapp-cli/providers \
  /var/lib/spaceapp-cli/imported-credentials \
  /var/lib/spaceapp/memory \
  /workspaces \
  /run/spaceapp-cli

if [ -d /run/spaceapp-secrets/providers ]; then
  for provider in codex gemini opencode qwen kimi grok claude deepseek; do
    source="/run/spaceapp-secrets/providers/$provider.key"
    destination="/var/lib/spaceapp-cli/imported-credentials/$provider.key"
    rm -f -- "$destination"
    if [ -f "$source" ]; then
      install -o spaceapp -g spaceapp -m 0600 "$source" "$destination"
    fi
  done
fi

if [ "${SPACEAPP_CLI_HOST_ROOT_ACCESS:-false}" = "true" ]; then
  exec node packages/cli-host/dist/main.js
fi

exec gosu spaceapp node packages/cli-host/dist/main.js
