# Build from the repository root. ShardX is an opt-in local runtime.
ARG GOLANG_IMAGE=docker.io/golang:1.26@sha256:5f3787b7f902c07c7ec4f3aa91a301a3eda8133aa32661a3b3a3a86ab3a68a36
ARG NODE_IMAGE=docker.io/node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d
FROM ${GOLANG_IMAGE} AS proxy-builder
WORKDIR /src
COPY images/minimal-vnc-desktop/proxy/go.mod images/minimal-vnc-desktop/proxy/go.sum ./
RUN go mod download
COPY images/minimal-vnc-desktop/proxy/*.go ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -buildvcs=false -trimpath -ldflags="-s -w -buildid=" -o /out/novnc-proxy .

FROM docker.io/python:3.12-slim-bookworm@sha256:6a0e06f5ba0b373d051aabd3fffb9b873f27f9a2a3a14bcbe37dee6f0e3bbc70 AS viewer-builder
RUN apt-get update && apt-get install -y --no-install-recommends brotli ca-certificates && rm -rf /var/lib/apt/lists/*
COPY images/minimal-vnc-desktop/liveview.html images/minimal-vnc-desktop/viewer.js images/minimal-vnc-desktop/kbd-autofocus.js /usr/share/novnc/
COPY images/minimal-vnc-desktop/kbd /usr/share/novnc/kbd
COPY packages/trusted-liveview/bootstrap.js packages/trusted-liveview/noise.js /usr/share/novnc/e2e/
COPY images/minimal-vnc-desktop/locks/novnc.lock images/minimal-vnc-desktop/locks/esbuild.lock images/minimal-vnc-desktop/locks/noble.lock /tmp/viewer-locks/
COPY images/shard-vnc-desktop/build-viewer.py /tmp/build-viewer.py
RUN python3 /tmp/build-viewer.py && rm -rf /tmp/build-viewer.py /tmp/viewer-locks

# Fonts are renamed at build time; only the renamed copies reach the runtime.
FROM ${NODE_IMAGE} AS font-builder
RUN apt-get update && apt-get install -y --no-install-recommends python3-fonttools \
    fonts-liberation fonts-crosextra-carlito fonts-crosextra-caladea \
    fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji
COPY images/shard-vnc-desktop/rename-fonts.py /tmp/rename-fonts.py
RUN python3 /tmp/rename-fonts.py /out/fonts-windows \
      /usr/share/fonts/truetype/liberation/*.ttf /usr/share/fonts/truetype/crosextra/*.ttf \
      /usr/share/fonts/truetype/noto/Noto*-Regular.ttf /usr/share/fonts/truetype/noto/Noto*-Bold.ttf \
      /usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc /usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc \
      /usr/share/fonts/truetype/noto/NotoColorEmoji.ttf \
    && test -s /out/fonts-windows/NotoSansCJK-Regular.ttc && test -s /out/fonts-windows/NotoSansDevanagari-Regular.ttf

FROM ${NODE_IMAGE}
ARG TARGETARCH
RUN test "$TARGETARCH" = amd64
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 unzip ca-certificates curl brotli tigervnc-standalone-server tigervnc-common \
    openbox xdotool x11-utils x11-xserver-utils unclutter procps dbus-x11 \
    fontconfig libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 \
    libpango-1.0-0 libcairo2 libasound2 libxshmfence1 libgl1-mesa-dri libegl-mesa0 libglx-mesa0 \
    && rm -rf /var/lib/apt/lists/*
RUN ln -s /usr/bin/Xtigervnc /usr/local/bin/Xvnc \
    && ln -s /usr/bin/tigervncconfig /usr/local/bin/vncconfig \
    && useradd -m -s /bin/bash kernel \
    && mkdir -p /var/log/app /home/kernel/user-data /home/kernel/.config /tmp/.X11-unix /usr/share/novnc \
    && chmod 1777 /tmp/.X11-unix && chown -R kernel:kernel /var/log/app /home/kernel
WORKDIR /opt/shard
COPY images/shard-vnc-desktop/package*.json ./
RUN npm ci --ignore-scripts --omit=dev && npm cache clean --force
COPY images/shard-vnc-desktop/runtime.json images/shard-vnc-desktop/artifacts.lock ./
COPY images/shard-vnc-desktop/install-runtime.py ./
RUN python3 install-runtime.py
COPY --from=proxy-builder /out/novnc-proxy /usr/local/bin/novnc-proxy
COPY --chmod=0755 images/minimal-vnc-desktop/entrypoint.sh /usr/local/bin/minimal-vnc-entrypoint
# Windows-named faces are the only fonts the browser sees.
COPY --from=font-builder /out/fonts-windows /usr/local/share/fonts-windows
COPY images/shard-vnc-desktop/fonts.conf ./
RUN FONTCONFIG_FILE=/opt/shard/fonts.conf fc-cache -f
# Same managed policies and kiosk/normal launcher as the main browser image.
COPY --chown=kernel:kernel images/minimal-vnc-desktop/policies/managed/policy.json /etc/chromium/policies/managed/policy.json
COPY --chown=kernel:kernel images/minimal-vnc-desktop/policies/variants/policy.reclaim-portal.json /etc/chromium/policy-variants/policy.reclaim-portal.json
COPY --chmod=0755 images/minimal-vnc-desktop/run-chromium-managed /usr/local/bin/run-chromium-managed
COPY --chmod=0755 images/shard-vnc-desktop/start-shard.mjs /opt/shard/start-shard.mjs
COPY --chown=kernel:kernel images/minimal-vnc-desktop/extensions/proxy /home/kernel/extensions/proxy
COPY --from=viewer-builder /usr/share/novnc /usr/share/novnc
ENV HOME=/home/kernel XDG_CONFIG_HOME=/home/kernel/.config XDG_CACHE_HOME=/home/kernel/.cache \
    WIDTH=1920 HEIGHT=1080 DISPLAY_NUM=1 MVD_EMULATOR_OFF=0 MVD_EMULATOR_ON_VIEWER=1 ENABLE_AGONES=auto \
    FONTCONFIG_FILE=/opt/shard/fonts.conf \
    APP_COMMAND=/usr/local/bin/run-chromium-managed CHROMIUM_LAUNCHER=/opt/shard/start-shard.mjs READY_WINDOW_PATTERN="chromium|chrome|shard" READY_TIMEOUT=60
USER kernel
EXPOSE 6080 9226
ENTRYPOINT ["/usr/local/bin/minimal-vnc-entrypoint"]
