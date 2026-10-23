FROM node:22.23.0-trixie-slim@sha256:cfd8f2a5bc50526aee08e88970979f92722828e7dcc6d8983607fb8bff4bdb82 AS build
ARG TARGETARCH
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
  build-essential \
  ca-certificates \
  git \
  liblzma5 \
  python3 \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build \
  && npm prune --omit=dev \
  && (find /app/packages /app/apps /app/node_modules -name '*.map' -delete || true) \
  && node /app/deploy/docker/prepare-container-targets.mjs --target-arch "${TARGETARCH:-amd64}"

FROM node:22.23.0-trixie-slim@sha256:cfd8f2a5bc50526aee08e88970979f92722828e7dcc6d8983607fb8bff4bdb82 AS runtime-base
LABEL org.opencontainers.image.source=https://github.com/oll4com/spaceapp
LABEL org.opencontainers.image.licenses=MIT
ARG NPM_VERSION=11.18.0
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends \
  bash \
  ca-certificates \
  curl \
  git \
  gosu \
  liblzma5 \
  openssh-client \
  postgresql-client \
  procps \
  python3 \
  ripgrep \
  socat \
  sqlite3 \
  sudo \
  tmux \
  && npm install --global --ignore-scripts --no-audit --no-fund "npm@${NPM_VERSION}" \
  && mkdir -p /tmp/npm-security-patches \
  && npm pack --ignore-scripts --no-audit --no-fund --pack-destination /tmp/npm-security-patches \
    brace-expansion@5.0.12 \
    tar@7.5.21 \
    ip-address@10.7.1 \
    undici@6.28.1 \
    postcss-selector-parser@7.1.6 \
  && rm -rf /usr/local/lib/node_modules/npm/node_modules/brace-expansion/* \
  && tar -xzf /tmp/npm-security-patches/brace-expansion-5.0.12.tgz -C /usr/local/lib/node_modules/npm/node_modules/brace-expansion --strip-components=1 \
  && rm -rf /usr/local/lib/node_modules/npm/node_modules/tar/* \
  && tar -xzf /tmp/npm-security-patches/tar-7.5.21.tgz -C /usr/local/lib/node_modules/npm/node_modules/tar --strip-components=1 \
  && rm -rf /usr/local/lib/node_modules/npm/node_modules/ip-address/* \
  && tar -xzf /tmp/npm-security-patches/ip-address-10.7.1.tgz -C /usr/local/lib/node_modules/npm/node_modules/ip-address --strip-components=1 \
  && rm -rf /usr/local/lib/node_modules/npm/node_modules/postcss-selector-parser/* \
  && tar -xzf /tmp/npm-security-patches/postcss-selector-parser-7.1.6.tgz -C /usr/local/lib/node_modules/npm/node_modules/postcss-selector-parser --strip-components=1 \
  && rm -rf /usr/local/lib/node_modules/npm/node_modules/undici/* \
  && tar -xzf /tmp/npm-security-patches/undici-6.28.1.tgz -C /usr/local/lib/node_modules/npm/node_modules/undici --strip-components=1 \
  && rm -rf /tmp/npm-security-patches \
  && npm cache clean --force \
  && groupadd --gid 10001 spaceapp \
  && useradd --uid 10001 --gid 10001 --create-home --shell /bin/bash spaceapp \
  && mkdir -p /var/lib/spaceapp /var/lib/spaceapp/memory /var/lib/spaceapp-cli /run/spaceapp /run/spaceapp-cli /run/spaceapp-browser /workspaces /backups \
  && chown -R spaceapp:spaceapp /app /var/lib/spaceapp /var/lib/spaceapp-cli /run/spaceapp /run/spaceapp-cli /run/spaceapp-browser /workspaces /backups \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build --chown=spaceapp:spaceapp /app/LICENSE /app/NOTICE /app/THIRD_PARTY_NOTICES.md ./
COPY --from=build --chown=spaceapp:spaceapp /app/THIRD_PARTY_LICENSES ./THIRD_PARTY_LICENSES
COPY --from=build --chown=spaceapp:spaceapp /app/deploy/docker ./deploy/docker

RUN chmod +x /app/deploy/docker/*.sh /app/deploy/docker/*.mjs \
  && for cli in codex claude gemini opencode autohand qwen kimi grok deepseek cursor copilot; do \
    ln -sf /app/deploy/docker/cli-wrapper.sh "/usr/local/bin/${cli}-vscode-parity"; \
  done

FROM runtime-base AS core
COPY --from=build --chown=spaceapp:spaceapp /app/targets/core/ /app/
COPY --from=build --chown=spaceapp:spaceapp /app/starter-memory /opt/spaceapp/starter-memory
COPY --from=build --chown=spaceapp:spaceapp /app/scripts/reset-owner-password.mjs ./scripts/reset-owner-password.mjs
COPY --from=build --chown=spaceapp:spaceapp /app/scripts/rotate-owner-setup-token.mjs ./scripts/rotate-owner-setup-token.mjs
COPY --from=build --chown=spaceapp:spaceapp /app/scripts/portable-backup.mjs ./scripts/portable-backup.mjs
COPY --from=build --chown=spaceapp:spaceapp /app/scripts/portable-restore.mjs ./scripts/portable-restore.mjs
USER spaceapp
EXPOSE 4911
HEALTHCHECK --interval=10s --timeout=5s --start-period=25s --retries=12 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4911/readyz').then(async (r) => { if (!r.ok) process.exit(1); const body = await r.json(); if (body.ok !== true) process.exit(1); }).catch(() => process.exit(1))"]
ENTRYPOINT ["/app/deploy/docker/core-entrypoint.sh"]

FROM runtime-base AS browser
RUN apt-get update && apt-get install -y --no-install-recommends \
  chromium \
  fonts-dejavu-core \
  fonts-liberation \
  liblzma5 \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=spaceapp:spaceapp /app/targets/browser/ /app/
ENV SPACE_CHROMIUM_PATH=/usr/bin/chromium
USER spaceapp
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=8 \
  CMD ["node", "--input-type=module", "-e", "import { BrowserHostSocketClient } from '/app/packages/browser-host/dist/index.js'; const socket = process.env.SPACE_BROWSER_HOST_SOCKET || '/run/spaceapp-browser/browser-host.sock'; const health = await new BrowserHostSocketClient(socket).health(); if (!(health.capacity?.maxSessions >= 8) || !(health.capacity?.maxLiveWorkloads >= 4)) process.exit(1);"]
ENTRYPOINT ["/app/deploy/docker/browser-entrypoint.sh"]

FROM runtime-base AS cli
ARG TARGETARCH
COPY --from=build --chown=spaceapp:spaceapp /app/targets/cli/ /app/
# python3-minimal (about 13 MB): agents often check their work with a short python3 script (pilot F18).
# OpenCode 2 (@opencode/cli): its postinstall picks the native binary for the image's platform.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3-minimal \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global --no-audit --no-fund @opencode/cli@2.0.32 \
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
RUN printf '%s\n' \
  'Defaults:spaceapp !authenticate' \
  'Defaults:spaceapp env_reset' \
  'Defaults:spaceapp secure_path="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"' \
  'spaceapp ALL=(root) NOPASSWD: /usr/sbin/chroot /host /bin/bash -l' \
  >/etc/sudoers.d/spaceapp-host-root \
  && chmod 0440 /etc/sudoers.d/spaceapp-host-root
USER spaceapp
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=8 \
  CMD ["node", "-e", "import('node:fs').then(({ accessSync }) => { accessSync(process.env.SPACE_CLI_HOST_SOCKET || '/run/spaceapp-cli/host.sock'); accessSync(process.env.SPACEAPP_CREDENTIAL_SOCKET || '/run/spaceapp-cli/credentials.sock'); }).catch(() => process.exit(1))"]
ENTRYPOINT ["/app/deploy/docker/cli-entrypoint.sh"]
