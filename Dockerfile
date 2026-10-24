# syntax=docker/dockerfile:1.7

FROM node:22.23.0-trixie-slim@sha256:cfd8f2a5bc50526aee08e88970979f92722828e7dcc6d8983607fb8bff4bdb82 AS build
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential liblzma5 python3 pkg-config \
    && rm -rf /var/lib/apt/lists/*
COPY . .
RUN npm ci --no-audit --no-fund \
    && npm run build \
    && npm prune --omit=dev \
    && find node_modules -type f \( -name '*.js.map' -o -name '*.mjs.map' -o -name '*.cjs.map' -o -name '*.css.map' \) -delete

# Per-target production dependency closures. Each runtime image installs only the
# workspaces its entrypoint actually runs (npm resolves the workspace dependency
# closure from package-lock.json), so the CLI image no longer ships the API/SDK
# tree and the browser image no longer ships the CLI host or Temporal SDK.
# core runs apps/api/dist/server.js, apps/worker/dist/worker.js,
# apps/web/server.mjs and packages/db/dist/migrate.js.
FROM build AS deps-core
ARG TARGETARCH
RUN npm ci --omit=dev --no-audit --no-fund --maxsockets 3 \
      --workspace @space/api \
      --workspace @space/worker \
      --workspace @space/web \
      --workspace @space/db \
    && find node_modules -type f \( -name '*.js.map' -o -name '*.mjs.map' -o -name '*.cjs.map' -o -name '*.css.map' \) -delete \
    && sh deploy/docker/prune-native-prebuilds.sh "$TARGETARCH" node_modules \
    && rm -rf node_modules/typescript node_modules/lucide-react

# browser runs apps/api/dist/browser-host-main.js only: it imports
# @space/browser-host, @space/contracts, @space/db, @space/runtime and the
# ./config.js, ./browser-sessions.js and ./vault/* helpers of apps/api.
FROM build AS deps-browser
ARG TARGETARCH
RUN npm ci --omit=dev --no-audit --no-fund --maxsockets 3 \
      --workspace @space/browser-host \
      --workspace @space/contracts \
      --workspace @space/db \
      --workspace @space/runtime \
    && find node_modules -type f \( -name '*.js.map' -o -name '*.mjs.map' -o -name '*.cjs.map' -o -name '*.css.map' \) -delete \
    && sh deploy/docker/prune-native-prebuilds.sh "$TARGETARCH" node_modules

# cli runs packages/cli-host/dist/main.js (and deploy/docker/credential-agent.mjs,
# which uses Node built-ins only).
FROM build AS deps-cli
ARG TARGETARCH
RUN npm ci --omit=dev --no-audit --no-fund --maxsockets 3 \
      --workspace @space/cli-host \
    && find node_modules -type f \( -name '*.js.map' -o -name '*.mjs.map' -o -name '*.cjs.map' -o -name '*.css.map' \) -delete \
    && sh deploy/docker/prune-native-prebuilds.sh "$TARGETARCH" node_modules

FROM node:22.23.0-trixie-slim@sha256:cfd8f2a5bc50526aee08e88970979f92722828e7dcc6d8983607fb8bff4bdb82 AS runtime-base
ARG TARGETARCH
ARG NPM_VERSION=11.18.0
ENV NODE_ENV=production \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8
LABEL org.opencontainers.image.source=https://github.com/oll4com/spaceapp
LABEL org.opencontainers.image.licenses=MIT
RUN npm install --global --ignore-scripts --no-audit --no-fund "npm@${NPM_VERSION}" \
    && install -d /tmp/npm-security-patches \
    && npm pack --ignore-scripts --no-audit --no-fund --pack-destination /tmp/npm-security-patches \
      brace-expansion@5.0.12 tar@7.5.21 ip-address@10.7.4 undici@6.28.1 postcss-selector-parser@7.1.6 \
    && rm -rf \
      /usr/local/lib/node_modules/npm/node_modules/brace-expansion \
      /usr/local/lib/node_modules/npm/node_modules/tar \
      /usr/local/lib/node_modules/npm/node_modules/ip-address \
      /usr/local/lib/node_modules/npm/node_modules/undici \
      /usr/local/lib/node_modules/npm/node_modules/postcss-selector-parser \
    && install -d \
      /usr/local/lib/node_modules/npm/node_modules/brace-expansion \
      /usr/local/lib/node_modules/npm/node_modules/tar \
      /usr/local/lib/node_modules/npm/node_modules/ip-address \
      /usr/local/lib/node_modules/npm/node_modules/undici \
      /usr/local/lib/node_modules/npm/node_modules/postcss-selector-parser \
    && tar -xzf /tmp/npm-security-patches/brace-expansion-5.0.12.tgz \
      -C /usr/local/lib/node_modules/npm/node_modules/brace-expansion --strip-components=1 \
    && tar -xzf /tmp/npm-security-patches/tar-7.5.21.tgz \
      -C /usr/local/lib/node_modules/npm/node_modules/tar --strip-components=1 \
    && tar -xzf /tmp/npm-security-patches/ip-address-10.7.4.tgz \
      -C /usr/local/lib/node_modules/npm/node_modules/ip-address --strip-components=1 \
    && tar -xzf /tmp/npm-security-patches/undici-6.28.1.tgz \
      -C /usr/local/lib/node_modules/npm/node_modules/undici --strip-components=1 \
    && tar -xzf /tmp/npm-security-patches/postcss-selector-parser-7.1.6.tgz \
      -C /usr/local/lib/node_modules/npm/node_modules/postcss-selector-parser --strip-components=1 \
    && rm -rf /tmp/npm-security-patches \
    && npm cache clean --force \
    && apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates curl git gosu liblzma5 postgresql-client procps ripgrep sqlite3 \
    && apt-get upgrade -y \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 spaceapp \
    && useradd --uid 10001 --gid 10001 --create-home --home-dir /var/lib/spaceapp-cli --shell /bin/bash spaceapp
WORKDIR /app
COPY --from=build --chown=spaceapp:spaceapp /app/package.json /app/package-lock.json ./
COPY --chown=spaceapp:spaceapp deploy/docker ./deploy/docker
RUN chmod 0755 deploy/docker/core-entrypoint.sh deploy/docker/browser-entrypoint.sh deploy/docker/cli-entrypoint.sh \
    && install -m 0755 deploy/docker/public-cli-wrapper.sh /usr/local/bin/spaceapp-cli-wrapper \
    && for name in codex claude gemini opencode qwen kimi grok deepseek autohand cursor copilot; do \
         ln -s /usr/local/bin/spaceapp-cli-wrapper "/usr/local/bin/${name}-vscode-parity"; \
       done
COPY --from=build --chown=spaceapp:spaceapp /app/LICENSE /app/NOTICE /app/THIRD_PARTY_NOTICES.md ./
COPY --from=build --chown=spaceapp:spaceapp /app/THIRD_PARTY_LICENSES ./THIRD_PARTY_LICENSES
COPY --from=build --chown=spaceapp:spaceapp /app/scripts/reset-owner-password.mjs ./scripts/reset-owner-password.mjs
COPY --from=build --chown=spaceapp:spaceapp /app/scripts/rotate-owner-setup-token.mjs ./scripts/rotate-owner-setup-token.mjs
COPY --from=build --chown=spaceapp:spaceapp /app/scripts/portable-backup.mjs ./scripts/portable-backup.mjs
COPY --from=build --chown=spaceapp:spaceapp /app/scripts/portable-restore.mjs ./scripts/portable-restore.mjs

FROM runtime-base AS core
COPY --from=deps-core --chown=spaceapp:spaceapp /app/node_modules ./node_modules
COPY --from=build --chown=spaceapp:spaceapp /app/apps/api/package.json ./apps/api/package.json
COPY --from=build --chown=spaceapp:spaceapp /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=spaceapp:spaceapp /app/apps/worker/package.json ./apps/worker/package.json
COPY --from=build --chown=spaceapp:spaceapp /app/apps/worker/dist ./apps/worker/dist
COPY --from=build --chown=spaceapp:spaceapp /app/apps/web/package.json ./apps/web/package.json
COPY --from=build --chown=spaceapp:spaceapp /app/apps/web/server.mjs ./apps/web/server.mjs
COPY --from=build --chown=spaceapp:spaceapp /app/apps/web/dist ./apps/web/dist
COPY --from=build --chown=spaceapp:spaceapp /app/packages/browser-host/package.json ./packages/browser-host/package.json
COPY --from=build --chown=spaceapp:spaceapp /app/packages/browser-host/dist ./packages/browser-host/dist
COPY --from=build --chown=spaceapp:spaceapp /app/packages/cli-host/package.json ./packages/cli-host/package.json
COPY --from=build --chown=spaceapp:spaceapp /app/packages/cli-host/dist ./packages/cli-host/dist
COPY --from=build --chown=spaceapp:spaceapp /app/packages/codex-app-server/package.json ./packages/codex-app-server/package.json
COPY --from=build --chown=spaceapp:spaceapp /app/packages/codex-app-server/dist ./packages/codex-app-server/dist
COPY --from=build --chown=spaceapp:spaceapp /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build --chown=spaceapp:spaceapp /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build --chown=spaceapp:spaceapp /app/packages/db/package.json ./packages/db/package.json
COPY --from=build --chown=spaceapp:spaceapp /app/packages/db/dist ./packages/db/dist
COPY --from=build --chown=spaceapp:spaceapp /app/packages/db/migrations ./packages/db/migrations
COPY --from=build --chown=spaceapp:spaceapp /app/packages/gateway/package.json ./packages/gateway/package.json
COPY --from=build --chown=spaceapp:spaceapp /app/packages/gateway/dist ./packages/gateway/dist
COPY --from=build --chown=spaceapp:spaceapp /app/packages/memory-graph/package.json ./packages/memory-graph/package.json
COPY --from=build --chown=spaceapp:spaceapp /app/packages/memory-graph/dist ./packages/memory-graph/dist
COPY --from=build --chown=spaceapp:spaceapp /app/packages/opencode-control/package.json ./packages/opencode-control/package.json
COPY --from=build --chown=spaceapp:spaceapp /app/packages/opencode-control/dist ./packages/opencode-control/dist
COPY --from=build --chown=spaceapp:spaceapp /app/packages/runtime/package.json ./packages/runtime/package.json
COPY --from=build --chown=spaceapp:spaceapp /app/packages/runtime/dist ./packages/runtime/dist
COPY --from=build --chown=spaceapp:spaceapp /app/packages/streaming/package.json ./packages/streaming/package.json
COPY --from=build --chown=spaceapp:spaceapp /app/packages/streaming/dist ./packages/streaming/dist
COPY --from=build --chown=spaceapp:spaceapp /app/agent-skills ./agent-skills
COPY --chown=spaceapp:spaceapp starter-memory /opt/spaceapp/starter-memory
RUN install -d -o spaceapp -g spaceapp -m 0700 \
      /var/lib/spaceapp \
      /var/lib/spaceapp/artifacts \
      /var/lib/spaceapp/memory \
      /run/spaceapp-cli
EXPOSE 4911
HEALTHCHECK --interval=15s --timeout=5s --start-period=45s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4911/readyz').then(async r=>{const body=await r.json();if(!r.ok||body.ok !== true)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT ["/app/deploy/docker/core-entrypoint.sh"]

FROM runtime-base AS browser
COPY --from=deps-browser --chown=spaceapp:spaceapp /app/node_modules ./node_modules
# apps/api/config.ts (in the browser host's import closure) validates through
# @t3-oss/env-core, which only apps/api declares; take it from the full build.
COPY --from=build --chown=spaceapp:spaceapp /app/node_modules/@t3-oss/env-core ./node_modules/@t3-oss/env-core
COPY --from=build --chown=spaceapp:spaceapp /app/packages/browser-host/package.json ./packages/browser-host/package.json
COPY --from=build --chown=spaceapp:spaceapp /app/packages/browser-host/dist ./packages/browser-host/dist
COPY --from=build --chown=spaceapp:spaceapp /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build --chown=spaceapp:spaceapp /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build --chown=spaceapp:spaceapp /app/packages/db/package.json ./packages/db/package.json
COPY --from=build --chown=spaceapp:spaceapp /app/packages/db/dist ./packages/db/dist
COPY --from=build --chown=spaceapp:spaceapp /app/packages/db/migrations ./packages/db/migrations
COPY --from=build --chown=spaceapp:spaceapp /app/packages/memory-graph/package.json ./packages/memory-graph/package.json
COPY --from=build --chown=spaceapp:spaceapp /app/packages/memory-graph/dist ./packages/memory-graph/dist
COPY --from=build --chown=spaceapp:spaceapp /app/packages/runtime/package.json ./packages/runtime/package.json
COPY --from=build --chown=spaceapp:spaceapp /app/packages/runtime/dist ./packages/runtime/dist
COPY --from=build --chown=spaceapp:spaceapp /app/apps/api/package.json ./apps/api/package.json
# The browser host imports internal apps/api modules transitively (config,
# browser-sessions, vault/*, source-control/*, ...); ship the compiled dist of
# apps/api (14 MiB uncompressed) instead of enumerating that closure by hand.
COPY --from=build --chown=spaceapp:spaceapp /app/apps/api/dist ./apps/api/dist
RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium fonts-liberation liblzma5 xvfb \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -o spaceapp -g spaceapp -m 0700 \
      /var/lib/spaceapp \
      /var/lib/spaceapp/artifacts \
      /run/spaceapp-browser
ENV SPACE_BROWSER_CHROME_PATH=/usr/bin/chromium \
    SPACE_BROWSER_SESSIONS_CHROME_PATH=/usr/bin/chromium
ENTRYPOINT ["/app/deploy/docker/browser-entrypoint.sh"]

FROM runtime-base AS cli
COPY --chown=root:root starter-memory/AGENTS.md /etc/AGENTS.md
COPY --chown=root:root starter-memory/installation-guide.md /etc/spaceapp-installation-guide.md
RUN chmod 0644 /etc/AGENTS.md
ARG TARGETARCH
# python3-minimal (about 13 MB): agents often check their work with a short python3 script (pilot F18).
# OpenCode 2 (@opencode/cli): its postinstall picks the native binary for the image's platform.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3-minimal \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global --no-audit --no-fund @opencode/cli@2.0.32 \
    && install -d -o spaceapp -g spaceapp -m 0700 /var/lib/spaceapp-cli/vendor \
    && if [ "$TARGETARCH" = "amd64" ]; then \
         rm -rf /usr/local/lib/node_modules/@opencode/cli/node_modules/@opencode/cli-linux-x64-musl \
           /usr/local/lib/node_modules/@opencode/cli/node_modules/@opencode/cli-linux-x64-baseline-musl; \
       else \
         rm -rf /usr/local/lib/node_modules/@opencode/cli/node_modules/@opencode/cli-linux-arm64-musl \
           /usr/local/lib/node_modules/@opencode/cli/node_modules/@opencode/cli-linux-arm64-baseline-musl; \
       fi \
    && npm cache clean --force \
    && install -d -o spaceapp -g spaceapp -m 0700 \
      /var/lib/spaceapp-cli \
      /var/lib/spaceapp-cli/providers \
      /var/lib/spaceapp-cli/imported-credentials \
      /var/lib/spaceapp/memory \
      /workspaces \
      /run/spaceapp-cli \
    && printf '%s\n' "$TARGETARCH" > /usr/local/share/spaceapp-cli-architecture
COPY --from=deps-cli --chown=spaceapp:spaceapp /app/node_modules ./node_modules
COPY --from=build --chown=spaceapp:spaceapp /app/packages/cli-host/package.json ./packages/cli-host/package.json
COPY --from=build --chown=spaceapp:spaceapp /app/packages/cli-host/dist ./packages/cli-host/dist
COPY --from=build --chown=spaceapp:spaceapp /app/agent-skills ./agent-skills
# The application's default room project is /opt/spaceapp. CLI sessions run in /etc, as
# /etc/AGENTS.md documents, so that path resolves to /etc in this image. Without it, the
# Getting Started OpenCode pane exits with "chdir(2) failed" before OpenCode starts.
RUN ln -s /etc /opt/spaceapp
ENTRYPOINT ["/app/deploy/docker/cli-entrypoint.sh"]
