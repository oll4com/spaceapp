# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=22.23.0

FROM node:${NODE_VERSION}-trixie-slim AS build
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential python3 pkg-config \
    && rm -rf /var/lib/apt/lists/*
COPY . .
RUN npm ci --no-audit --no-fund \
    && npm run build \
    && npm prune --omit=dev

FROM node:${NODE_VERSION}-trixie-slim AS runtime-base
ARG TARGETARCH
ARG NPM_VERSION=11.18.0
ENV NODE_ENV=production \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8
RUN npm install --global --ignore-scripts --no-audit --no-fund "npm@${NPM_VERSION}" \
    && npm cache clean --force \
    && apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates curl git gosu postgresql-client ripgrep \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 spaceapp \
    && useradd --uid 10001 --gid 10001 --create-home --home-dir /var/lib/spaceapp-cli --shell /bin/bash spaceapp
WORKDIR /app
COPY --from=build --chown=spaceapp:spaceapp /app/package.json /app/package-lock.json ./
COPY --from=build --chown=spaceapp:spaceapp /app/node_modules ./node_modules
COPY --from=build --chown=spaceapp:spaceapp /app/apps ./apps
COPY --from=build --chown=spaceapp:spaceapp /app/packages ./packages
COPY --from=build --chown=spaceapp:spaceapp /app/LICENSE /app/NOTICE /app/THIRD_PARTY_NOTICES.md ./
COPY --from=build --chown=spaceapp:spaceapp /app/scripts/reset-owner-password.mjs ./scripts/reset-owner-password.mjs
COPY --from=build --chown=spaceapp:spaceapp /app/scripts/rotate-owner-setup-token.mjs ./scripts/rotate-owner-setup-token.mjs
COPY --from=build --chown=spaceapp:spaceapp /app/scripts/portable-backup.mjs ./scripts/portable-backup.mjs
COPY --from=build --chown=spaceapp:spaceapp /app/scripts/portable-restore.mjs ./scripts/portable-restore.mjs
COPY --chown=spaceapp:spaceapp deploy/docker ./deploy/docker
RUN chmod 0755 deploy/docker/core-entrypoint.sh deploy/docker/browser-entrypoint.sh deploy/docker/cli-entrypoint.sh \
    && install -m 0755 deploy/docker/public-cli-wrapper.sh /usr/local/bin/spaceapp-cli-wrapper \
    && for name in codex claude gemini opencode qwen kimi grok deepseek; do \
         ln -s /usr/local/bin/spaceapp-cli-wrapper "/usr/local/bin/${name}-vscode-parity"; \
       done

FROM runtime-base AS core
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
RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium fonts-liberation \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -o spaceapp -g spaceapp -m 0700 \
      /var/lib/spaceapp \
      /var/lib/spaceapp/artifacts \
      /run/spaceapp-browser
ENV SPACE_BROWSER_CHROME_PATH=/usr/bin/chromium \
    SPACE_BROWSER_SESSIONS_CHROME_PATH=/usr/bin/chromium
ENTRYPOINT ["/app/deploy/docker/browser-entrypoint.sh"]

FROM runtime-base AS cli
ARG TARGETARCH
RUN npm install --global --ignore-scripts --no-audit --no-fund \
      @openai/codex@0.145.0 \
      @google/gemini-cli@0.52.0 \
      @qwen-code/qwen-code@0.20.1 \
      @moonshot-ai/kimi-code@0.29.0 \
      @xai-official/grok@0.2.111 \
    && npm install --global --no-audit --no-fund opencode-ai@1.18.4 \
    && npm install --global --ignore-scripts --no-audit --no-fund \
      run-deepseek-cli@0.1.1 \
    && install -d -o spaceapp -g spaceapp -m 0700 \
      /var/lib/spaceapp-cli \
      /var/lib/spaceapp-cli/providers \
      /var/lib/spaceapp-cli/imported-credentials \
      /var/lib/spaceapp/memory \
      /workspaces \
      /run/spaceapp-cli \
    && printf '%s\n' "$TARGETARCH" > /usr/local/share/spaceapp-cli-architecture
ENTRYPOINT ["/app/deploy/docker/cli-entrypoint.sh"]
