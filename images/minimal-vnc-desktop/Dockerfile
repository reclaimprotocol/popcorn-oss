# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
ARG GOLANG_IMAGE=docker.io/golang:1.26@sha256:5f3787b7f902c07c7ec4f3aa91a301a3eda8133aa32661a3b3a3a86ab3a68a36
ARG UBUNTU_IMAGE=docker.io/ubuntu:22.04@sha256:962f6cadeae0ea6284001009daa4cc9a8c37e75d1f5191cf0eb83fe565b63dd7

FROM ${GOLANG_IMAGE} AS proxy-builder
WORKDIR /src
ARG TARGETARCH
ARG TARGETOS
ARG SOURCE_DATE_EPOCH=0
COPY proxy/go.mod proxy/go.sum ./
COPY proxy/*.go ./
COPY proxy/circuits ./circuits
RUN --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=1 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH:-amd64} \
    go build -buildvcs=false -trimpath -ldflags="-s -w -buildid=" -o /out/novnc-proxy .

FROM ${UBUNTU_IMAGE} AS ubuntu-snapshot
ARG UBUNTU_SNAPSHOT=20260624T000000Z
ARG SOURCE_DATE_EPOCH=0
RUN --mount=from=proxy-builder,source=/etc/ssl/certs/ca-certificates.crt,target=/tmp/ca-certificates.crt,ro \
    set -eux; \
    rm -f /etc/apt/sources.list.d/*.sources /etc/apt/sources.list.d/*.list; \
    mkdir -p /etc/ssl/certs /etc/apt/apt.conf.d; \
    install -m0644 /tmp/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt; \
    printf '%s\n' \
        "deb https://snapshot.ubuntu.com/ubuntu/${UBUNTU_SNAPSHOT}/ jammy main restricted universe multiverse" \
        "deb https://snapshot.ubuntu.com/ubuntu/${UBUNTU_SNAPSHOT}/ jammy-updates main restricted universe multiverse" \
        "deb https://snapshot.ubuntu.com/ubuntu/${UBUNTU_SNAPSHOT}/ jammy-backports main restricted universe multiverse" \
        "deb https://snapshot.ubuntu.com/ubuntu/${UBUNTU_SNAPSHOT}/ jammy-security main restricted universe multiverse" \
        >/etc/apt/sources.list; \
    printf 'Acquire::Check-Valid-Until "false";\nAcquire::Retries "3";\n' >/etc/apt/apt.conf.d/99snapshot; \
    touch -h -d "@${SOURCE_DATE_EPOCH}" \
        /etc \
        /etc/apt \
        /etc/apt/apt.conf.d \
        /etc/apt/apt.conf.d/99snapshot \
        /etc/apt/sources.list \
        /etc/ssl \
        /etc/ssl/certs \
        /etc/ssl/certs/ca-certificates.crt

FROM ubuntu-snapshot AS runtime
ARG TARGETARCH
ARG TARGETOS
ARG SOURCE_DATE_EPOCH=0
ARG CACHEIDPREFIX=${TARGETOS:-linux}-${TARGETARCH:-amd64}-minimal-vnc
ENV DEBIAN_FRONTEND=noninteractive
ENV DISPLAY_NUM=1
ENV WIDTH=1920
ENV HEIGHT=1080
ENV DEPTH=24
ENV VNC_PORT=5900
ENV NOVNC_PORT=6080
ENV CDP_INTERNAL_PORT=9223
ENV CHROME_REMOTE_DEBUGGING_PORT=9223
ENV CDP_RESTRICTED_PORT=9222
ENV CDP_FULL_PORT=9226
ENV APP_COMMAND=/usr/local/bin/start-chromium
ENV APP_URL=
ENV READY_FILE=/tmp/minimal-vnc-ready
ENV READY_TIMEOUT=30
ENV HOME=/home/kernel
ENV XDG_CONFIG_HOME=/home/kernel/.config
ENV XDG_CACHE_HOME=/home/kernel/.cache

COPY locks/apt-packages.txt /tmp/apt-packages.txt
COPY locks/chromium-artifacts.tsv /tmp/chromium-artifacts.tsv
COPY locks/novnc.lock /tmp/novnc.lock

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked,id=$CACHEIDPREFIX-apt-cache \
    --mount=type=cache,target=/var/lib/apt,sharing=locked,id=$CACHEIDPREFIX-apt-lib \
    --mount=from=minimal-vnc-artifacts,source=/artifacts,target=/mnt/artifacts,ro \
    set -eux; \
    touch_start="$(date -u +'%Y-%m-%d %H:%M:%S')"; \
    rm -f /etc/apt/apt.conf.d/docker-clean; \
    echo 'Binary::apt::APT::Keep-Downloaded-Packages "true";' >/etc/apt/apt.conf.d/keep-cache; \
    package_args="$(grep -vE '^[[:space:]]*(#|$)' /tmp/apt-packages.txt | tr '\n' ' ')"; \
    apt-get update; \
    apt-get --no-install-recommends -y install ${package_args}; \
    arch="${TARGETARCH:-amd64}"; \
    case "$arch" in amd64|arm64) ;; *) echo "unsupported target arch: $arch" >&2; exit 1 ;; esac; \
    mkdir -p /tmp/chromium-artifacts; \
    cp -a /mnt/artifacts/debs/. /tmp/chromium-artifacts/; \
    awk -F '\t' -v arch="$arch" 'NF == 5 && $1 == arch { print $2 "\t" $3 "\t" $4 "\t" $5 }' /tmp/chromium-artifacts.tsv | \
    while IFS="$(printf '\t')" read -r name filename url sha256; do \
        echo "verifying ${name} (${filename}) from prepared artifact context"; \
        test -f "/tmp/chromium-artifacts/${filename}"; \
        echo "${sha256}  /tmp/chromium-artifacts/${filename}" | sha256sum -c -; \
    done; \
    apt-get --no-install-recommends -y install /tmp/chromium-artifacts/*.deb; \
    novnc_version="$(awk -F '=' '$1 == "version" { print $2 }' /tmp/novnc.lock)"; \
    novnc_url="$(awk -F '=' '$1 == "url" { print $2 }' /tmp/novnc.lock)"; \
    novnc_sha256="$(awk -F '=' '$1 == "sha256" { print $2 }' /tmp/novnc.lock)"; \
    mkdir -p /tmp/novnc-src /usr/share/novnc; \
    curl --fail --location --retry 5 --retry-all-errors --retry-delay 2 --output /tmp/novnc.tar.gz "$novnc_url"; \
    echo "${novnc_sha256}  /tmp/novnc.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/novnc.tar.gz --strip-components=1 -C /tmp/novnc-src; \
    cp -a /tmp/novnc-src/core /tmp/novnc-src/vendor /usr/share/novnc/; \
    cp -a /tmp/novnc-src/LICENSE.txt "/usr/share/novnc/LICENSE.noVNC-${novnc_version}.txt"; \
    apt-get purge -y --auto-remove curl xz-utils; \
    rm -rf /tmp/chromium-artifacts /tmp/novnc-src /tmp/novnc.tar.gz /tmp/apt-packages.txt /tmp/chromium-artifacts.tsv /tmp/novnc.lock; \
    useradd -m -s /bin/bash kernel; \
    mkdir -p /home/kernel/user-data /home/kernel/.config/openbox /home/kernel/.cache /tmp/.X11-unix /var/log/minimal-vnc; \
    printf '<openbox_config xmlns="http://openbox.org/3.4/rc"><applications /></openbox_config>\n' >/home/kernel/.config/openbox/rc.xml; \
    chown -R kernel:kernel /home/kernel /var/log/minimal-vnc; \
    chmod 1777 /tmp /tmp/.X11-unix; \
    rm -f /etc/machine-id /var/lib/dbus/machine-id /var/cache/ldconfig/aux-cache /run/systemd/resolve/stub-resolv.conf; \
    rm -rf /var/cache/debconf/* /var/cache/fontconfig/* /var/lib/apt/lists/*; \
    find /usr/local/share/fonts /usr/share/fonts -name '.uuid' -delete 2>/dev/null || true; \
    find /var/log -mindepth 1 ! -path /var/log/minimal-vnc ! -path /var/log/minimal-vnc/\* -delete; \
    find /etc /home /run /tmp /usr /var -xdev \
        \( -path /etc/hosts -o -path /etc/hostname -o -path /etc/resolv.conf -o -path /var/cache/apt -o -path /var/cache/apt/\* -o -path /var/lib/apt -o -path /var/lib/apt/\* \) -prune -o \
        -newerct "$touch_start" \
        -exec touch -h -d "@${SOURCE_DATE_EPOCH}" {} +

COPY --from=proxy-builder /out/novnc-proxy /usr/local/bin/novnc-proxy
COPY --chmod=0755 entrypoint.sh /usr/local/bin/minimal-vnc-entrypoint
COPY --chmod=0755 start-chromium /usr/local/bin/start-chromium
COPY liveview.html /usr/share/novnc/liveview.html
COPY --chown=kernel:kernel extensions/proxy /home/kernel/extensions/proxy
COPY --chown=kernel:kernel policies/managed/policy.json /etc/chromium/policies/managed/policy.json
COPY --chown=kernel:kernel policies/variants/policy.reclaim-portal.json /etc/chromium/policy-variants/policy.reclaim-portal.json

RUN set -eux; \
    chown -R kernel:kernel /etc/chromium/policies /etc/chromium/policy-variants; \
    touch -h -d "@${SOURCE_DATE_EPOCH}" \
        /usr/local/bin/novnc-proxy \
        /usr/local/bin/minimal-vnc-entrypoint \
        /usr/local/bin/start-chromium \
        /usr/share/novnc/liveview.html; \
    find /home/kernel/extensions /etc/chromium/policies /etc/chromium/policy-variants -exec touch -h -d "@${SOURCE_DATE_EPOCH}" {} +

USER kernel
EXPOSE 6080 9222 9226
ENTRYPOINT ["/usr/local/bin/minimal-vnc-entrypoint"]
