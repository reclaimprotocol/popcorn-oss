# Build from the repository root. Only the viewer is shared with the other image;
# the runtime and browser come from Clearcote's published image.
ARG GOLANG_IMAGE=docker.io/golang:1.26@sha256:5f3787b7f902c07c7ec4f3aa91a301a3eda8133aa32661a3b3a3a86ab3a68a36
ARG CLEARCOTE_IMAGE=docker.io/teamflatearth/clearcote@sha256:16fd05fdf6617e600215adc8a33d5714c7fce60c1f7b20fcd796e15232f5b73f
FROM ${GOLANG_IMAGE} AS proxy-builder
WORKDIR /src
COPY images/minimal-vnc-desktop/proxy/go.mod images/minimal-vnc-desktop/proxy/go.sum ./
RUN go mod download
COPY images/minimal-vnc-desktop/proxy/*.go ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -buildvcs=false -trimpath -ldflags="-s -w -buildid=" -o /out/novnc-proxy .

FROM ${CLEARCOTE_IMAGE}
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    tigervnc-standalone-server tigervnc-common openbox xdotool x11-utils \
    x11-xserver-utils unclutter procps dbus-x11 brotli \
    libgl1-mesa-dri libegl-mesa0 libglx-mesa0 \
    && rm -rf /var/lib/apt/lists/*
RUN ln -sf /usr/bin/Xtigervnc /usr/local/bin/Xvnc \
    && ln -sf /usr/bin/tigervncconfig /usr/local/bin/vncconfig \
    && mkdir -p /var/log/app /home/cc/.config /home/cc/user-data /tmp/.X11-unix \
    && chmod 1777 /tmp/.X11-unix && chown -R cc:cc /var/log/app /home/cc
COPY --from=proxy-builder /out/novnc-proxy /usr/local/bin/novnc-proxy
COPY --chmod=0755 images/minimal-vnc-desktop/entrypoint.sh /usr/local/bin/minimal-vnc-entrypoint
COPY --chmod=0755 images/clearcote-vnc-desktop/start-clearcote /usr/local/bin/start-clearcote
COPY images/minimal-vnc-desktop/liveview.html images/minimal-vnc-desktop/viewer.js images/minimal-vnc-desktop/kbd-autofocus.js /usr/share/novnc/
COPY images/minimal-vnc-desktop/kbd /usr/share/novnc/kbd
COPY packages/trusted-liveview/bootstrap.js packages/trusted-liveview/noise.js /usr/share/novnc/e2e/
COPY images/minimal-vnc-desktop/locks/novnc.lock images/minimal-vnc-desktop/locks/esbuild.lock images/minimal-vnc-desktop/locks/noble.lock /tmp/viewer-locks/
COPY images/clearcote-vnc-desktop/build-viewer.py /tmp/build-viewer.py
RUN python /tmp/build-viewer.py && rm -rf /tmp/build-viewer.py /tmp/viewer-locks
ENV HOME=/home/cc XDG_CONFIG_HOME=/home/cc/.config XDG_CACHE_HOME=/opt/xdg-cache \
    WIDTH=1920 HEIGHT=1080 DISPLAY_NUM=1 MVD_EMULATOR_OFF=1 ENABLE_AGONES=false \
    APP_COMMAND=/usr/local/bin/start-clearcote READY_WINDOW_PATTERN="chromium|chrome|clearcote" \
    CC_PLATFORM=windows CC_FINGERPRINT=popcorn-windows-1920 CC_TIMEZONE=Asia/Kolkata \
    CC_ACCEPT_LANGUAGE=en-IN,en CC_PORT=9230 CC_INTERNAL_PORT=9223 \
    CC_PROFILE_DIR=/home/cc/.config/clearcote-kiosk
USER cc
EXPOSE 6080 9226
ENTRYPOINT ["/usr/local/bin/minimal-vnc-entrypoint"]
