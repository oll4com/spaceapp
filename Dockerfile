# syntax=docker/dockerfile:1.7

FROM node:22.23.0-trixie-slim@sha256:cfd8f2a5bc50526aee08e88970979f92722828e7dcc6d8983607fb8bff4bdb82 AS build
ARG TARGETARCH
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential liblzma5 python3 pkg-config \
    && rm -rf /var/lib/apt/lists/*
COPY . .
RUN npm ci --no-audit --no-fund \
    && npm run build \
    && find apps packages -type f \( -name '*.js.map' -o -name '*.mjs.map' -o -name '*.cjs.map' -o -name '*.css.map' \) -delete

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
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/browser-host/package.json packages/browser-host/package.json
COPY packages/cli-host/package.json packages/cli-host/package.json
COPY packages/codex-app-server/package.json packages/codex-app-server/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/gateway/package.json packages/gateway/package.json
COPY packages/icons/package.json packages/icons/package.json
COPY packages/memory-graph/package.json packages/memory-graph/package.json
COPY packages/opencode-control/package.json packages/opencode-control/package.json
COPY packages/runtime/package.json packages/runtime/package.json
COPY packages/run-spaceapp/package.json packages/run-spaceapp/package.json
COPY packages/streaming/package.json packages/streaming/package.json
COPY scripts/prune-container-native-binaries.mjs ./scripts/prune-container-native-binaries.mjs
COPY --from=build --chown=spaceapp:spaceapp /app/LICENSE /app/NOTICE /app/THIRD_PARTY_NOTICES.md ./
COPY --from=build --chown=spaceapp:spaceapp /app/THIRD_PARTY_LICENSES ./THIRD_PARTY_LICENSES
COPY --from=build --chown=spaceapp:spaceapp /app/scripts/reset-owner-password.mjs ./scripts/reset-owner-password.mjs
COPY --from=build --chown=spaceapp:spaceapp /app/scripts/rotate-owner-setup-token.mjs ./scripts/rotate-owner-setup-token.mjs
COPY --from=build --chown=spaceapp:spaceapp /app/scripts/portable-backup.mjs ./scripts/portable-backup.mjs
COPY --from=build --chown=spaceapp:spaceapp /app/scripts/portable-restore.mjs ./scripts/portable-restore.mjs
COPY --chown=spaceapp:spaceapp deploy/docker ./deploy/docker
RUN chmod 0755 deploy/docker/core-entrypoint.sh deploy/docker/browser-entrypoint.sh deploy/docker/cli-entrypoint.sh \
    && install -m 0755 deploy/docker/public-cli-wrapper.sh /usr/local/bin/spaceapp-cli-wrapper \
    && for name in codex claude gemini opencode qwen kimi grok deepseek autohand cursor copilot; do \
         ln -s /usr/local/bin/spaceapp-cli-wrapper "/usr/local/bin/${name}-vscode-parity"; \
       done

# Each target installs only the production dependency closure of the
# workspaces its entrypoints load. The root dependencies are included for
# core because apps/api relies on root-hoisted packages (for example ws).
# The closure stages build on the toolchain-bearing build stage so native
# modules (for example node-pty) can compile; only their node_modules are
# copied into the runtime images.
FROM build AS core-closure
ARG TARGETARCH
RUN npm ci --omit=dev --include-workspace-root --workspace @space/api --workspace @space/worker --workspace @space/db --no-audit --no-fund \
    && mkdir -p apps/api/node_modules apps/worker/node_modules packages/db/node_modules \
    && node scripts/prune-container-native-binaries.mjs --arch "${TARGETARCH}" \
    && find . -type f \( -name '*.js.map' -o -name '*.mjs.map' -o -name '*.cjs.map' -o -name '*.css.map' \) -delete

# The Browser Host entrypoint loads @space/browser-host, @space/db,
# @space/runtime, @space/contracts and @t3-oss/env-core; env-core is copied
# from the build tree because it is an apps/api dependency, not a workspace
# dependency of the two installed workspaces.
FROM build AS browser-closure
ARG TARGETARCH
RUN npm ci --omit=dev --workspace @space/browser-host --workspace @space/db --no-audit --no-fund
COPY --from=build /app/node_modules/@t3-oss/env-core ./node_modules/@t3-oss/env-core
RUN mkdir -p packages/browser-host/node_modules packages/db/node_modules \
    && node scripts/prune-container-native-binaries.mjs --arch "${TARGETARCH}" \
    && find . -type f \( -name '*.js.map' -o -name '*.mjs.map' -o -name '*.cjs.map' -o -name '*.css.map' \) -delete

FROM build AS cli-closure
ARG TARGETARCH
RUN npm ci --omit=dev --workspace @space/cli-host --no-audit --no-fund \
    && mkdir -p packages/cli-host/node_modules \
    && node scripts/prune-container-native-binaries.mjs --arch "${TARGETARCH}" \
    && find . -type f \( -name '*.js.map' -o -name '*.mjs.map' -o -name '*.cjs.map' -o -name '*.css.map' \) -delete

# Slim runtime trees: only the built artifacts each image loads at runtime.
# The workspace directories keep the node_modules/@space symlink targets whole.
FROM build AS core-tree
RUN set -eux; \
    mkdir -p /out/apps/api /out/apps/worker /out/apps/web /out/scripts; \
    cp apps/api/package.json /out/apps/api/package.json; \
    cp -r apps/api/dist /out/apps/api/dist; \
    cp apps/worker/package.json /out/apps/worker/package.json; \
    cp -r apps/worker/dist /out/apps/worker/dist; \
    cp apps/web/package.json /out/apps/web/package.json; \
    cp -r apps/web/dist /out/apps/web/dist; \
    cp apps/web/server.mjs /out/apps/web/server.mjs; \
    for p in browser-host cli-host codex-app-server contracts db gateway memory-graph opencode-control runtime streaming; do \
      mkdir -p "/out/packages/$p"; \
      cp "packages/$p/package.json" "/out/packages/$p/package.json"; \
      cp -r "packages/$p/dist" "/out/packages/$p/dist"; \
    done; \
    cp -r packages/db/migrations /out/packages/db/migrations; \
    cp -r agent-skills /out/agent-skills; \
    cp -r starter-memory /out/starter-memory; \
    cp scripts/reset-owner-password.mjs scripts/rotate-owner-setup-token.mjs \
       scripts/portable-backup.mjs scripts/portable-restore.mjs /out/scripts/

FROM build AS browser-tree
RUN set -eux; \
    mkdir -p /out/apps/api; \
    cp -r apps/api/dist /out/apps/api/dist; \
    for p in browser-host contracts db memory-graph runtime; do \
      mkdir -p "/out/packages/$p"; \
      cp "packages/$p/package.json" "/out/packages/$p/package.json"; \
      cp -r "packages/$p/dist" "/out/packages/$p/dist"; \
    done; \
    cp -r packages/db/migrations /out/packages/db/migrations

FROM build AS cli-tree
RUN set -eux; \
    mkdir -p /out/packages/cli-host /out/agent-skills; \
    cp packages/cli-host/package.json /out/packages/cli-host/package.json; \
    cp -r packages/cli-host/dist /out/packages/cli-host/dist; \
    cp -r agent-skills/. /out/agent-skills/

FROM runtime-base AS core
COPY --from=core-closure --chown=spaceapp:spaceapp /app/node_modules ./node_modules
COPY --from=core-tree --chown=spaceapp:spaceapp /out/apps ./apps
COPY --from=core-tree --chown=spaceapp:spaceapp /out/packages ./packages
COPY --from=core-closure --chown=spaceapp:spaceapp /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=core-closure --chown=spaceapp:spaceapp /app/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=core-closure --chown=spaceapp:spaceapp /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=core-tree --chown=spaceapp:spaceapp /out/agent-skills ./agent-skills
COPY --from=core-tree --chown=spaceapp:spaceapp /out/scripts ./scripts
COPY --from=core-tree --chown=spaceapp:spaceapp /out/starter-memory /opt/spaceapp/starter-memory
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
RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium fonts-liberation liblzma5 xvfb \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -o spaceapp -g spaceapp -m 0700 \
      /var/lib/spaceapp \
      /var/lib/spaceapp/artifacts \
      /run/spaceapp-browser
COPY --from=browser-closure --chown=spaceapp:spaceapp /app/node_modules ./node_modules
COPY --from=browser-tree --chown=spaceapp:spaceapp /out/apps ./apps
COPY --from=browser-tree --chown=spaceapp:spaceapp /out/packages ./packages
COPY --from=browser-closure --chown=spaceapp:spaceapp /app/packages/browser-host/node_modules ./packages/browser-host/node_modules
COPY --from=browser-closure --chown=spaceapp:spaceapp /app/packages/db/node_modules ./packages/db/node_modules
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
    && rm -rf /usr/local/lib/node_modules/@opencode/cli/node_modules/@opencode/cli-* \
    && install -d -o spaceapp -g spaceapp -m 0700 /var/lib/spaceapp-cli/vendor \
    && npm cache clean --force \
    && install -d -o spaceapp -g spaceapp -m 0700 \
      /var/lib/spaceapp-cli \
      /var/lib/spaceapp-cli/providers \
      /var/lib/spaceapp-cli/imported-credentials \
      /var/lib/spaceapp/memory \
      /workspaces \
      /run/spaceapp-cli \
    && printf '%s\n' "$TARGETARCH" > /usr/local/share/spaceapp-cli-architecture
# The application's default room project is /opt/spaceapp. CLI sessions run in /etc, as
# /etc/AGENTS.md documents, so that path resolves to /etc in this image. Without it, the
# Getting Started OpenCode pane exits with "chdir(2) failed" before OpenCode starts.
RUN ln -s /etc /opt/spaceapp
COPY --from=cli-closure --chown=spaceapp:spaceapp /app/node_modules ./node_modules
COPY --from=cli-closure --chown=spaceapp:spaceapp /app/packages/cli-host/node_modules ./packages/cli-host/node_modules
COPY --from=cli-tree --chown=spaceapp:spaceapp /out/packages/cli-host ./packages/cli-host
COPY --from=cli-tree --chown=spaceapp:spaceapp /out/agent-skills ./agent-skills
ENTRYPOINT ["/app/deploy/docker/cli-entrypoint.sh"]
