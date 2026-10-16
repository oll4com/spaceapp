# syntax=docker/dockerfile:1.7

FROM node:22.23.0-trixie-slim@sha256:cfd8f2a5bc50526aee08e88970979f92722828e7dcc6d8983607fb8bff4bdb82 AS build
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential liblzma5 python3 pkg-config \
    && rm -rf /var/lib/apt/lists/*
COPY . .
RUN npm ci --no-audit --no-fund \
    && npm run build \
    && npm pkg delete dependencies -w @space/web -w @space/icons \
    && npm pkg delete dependencies.react dependencies.react-dom \
    && npm prune --omit=dev \
    && rm -rf \
      node_modules/typescript \
      node_modules/@swc/core-linux-*-musl \
      node_modules/@napi-rs/canvas-linux-*-musl \
      node_modules/node-pty/prebuilds/win32-* \
      node_modules/node-pty/prebuilds/darwin-* \
      node_modules/node-pty/third_party \
      node_modules/node-pty/deps \
      node_modules/node-pty/src \
      node_modules/@temporalio/core-bridge/sdk-core \
      node_modules/@temporalio/core-bridge/releases/*windows* \
      node_modules/@temporalio/core-bridge/releases/*darwin* \
      apps/web/public \
      apps/web/src \
      apps/web/tests \
      apps/web/node_modules \
      apps/*/src \
      apps/*/tests \
      packages/*/src \
      packages/*/tests \
      packages/run-spaceapp \
    && if [ "$(uname -m)" = "x86_64" ]; then \
         rm -rf node_modules/@temporalio/core-bridge/releases/aarch64-unknown-linux-gnu; \
       else \
         rm -rf node_modules/@temporalio/core-bridge/releases/x86_64-unknown-linux-gnu; \
       fi \
    && find node_modules apps packages -type f \( -name '*.js.map' -o -name '*.mjs.map' -o -name '*.cjs.map' -o -name '*.css.map' -o -name '*.d.ts' -o -name '*.d.ts.map' -o -name '*.tsbuildinfo' \) -delete \
    && install -d /stage/browser/apps/api /stage/browser/packages /stage/browser/node_modules \
    && cp -a apps/api/package.json apps/api/dist /stage/browser/apps/api/ \
    && cp -a node_modules/. /stage/browser/node_modules/ \
    && rm -rf \
      /stage/browser/node_modules/@space \
      /stage/browser/node_modules/@temporalio \
      /stage/browser/node_modules/@swc \
      /stage/browser/node_modules/@napi-rs \
      /stage/browser/node_modules/pdfjs-dist \
      /stage/browser/node_modules/js-tiktoken \
      /stage/browser/node_modules/webpack \
      /stage/browser/node_modules/web-tree-sitter \
      /stage/browser/node_modules/node-pty \
      /stage/browser/node_modules/fastify \
      /stage/browser/node_modules/@fastify \
      /stage/browser/node_modules/@modelcontextprotocol \
      /stage/browser/node_modules/@ai-sdk \
      /stage/browser/node_modules/hono \
      /stage/browser/node_modules/@xterm \
      /stage/browser/node_modules/imapflow \
      /stage/browser/node_modules/mammoth \
      /stage/browser/node_modules/mysql2 \
      /stage/browser/node_modules/jszip \
    && install -d /stage/browser/node_modules/@space \
    && cp -a packages/browser-host packages/contracts packages/db packages/runtime packages/memory-graph /stage/browser/packages/ \
    && ln -s ../../packages/browser-host /stage/browser/node_modules/@space/browser-host \
    && ln -s ../../packages/contracts /stage/browser/node_modules/@space/contracts \
    && ln -s ../../packages/db /stage/browser/node_modules/@space/db \
    && ln -s ../../packages/runtime /stage/browser/node_modules/@space/runtime \
    && ln -s ../../packages/memory-graph /stage/browser/node_modules/@space/memory-graph \
    && install -d /stage/cli/packages /stage/cli/node_modules/@space \
    && cp -a packages/cli-host /stage/cli/packages/cli-host \
    && ln -s ../../packages/cli-host /stage/cli/node_modules/@space/cli-host \
    && cp -a node_modules/node-pty node_modules/node-addon-api /stage/cli/node_modules/

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

FROM runtime-base AS core
COPY --from=build --chown=spaceapp:spaceapp /app/node_modules ./node_modules
COPY --from=build --chown=spaceapp:spaceapp /app/apps ./apps
COPY --from=build --chown=spaceapp:spaceapp /app/packages ./packages
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

FROM runtime-base AS browser
COPY --from=build --chown=spaceapp:spaceapp /stage/browser/node_modules ./node_modules
COPY --from=build --chown=spaceapp:spaceapp /stage/browser/apps ./apps
COPY --from=build --chown=spaceapp:spaceapp /stage/browser/packages ./packages
RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium fonts-liberation liblzma5 \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -o spaceapp -g spaceapp -m 0700 \
      /var/lib/spaceapp \
      /var/lib/spaceapp/artifacts \
      /run/spaceapp-browser
ENV SPACE_BROWSER_CHROME_PATH=/usr/bin/chromium \
    SPACE_BROWSER_SESSIONS_CHROME_PATH=/usr/bin/chromium
ENTRYPOINT ["/app/deploy/docker/browser-entrypoint.sh"]

FROM runtime-base AS cli
COPY --from=build --chown=spaceapp:spaceapp /stage/cli/node_modules ./node_modules
COPY --from=build --chown=spaceapp:spaceapp /stage/cli/packages ./packages
COPY --from=build --chown=spaceapp:spaceapp /app/agent-skills ./agent-skills
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
# The application's default room project is /opt/spaceapp. CLI sessions run in /etc, as
# /etc/AGENTS.md documents, so that path resolves to /etc in this image. Without it, the
# Getting Started OpenCode pane exits with "chdir(2) failed" before OpenCode starts.
RUN ln -s /etc /opt/spaceapp
ENTRYPOINT ["/app/deploy/docker/cli-entrypoint.sh"]
