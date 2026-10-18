#!/usr/bin/env bash
set -euo pipefail
: "${TARGET:?Set TARGET to core, browser or cli}"
: "${ARCH:?Set ARCH to amd64 or arm64}"
: "${IMAGE:?Set IMAGE to the built target image}"
case "$TARGET" in core|browser|cli) ;; *) exit 2 ;; esac
case "$ARCH" in amd64|arm64) ;; *) exit 2 ;; esac

smoke_dir="$(mktemp -d)"
net_name="spaceapp-smoke-${TARGET}-${ARCH}"
pg_name="spaceapp-pg-${TARGET}-${ARCH}"
svc_name="spaceapp-svc-${TARGET}-${ARCH}"
cleanup() {
  result=$?
  if (( result != 0 )); then docker logs "$svc_name" >&2 2>/dev/null || true; fi
  docker rm -f "$svc_name" "$pg_name" >/dev/null 2>&1 || true
  docker network rm "$net_name" >/dev/null 2>&1 || true
  rm -rf "$smoke_dir"
}
trap cleanup EXIT

# Use the same architecture for every application probe, including native addons.
docker run --rm --platform "linux/${ARCH}" --entrypoint node "$IMAGE" --input-type=module -e '
  import {existsSync} from "node:fs";
  const target = process.argv[1];
  if (target === "core") {
    await import("@temporalio/worker");
    await import("@space/cli-host"); // Client imports must not require a local PTY addon.
    if (existsSync("node_modules/node-pty")) throw Error("core contains node-pty");
  } else if (target === "cli") {
    if (existsSync("apps") || existsSync("node_modules/@temporalio")) throw Error("CLI contains unrelated services");
  } else {
    if (existsSync("apps/api/dist/server.js") || existsSync("node_modules/pdfjs-dist")) throw Error("browser contains unrelated API runtime");
    await import("./apps/api/dist/config.js");
    await import("./apps/api/dist/browser-sessions.js");
  }
' "$TARGET"

if [[ "$TARGET" == "cli" ]]; then
  docker run -d --name "$svc_name" --platform "linux/${ARCH}" "$IMAGE"
  for _ in $(seq 1 45); do
    if docker exec --user 10001:10001 "$svc_name" node -e '
      const sock = require("node:net").connect("/run/spaceapp-cli/host.sock", () => { sock.end(); process.exit(0); });
      sock.setTimeout(2000, () => process.exit(1)); sock.on("error", () => process.exit(1));
    ' >/dev/null 2>&1; then
      docker exec --user 10001:10001 "$svc_name" opencode --version
      docker exec --user 10001:10001 "$svc_name" node --input-type=module -e '
        const {spawnNodePty} = await import("./packages/cli-host/dist/node-pty-spawn.js");
        const {spawn} = await import("node-pty");
        const pty = spawn("/bin/sh", ["-c", "printf native-pty-ok"], {name:"xterm", cols:80, rows:24, cwd:"/tmp", env:process.env});
        const timer = setTimeout(() => { pty.kill(); process.exit(1); }, 10000);
        let output = ""; pty.onData(chunk => output += chunk);
        pty.onExit(({exitCode}) => { clearTimeout(timer); process.exit(exitCode === 0 && output.includes("native-pty-ok") && typeof spawnNodePty === "function" ? 0 : 1); });
      '
      exit 0
    fi
    sleep 2
  done
  exit 1
fi

docker network create "$net_name" >/dev/null
printf 'postgresql://spaceapp:smoke_pass@%s:5432/spaceapp' "$pg_name" > "$smoke_dir/database-url"
printf 'smoke-session-secret-0123456789abcdef0123456789abcdef' > "$smoke_dir/session-secret"
printf 'smoke-setup-token-0123456789abcdef0123456789abcdef' > "$smoke_dir/setup-token"
# Disposable fixtures only; the private parent directory is never committed or uploaded.
chmod 0644 "$smoke_dir/database-url" "$smoke_dir/session-secret" "$smoke_dir/setup-token"
pg_image="$(node --input-type=module -e '
  import {readFileSync} from "node:fs";
  const match = readFileSync("packages/run-spaceapp/templates/compose.yml", "utf8").match(/image:\s*(pgvector\/pgvector:[^\s]+@sha256:[a-f0-9]{64})/);
  if (!match) throw Error("Missing pinned PostgreSQL image"); console.log(match[1]);
')"
docker run -d --name "$pg_name" --network "$net_name" \
  -e POSTGRES_DB=spaceapp -e POSTGRES_USER=spaceapp -e POSTGRES_PASSWORD=smoke_pass "$pg_image"
for _ in $(seq 1 30); do
  if docker exec "$pg_name" pg_isready -U spaceapp -d spaceapp >/dev/null 2>&1; then break; fi
  sleep 2
done
docker exec "$pg_name" pg_isready -U spaceapp -d spaceapp

if [[ "$TARGET" == "core" ]]; then
  docker run -d --name "$svc_name" --platform "linux/${ARCH}" --network "$net_name" \
    -e SPACE_RUNTIME_STORE=postgres -e SPACEAPP_WORKFLOWS_ENABLED=false \
    -e SPACE_BROWSER_SESSIONS_ENABLED=false -e SPACE_CLI_ENABLED=false \
    -v "$smoke_dir/database-url:/run/secrets/database-url:ro" \
    -v "$smoke_dir/session-secret:/run/secrets/session-secret:ro" \
    -v "$smoke_dir/setup-token:/run/secrets/setup-token:ro" "$IMAGE"
  for _ in $(seq 1 60); do
    if docker exec --user 10001:10001 "$svc_name" node -e '
      fetch("http://127.0.0.1:4911/readyz").then(async r => { const body = await r.json(); if (!r.ok || body.ok !== true) process.exit(1); }).catch(() => process.exit(1));
    ' >/dev/null 2>&1; then exit 0; fi
    sleep 2
  done
  exit 1
fi

# Browser recovery queries capture tables during startup; initialize its real database first.
docker run --rm --platform "linux/${ARCH}" --network "$net_name" \
  -v "$smoke_dir/database-url:/run/secrets/database-url:ro" --entrypoint /bin/sh "$IMAGE" -ec \
  'export SPACE_DATABASE_URL="$(cat /run/secrets/database-url)"; exec gosu spaceapp node packages/db/dist/migrate.js'
docker run -d --name "$svc_name" --platform "linux/${ARCH}" --network "$net_name" \
  -e SPACE_RUNTIME_STORE=postgres -v "$smoke_dir/database-url:/run/secrets/database-url:ro" "$IMAGE"
for _ in $(seq 1 45); do
  if docker exec --user 10001:10001 "$svc_name" node --input-type=module -e '
    import {BrowserHostClient} from "@space/browser-host";
    const client = new BrowserHostClient({socketPath:"/run/spaceapp-browser/browser-host.sock", healthTimeoutMs:2000});
    try { await client.health(); } finally { await client.close(); }
  ' >/dev/null 2>&1; then
    docker exec --user 10001:10001 "$svc_name" /usr/bin/chromium --headless --no-sandbox --disable-gpu --dump-dom about:blank > "$smoke_dir/browser.html"
    test -s "$smoke_dir/browser.html"
    exit 0
  fi
  sleep 2
done
exit 1
