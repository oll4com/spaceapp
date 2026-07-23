#!/bin/sh
set -eu

: "${SPACE_DATABASE_URL_FILE:=/run/secrets/database-url}"

if [ ! -r "$SPACE_DATABASE_URL_FILE" ]; then
  echo "SpaceApp database URL secret is unavailable." >&2
  exit 1
fi

export SPACE_DATABASE_URL
SPACE_DATABASE_URL="$(cat "$SPACE_DATABASE_URL_FILE")"

install -d -o spaceapp -g spaceapp -m 0700 \
  /var/lib/spaceapp \
  /var/lib/spaceapp/artifacts \
  /run/spaceapp-browser

exec gosu spaceapp node apps/api/dist/browser-host-main.js
