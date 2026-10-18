# syntax=docker/dockerfile:1.7

FROM node:22.23.0-trixie-slim@sha256:cfd8f2a5bc50526aee08e88970979f92722828e7dcc6d8983607fb8bff4bdb82 AS build
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential liblzma5 python3 pkg-config \
    && rm -rf /var/lib/apt/lists/*
COPY . .
# The production dependency trees are built per target in the deps-* stages,
# so the build stage keeps its full dev install (typecheck, bundlers).
RUN npm ci --no-audit --no-fund \
    && npm run build

# Per-target production dependency closures (#64): each stage reinstalls from
# the lockfile with --omit=dev limited to the workspaces that target runs, so
# its node_modules contains only that target's production closure. The trim
# step removes source maps and the prebuilt native libraries for platforms the
# image never runs on. Workspace build outputs (apps/*/dist, packages/*/dist)
# are not part of node_modules and survive the reinstall.
FROM build AS deps-core
ARG TARGETARCH
RUN npm ci --no-audit --no-fund --omit=dev -w apps/api -w apps/worker \
    && node scripts/container-image-trim.mjs --target core --arch "${TARGETARCH}" \
    && find apps packages \
         -type d \( -name node_modules -o -name dist \) -prune \
         -o -type d \( -name src -o -name __tests__ \) -prune -exec rm -rf {} + \
    && find apps packages \
         -type d \( -name node_modules -o -name dist \) -prune \
         -o -type f \( -name '*.test.js' -o -name '*.test.mjs' -o -name '*.test-d.ts' \) -exec rm -f {} + \
    && find apps packages -maxdepth 3 -name node_modules -type d -print

FROM build AS deps-browser
ARG TARGETARCH
RUN npm ci --no-audit --no-fund --omit=dev -w apps/api \
    && node scripts/container-image-trim.mjs --target browser --arch "${TARGETARCH}" \
    && find apps packages \
         -type d \( -name node_modules -o -name dist \) -prune \
         -o -type d \( -name src -o -name __tests__ \) -prune -exec rm -rf {} + \
    && find apps packages \
         -type d \( -name node_modules -o -name dist \) -prune \
         -o -type f \( -name '*.test.js' -o -name '*.test.mjs' -o -name '*.test-d.ts' \) -exec rm -f {} + \
    && find apps packages -maxdepth 3 -name node_modules -type d -print

FROM build AS deps-cli
ARG TARGETARCH
RUN npm ci --no-audit --no-fund --omit=dev -w packages/cli-host \
    && node scripts/container-image-trim.mjs --target cli --arch "${TARGETARCH}" \
    && find apps packages \
         -type d \( -name node_modules -o -name dist \) -prune \
         -o -type d \( -name src -o -name __tests__ \) -prune -exec rm -rf {} + \
    && find apps packages \
         -type d \( -name node_modules -o -name dist \) -prune \
         -o -type f \( -name '*.test.js' -o -name '*.test.mjs' -o -name '*.test-d.ts' \) -exec rm -f {} + \
    && find apps packages -maxdepth 3 -name node_modules -type d -print

FROM node:22.23.0-trixie-slim@sha256:cfd8f2a5bc50526aee08e88970979f92722828e7dcc6d8983607fb8bff4bdb82 AS runtime-base
ARG TARGETARCH
ARG NPM_VERSION=11.18.0
ENV NODE_ENV=production \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8
LABEL org.opencontainers.image.source=https://github.com/oll4com/spaceapp
LABEL org.opencontainers.image.licenses=BUSL-1.1
RUN npm install --global --ignore-scripts --no-audit --no-fund "npm@${NPM_VERSION}" \
    && install -d /tmp/npm-security-patches \
    && npm pack --ignore-scripts --no-audit --no-fund --pack-destination /tmp/npm-security-patches \
      brace-expansion@5.0.12 tar@7.5.21 ip-address@10.7.1 undici@6.28.1 postcss-selector-parser@7.1.6 \
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
    && tar -xzf /tmp/npm-security-patches/ip-address-10.7.1.tgz \
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
COPY --from=build --chown=spaceapp:spaceapp /app/LICENSE /app/NOTICE /app/THIRD_PARTY_NOTICES.md ./
COPY --chown=spaceapp:spaceapp deploy/docker ./deploy/docker
RUN chmod 0755 deploy/docker/core-entrypoint.sh deploy/docker/browser-entrypoint.sh deploy/docker/cli-entrypoint.sh \
    && install -m 0755 deploy/docker/public-cli-wrapper.sh /usr/local/bin/spaceapp-cli-wrapper \
    && for name in codex claude gemini opencode qwen kimi grok deepseek autohand cursor copilot; do \
         ln -s /usr/local/bin/spaceapp-cli-wrapper "/usr/local/bin/${name}-vscode-parity"; \
       done

# Core: API, Temporal worker, static web server and migrations. The image
# carries the apps/api + apps/worker production closure, the workspace build
# outputs it runs, the owner/backup scripts and the starter memory.
FROM runtime-base AS core
COPY --from=deps-core --chown=spaceapp:spaceapp /app/node_modules ./node_modules
COPY --from=deps-core --chown=spaceapp:spaceapp \
    /app/apps/api ./apps/api
COPY --from=deps-core --chown=spaceapp:spaceapp \
    /app/apps/worker ./apps/worker
COPY --from=deps-core --chown=spaceapp:spaceapp /app/apps/web/dist ./apps/web/dist
COPY --from=deps-core --chown=spaceapp:spaceapp /app/apps/web/server.mjs ./apps/web/server.mjs
COPY --from=deps-core --chown=spaceapp:spaceapp /app/apps/web/package.json ./apps/web/package.json
COPY --from=deps-core --chown=spaceapp:spaceapp \
    /app/packages/browser-host ./packages/browser-host
COPY --from=deps-core --chown=spaceapp:spaceapp \
    /app/packages/cli-host ./packages/cli-host
COPY --from=deps-core --chown=spaceapp:spaceapp \
    /app/packages/codex-app-server ./packages/codex-app-server
COPY --from=deps-core --chown=spaceapp:spaceapp \
    /app/packages/contracts ./packages/contracts
COPY --from=deps-core --chown=spaceapp:spaceapp \
    /app/packages/db ./packages/db
COPY --from=deps-core --chown=spaceapp:spaceapp \
    /app/packages/gateway ./packages/gateway
COPY --from=deps-core --chown=spaceapp:spaceapp \
    /app/packages/memory-graph ./packages/memory-graph
COPY --from=deps-core --chown=spaceapp:spaceapp \
    /app/packages/opencode-control ./packages/opencode-control
COPY --from=deps-core --chown=spaceapp:spaceapp \
    /app/packages/runtime ./packages/runtime
COPY --from=deps-core --chown=spaceapp:spaceapp \
    /app/packages/streaming ./packages/streaming
COPY --from=build --chown=spaceapp:spaceapp /app/agent-skills ./agent-skills
COPY --from=build --chown=spaceapp:spaceapp /app/scripts/reset-owner-password.mjs ./scripts/reset-owner-password.mjs
COPY --from=build --chown=spaceapp:spaceapp /app/scripts/rotate-owner-setup-token.mjs ./scripts/rotate-owner-setup-token.mjs
COPY --from=build --chown=spaceapp:spaceapp /app/scripts/portable-backup.mjs ./scripts/portable-backup.mjs
COPY --from=build --chown=spaceapp:spaceapp /app/scripts/portable-restore.mjs ./scripts/portable-restore.mjs
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

# Browser: Browser Host plus Chromium. The image carries the apps/api
# production closure (the Browser Host entry point lives in apps/api) and
# only the workspaces that entry point imports.
FROM runtime-base AS browser
RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium fonts-liberation liblzma5 \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -o spaceapp -g spaceapp -m 0700 \
      /var/lib/spaceapp \
      /var/lib/spaceapp/artifacts \
      /run/spaceapp-browser
ENV SPACE_BROWSER_CHROME_PATH=/usr/bin/chromium \
    SPACE_BROWSER_SESSIONS_CHROME_PATH=/usr/bin/chromium
COPY --from=deps-browser --chown=spaceapp:spaceapp /app/node_modules ./node_modules
COPY --from=deps-browser --chown=spaceapp:spaceapp \
    /app/apps/api ./apps/api
COPY --from=deps-browser --chown=spaceapp:spaceapp \
    /app/packages/browser-host ./packages/browser-host
COPY --from=deps-browser --chown=spaceapp:spaceapp \
    /app/packages/contracts ./packages/contracts
COPY --from=deps-browser --chown=spaceapp:spaceapp \
    /app/packages/db ./packages/db
COPY --from=deps-browser --chown=spaceapp:spaceapp \
    /app/packages/runtime ./packages/runtime
ENTRYPOINT ["/app/deploy/docker/browser-entrypoint.sh"]

# CLI: the CLI host that runs the AI coding CLIs in PTYs. The image carries
# the packages/cli-host production closure, the agent skills and OpenCode.
FROM runtime-base AS cli
COPY --chown=root:root starter-memory/AGENTS.md /etc/AGENTS.md
COPY --chown=root:root starter-memory/installation-guide.md /etc/spaceapp-installation-guide.md
RUN chmod 0644 /etc/AGENTS.md
ARG TARGETARCH
RUN npm install --global --no-audit --no-fund opencode-ai@1.18.4 \
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
COPY --from=deps-cli --chown=spaceapp:spaceapp /app/node_modules ./node_modules
COPY --from=deps-cli --chown=spaceapp:spaceapp \
    /app/packages/cli-host ./packages/cli-host
COPY --from=build --chown=spaceapp:spaceapp /app/agent-skills ./agent-skills
# The application's default room project is /opt/spaceapp. CLI sessions run in /etc, as
# /etc/AGENTS.md documents, so that path resolves to /etc in this image. Without it, the
# Getting Started OpenCode pane exits with "chdir(2) failed" before OpenCode starts.
RUN ln -s /etc /opt/spaceapp
ENTRYPOINT ["/app/deploy/docker/cli-entrypoint.sh"]
