#!/usr/bin/env bash
set -euo pipefail
# Git for Windows rewrites Linux container paths inside Docker CLI arguments.
export MSYS_NO_PATHCONV=1

target="${1:?usage: container-image-smoke.sh <core|browser|cli> <image> <pgvector-image> <port> }"
image="${2:?usage: container-image-smoke.sh <core|browser|cli> <image> <pgvector-image> <port> }"
pgvector_image="${3:?usage: container-image-smoke.sh <core|browser|cli> <image> <pgvector-image> <port> }"
port="${4:-5004}"
case "$target" in core|browser|cli) ;; *) echo "Unknown image target: $target" >&2; exit 2 ;; esac

suffix="${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}-${target}"
network="spaceapp-smoke-${suffix}"
database="spaceapp-smoke-postgres-${suffix}"
service="spaceapp-smoke-${target}-${suffix}"
secrets_volume="spaceapp-smoke-secrets-${suffix}"
secret_seed="spaceapp-smoke-secret-seed-${suffix}"
database_url="postgresql://spaceapp:smoke-password@${database}:5432/spaceapp"

write_secret() {
  local name="$1"
  local value="$2"
  local encoded
  encoded="$(printf '%s' "$value" | base64 | tr -d '\r\n')"
  docker exec "$secret_seed" sh -c "printf '%s' '$encoded' | base64 -d > '/run/secrets/$name' && chmod 0600 '/run/secrets/$name'"
}

cleanup() {
  docker rm -f "$service" "$database" "$secret_seed" >/dev/null 2>&1 || true
  docker volume rm -f "$secrets_volume" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker network create "$network" >/dev/null
docker volume create "$secrets_volume" >/dev/null
docker run -d --name "$secret_seed" \
  --mount "type=volume,src=$secrets_volume,dst=/run/secrets" \
  --entrypoint sh "$image" -c 'sleep 600' >/dev/null
docker run -d --name "$database" --network "$network" \
  -e POSTGRES_DB=spaceapp -e POSTGRES_USER=spaceapp -e POSTGRES_PASSWORD=smoke-password \
  "$pgvector_image" >/dev/null

ready=false
for attempt in $(seq 1 60); do
  if docker exec "$database" pg_isready -U spaceapp -d spaceapp >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 2
done
if [[ "$ready" != true ]]; then
  docker logs "$database"
  echo "pgvector PostgreSQL did not become ready" >&2
  exit 1
fi

case "$target" in
  core)
    write_secret database-url "$database_url"
    write_secret session-secret 'smoke-session-secret-not-for-production'
    write_secret setup-token 'smoke-setup-token-not-for-production'
    docker rm -f "$secret_seed" >/dev/null
    docker run -d --name "$service" --network "$network" -p "127.0.0.1:${port}:4911" \
      --mount "type=volume,src=$secrets_volume,dst=/run/secrets,readonly" \
      -e SPACE_PUBLIC_DISTRIBUTION=true \
      -e SPACE_DATABASE_URL_SOURCE_FILE=/run/secrets/database-url \
      -e SPACE_SESSION_SECRET_FILE=/run/secrets/session-secret \
      -e SPACE_SETUP_TOKEN_SOURCE_FILE=/run/secrets/setup-token \
      -e SPACE_RUNTIME_STORE=postgres \
      -e SPACE_API_HOST=127.0.0.1 -e SPACE_API_PORT=4910 \
      -e SPACE_WEB_HOST=0.0.0.0 -e SPACE_WEB_PORT=4911 \
      -e SPACE_API_ORIGIN=http://127.0.0.1:4910 \
      -e SPACEAPP_WORKFLOWS_ENABLED=false \
      -e SPACE_CLI_ENABLED=false \
      -e SPACE_BROWSER_SESSIONS_ENABLED=false \
      "$image" >/dev/null
    ready=false
    for attempt in $(seq 1 90); do
      if body="$(curl --silent --show-error --fail "http://127.0.0.1:${port}/readyz" 2>/dev/null)" \
        && node -e 'const value=JSON.parse(process.argv[1]);if(value.ok!==true)process.exit(1)' "$body"; then
        ready=true
        break
      fi
      if [[ "$(docker inspect -f '{{.State.Running}}' "$service")" != true ]]; then
        docker logs "$service"
        echo "core exited before readiness" >&2
        exit 1
      fi
      sleep 2
    done
    if [[ "$ready" != true ]]; then
      docker logs "$service"
      echo "core did not reach /readyz with ok:true" >&2
      exit 1
    fi
    echo "core migrations completed and /readyz returned ok:true"
    ;;
  browser)
    write_secret database-url "$database_url"
    docker rm -f "$secret_seed" >/dev/null
    docker run --rm --network "$network" --entrypoint node \
      -e "SPACE_RUNTIME_STORE=postgres" -e "SPACE_DATABASE_URL=$database_url" \
      "$image" packages/db/dist/migrate.js
    docker run -d --name "$service" --network "$network" \
      --mount "type=volume,src=$secrets_volume,dst=/run/secrets,readonly" \
      -e SPACE_PUBLIC_DISTRIBUTION=true \
      -e SPACE_RUNTIME_STORE=postgres \
      -e SPACE_DATABASE_URL_FILE=/run/secrets/database-url \
      -e SPACE_BROWSER_SESSIONS_ENABLED=true \
      "$image" >/dev/null
    ready=false
    for attempt in $(seq 1 90); do
      if docker exec "$service" node --input-type=module -e \
        'import { BrowserHostClient } from "@space/browser-host"; const client=new BrowserHostClient({socketPath:"/run/spaceapp-browser/browser-host.sock",healthTimeoutMs:2000}); try { const health=await client.health(); if(!health.hostPid) process.exit(1); console.log("Browser Host ready",health.hostPid); } finally { await client.close(); }' \
        >/dev/null 2>&1; then
        ready=true
        break
      fi
      if [[ "$(docker inspect -f '{{.State.Running}}' "$service")" != true ]]; then
        docker logs "$service"
        echo "Browser Host exited before startup" >&2
        exit 1
      fi
      sleep 2
    done
    if [[ "$ready" != true ]]; then
      docker logs "$service"
      echo "Browser Host socket did not become ready" >&2
      exit 1
    fi
    docker exec -d --user 10001:10001 "$service" /usr/bin/Xvfb :99 -screen 0 1280x720x24 -nolisten tcp -ac
    ready=false
    for attempt in $(seq 1 30); do
      if docker exec "$service" test -S /tmp/.X11-unix/X99 >/dev/null 2>&1; then
        ready=true
        break
      fi
      sleep 1
    done
    if [[ "$ready" != true ]]; then
      docker logs "$service"
      echo "Xvfb did not start for the non-root browser user" >&2
      exit 1
    fi
    docker exec --user 10001:10001 "$service" /usr/bin/chromium --headless --no-sandbox --disable-dev-shm-usage \
      --user-data-dir=/tmp/spaceapp-browser-smoke --dump-dom about:blank | grep -q '<html'
    echo "Browser Host accepted IPC health and Chromium rendered about:blank"
    ;;
  cli)
    docker run -d --name "$service" --network "$network" \
      --tmpfs /run/spaceapp-cli:uid=10001,gid=10001,mode=0700 \
      -e SPACE_CLI_HOST_SOCKET=/run/spaceapp-cli/host.sock "$image" >/dev/null
    ready=false
    for attempt in $(seq 1 60); do
      if docker exec "$service" node --input-type=module -e \
        'import { createConnection } from "node:net"; const socket=createConnection("/run/spaceapp-cli/host.sock"); socket.once("connect",()=>{console.log("CLI Host accepted a connection");socket.end();}); socket.once("error",()=>process.exit(1)); setTimeout(()=>process.exit(2),2000).unref();' \
        >/dev/null 2>&1; then
        ready=true
        break
      fi
      if [[ "$(docker inspect -f '{{.State.Running}}' "$service")" != true ]]; then
        docker logs "$service"
        echo "CLI Host exited before startup" >&2
        exit 1
      fi
      sleep 2
    done
    if [[ "$ready" != true ]]; then
      docker logs "$service"
      echo "CLI Host socket did not accept a connection" >&2
      exit 1
    fi
    echo "CLI Host accepted an IPC connection"
    ;;
esac
