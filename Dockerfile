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
    && npm prune --omit=dev \
    && find node_modules -type f \( -name '*.js.map' -o -name '*.mjs.map' -o -name '*.cjs.map' -o -name '*.css.map' \) -delete \
    && node deploy/docker/stage-target.mjs --target core --repo-root /app --staging /staging/core \
    && node deploy/docker/stage-target.mjs --target browser --repo-root /app --staging /staging/browser \
    && node deploy/docker/stage-target.mjs --target cli --repo-root /app --staging /staging/cli \
    && cd /staging/core && npm ci --omit=dev --no-audit --no-fund $(sed 's/^/--workspace /' install-workspaces.txt | tr '\n' ' ') \
    && cd /staging/browser && npm ci --omit=dev --no-audit --no-fund $(sed 's/^/--workspace /' install-workspaces.txt | tr '\n' ' ') \
    && rm -rf /staging/browser/node_modules/@space/cli-host /staging/browser/node_modules/node-pty /staging/browser/node_modules/@temporalio \
    && cd /staging/cli && npm ci --omit=dev --no-audit --no-fund $(sed 's/^/--workspace /' workspaces.txt | tr '\n' ' ') \
    && for tree in /staging/core /staging/browser /staging/cli; do \
         find "$tree/node_modules" -type d -name prebuilds 2>/dev/null | while read -r pdb; do \
           for sub in "$pdb"/*; do \
             [ -d "$sub" ] || continue; \
             case "$(basename "$sub")" in *linux*) : ;; *) rm -rf "$sub" ;; esac; \
           done; \
         done; \
         find "$tree/node_modules" -type d \( -name '*musl*' -o -name '*darwin*' -o -name '*win32*' -o -name '*android*' -o -name '*freebsd*' \) -prune -exec rm -rf {} + 2>/dev/null; \
         rm -rf "$tree/node_modules/@types/node" 2>/dev/null; \
         find "$tree" -type f \( -name '*.js.map' -o -name '*.mjs.map' -o -name '*.cjs.map' -o -name '*.css.map' \) -delete 2>/dev/null; \
         rm -f "$tree/node_modules/node-pty/build/Makefile" "$tree/node_modules/node-pty/build/config.gypi" 2>/dev/null; \
         find "$tree/node_modules/@space" -maxdepth 1 -type l 2>/dev/null | while read -r sl; do [ -e "$sl" ] || rm -f "$sl"; done; \
         rm -f "$tree/workspaces.txt" "$tree/install-workspaces.txt" "$tree/excludes.txt" 2>/dev/null; \
         case "$TARGETARCH" in \
           amd64) find "$tree/node_modules" -type d -name '*linux-arm64*' -prune -exec rm -rf {} + 2>/dev/null ;; \
           arm64) find "$tree/node_modules" -type d -name '*linux-x64*' -prune -exec rm -rf {} + 2>/dev/null ;; \
         esac; \
       done \
    && npm cache clean --force

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
COPY --from=build --chown=spaceapp:spaceapp /app/THIRD_PARTY_LICENSES ./THIRD_PARTY_LICENSES
COPY --chown=spaceapp:spaceapp deploy/docker ./deploy/docker
RUN chmod 0755 deploy/docker/core-entrypoint.sh deploy/docker/browser-entrypoint.sh deploy/docker/cli-entrypoint.sh \
    && install -m 0755 deploy/docker/public-cli-wrapper.sh /usr/local/bin/spaceapp-cli-wrapper \
    && for name in codex claude gemini opencode qwen kimi grok deepseek autohand cursor copilot; do \
         ln -s /usr/local/bin/spaceapp-cli-wrapper "/usr/local/bin/${name}-vscode-parity"; \
       done

FROM runtime-base AS core
COPY --from=build --chown=spaceapp:spaceapp /staging/core/ ./
RUN node deploy/docker/stage-target.mjs --verify --target core --repo-root /app \
    && install -d -o spaceapp -g spaceapp -m 0755 /opt/spaceapp \
    && cp -r /app/starter-memory /opt/spaceapp/starter-memory \
    && chown -R spaceapp:spaceapp /opt/spaceapp/starter-memory \
    && rm -rf /app/starter-memory \
    && test -f /app/scripts/rotate-owner-setup-token.mjs && test -f /app/scripts/reset-owner-password.mjs \
    && test -f /app/scripts/portable-backup.mjs && test -f /app/scripts/portable-restore.mjs \
    && install -d -o spaceapp -g spaceapp -m 0700 \
      /var/lib/spaceapp \
      /var/lib/spaceapp/artifacts \
      /var/lib/spaceapp/memory \
      /run/spaceapp-cli
EXPOSE 4911
HEALTHCHECK --interval=15s --timeout=5s --start-period=45s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4911/readyz').then(async r=>{const body=await r.json();if(!r.ok||body.ok !== true)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT ["/app/deploy/docker/core-entrypoint.sh"]

FROM runtime-base AS browser
COPY --from=build --chown=spaceapp:spaceapp /staging/browser/ ./
# Xvfb: managed browser sessions run headed by default (the API spawns /usr/bin/Xvfb) and the launcher's profiles
# keep that default, so a browser pane cannot open a page without the X server in this image.
RUN node deploy/docker/stage-target.mjs --verify --target browser --repo-root /app \
    && apt-get update \
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
COPY --from=build --chown=spaceapp:spaceapp /staging/cli/ ./
RUN node deploy/docker/stage-target.mjs --verify --target cli --repo-root /app
COPY --chown=root:root starter-memory/AGENTS.md /etc/AGENTS.md
COPY --chown=root:root starter-memory/installation-guide.md /etc/spaceapp-installation-guide.md
RUN chmod 0644 /etc/AGENTS.md
ARG TARGETARCH
# python3-minimal (about 13 MB): agents often check their work with a short python3 script (pilot F18).
# OpenCode 2 (@opencode/cli): its postinstall picks the native binary for the image's platform.
# The package also installs the musl builds of that binary; they never run on this glibc image, so
# they are stripped like the foreign-platform packages of the staged trees.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3-minimal \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global --no-audit --no-fund @opencode/cli@2.0.32 \
    && find /usr/local/lib/node_modules/@opencode/cli/node_modules/@opencode -mindepth 1 -maxdepth 1 -type d -name '*musl*' -exec rm -rf {} + \
    && test -x /usr/local/lib/node_modules/@opencode/cli/bin/opencode.exe \
    && test -z "$(find /usr/local/lib/node_modules/@opencode/cli/node_modules/@opencode -mindepth 1 -maxdepth 1 -name '*musl*')" \
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
