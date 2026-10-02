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
  for provider in codex gemini opencode qwen kimi grok claude deepseek autohand cursor copilot; do
    source="/run/spaceapp-secrets/providers/$provider.key"
    destination="/var/lib/spaceapp-cli/imported-credentials/$provider.key"
    rm -f -- "$destination"
    if [ -f "$source" ]; then
      install -o spaceapp -g spaceapp -m 0600 "$source" "$destination"
    fi
  done
fi

if [ -d /app/agent-skills ]; then
  install -d -o spaceapp -g spaceapp -m 0755 /var/lib/spaceapp-cli/.codex/skills /var/lib/spaceapp-cli/.agents/skills
  for skill_dir in /app/agent-skills/*; do
    if [ -d "$skill_dir" ]; then
      skill_name=$(basename "$skill_dir")
      short_name="${skill_name#space-}"
      ln -sfn "$skill_dir" "/var/lib/spaceapp-cli/.codex/skills/$skill_name"
      ln -sfn "$skill_dir" "/var/lib/spaceapp-cli/.agents/skills/$skill_name"
      if [ "$short_name" != "$skill_name" ]; then
        ln -sfn "$skill_dir" "/var/lib/spaceapp-cli/.codex/skills/$short_name"
        ln -sfn "$skill_dir" "/var/lib/spaceapp-cli/.agents/skills/$short_name"
      fi
    fi
  done
fi

if [ "${SPACEAPP_CLI_HOST_ROOT_ACCESS:-false}" = "true" ]; then
  exec gosu root:spaceapp node packages/cli-host/dist/main.js
fi

# Host-root sessions may leave root-owned provider or memory state. Restore only
# the named-volume state; /workspaces can contain owner-managed host bind mounts.
chown -hR spaceapp:spaceapp /var/lib/spaceapp-cli /var/lib/spaceapp/memory
exec gosu spaceapp node packages/cli-host/dist/main.js
