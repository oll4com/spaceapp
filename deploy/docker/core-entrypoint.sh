#!/bin/sh
set -eu

: "${SPACE_DATABASE_URL_SOURCE_FILE:=/run/secrets/database-url}"
: "${SPACE_DATABASE_URL_FILE:=/run/spaceapp/database-url}"
: "${SPACE_SESSION_SECRET_FILE:=/run/secrets/session-secret}"
: "${SPACE_SETUP_TOKEN_SOURCE_FILE:=/run/secrets/setup-token}"
: "${SPACE_SETUP_TOKEN_RUNTIME_FILE:=/run/spaceapp/setup-token}"
: "${SPACE_MEMORY_ROOT:=/var/lib/spaceapp/memory}"
: "${SPACE_STARTER_MEMORY_ROOT:=/opt/spaceapp/starter-memory}"
: "${SPACE_MEMORY_GRAPH_ROOT:=/var/lib/spaceapp/memory-graph}"
: "${SPACE_GEMINI_MEMORY_MONTHLY_PATH:=$SPACE_MEMORY_ROOT/gemini_history_monthly.md}"
: "${SPACE_TELEGRAM_SECRET_ROOT:=/var/lib/spaceapp/telegram}"
: "${SPACE_TELEGRAM_OWNERSHIP_MANIFEST:=/var/lib/spaceapp/integrations/telegram/thread-ownership.json}"

if [ ! -r "$SPACE_DATABASE_URL_SOURCE_FILE" ]; then
  echo "SpaceApp database URL secret is unavailable." >&2
  exit 1
fi
if [ ! -r "$SPACE_SESSION_SECRET_FILE" ]; then
  echo "SpaceApp session secret is unavailable." >&2
  exit 1
fi
if [ ! -r "$SPACE_SETUP_TOKEN_SOURCE_FILE" ]; then
  echo "SpaceApp setup token secret is unavailable." >&2
  exit 1
fi

export SPACE_DATABASE_URL
SPACE_DATABASE_URL="$(cat "$SPACE_DATABASE_URL_SOURCE_FILE")"
export SPACE_SESSION_SECRET
SPACE_SESSION_SECRET="$(cat "$SPACE_SESSION_SECRET_FILE")"

install -d -o spaceapp -g spaceapp -m 0700 \
  /var/lib/spaceapp \
  /var/lib/spaceapp/artifacts \
  "$SPACE_MEMORY_ROOT" \
  "$SPACE_MEMORY_GRAPH_ROOT" \
  "$(dirname "$SPACE_GEMINI_MEMORY_MONTHLY_PATH")" \
  "$SPACE_TELEGRAM_SECRET_ROOT" \
  "$(dirname "$SPACE_TELEGRAM_OWNERSHIP_MANIFEST")" \
  /workspaces \
  /run/spaceapp \
  /run/spaceapp-cli

install -o spaceapp -g spaceapp -m 0400 \
  "$SPACE_DATABASE_URL_SOURCE_FILE" \
  "$SPACE_DATABASE_URL_FILE"
install -o spaceapp -g spaceapp -m 0400 \
  "$SPACE_SETUP_TOKEN_SOURCE_FILE" \
  "$SPACE_SETUP_TOKEN_RUNTIME_FILE"
export SPACE_SETUP_TOKEN_FILE
SPACE_SETUP_TOKEN_FILE="$SPACE_SETUP_TOKEN_RUNTIME_FILE"

if [ ! -e "$SPACE_MEMORY_ROOT/gemini_history.md" ]; then
  install -o spaceapp -g spaceapp -m 0600 \
    "$SPACE_STARTER_MEMORY_ROOT/gemini_history.md" \
    "$SPACE_MEMORY_ROOT/gemini_history.md"
fi
if [ ! -e "$SPACE_GEMINI_MEMORY_MONTHLY_PATH" ]; then
  install -o spaceapp -g spaceapp -m 0600 \
    "$SPACE_STARTER_MEMORY_ROOT/gemini_history_monthly.md" \
    "$SPACE_GEMINI_MEMORY_MONTHLY_PATH"
fi

gosu spaceapp node packages/db/dist/migrate.js
exec gosu spaceapp node deploy/docker/core-supervisor.mjs
