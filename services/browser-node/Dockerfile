ARG BASE_IMAGE=popcorn-base:local

FROM ${BASE_IMAGE}
ARG SOURCE_DATE_EPOCH=0

ENV DEBIAN_FRONTEND=noninteractive

USER root
# Install runtime tools
RUN set -eux; \
    touch_start="$(date -u +'%Y-%m-%d %H:%M:%S')"; \
    apt-get update; \
    apt-get --no-install-recommends -y install curl jq; \
    apt-get clean && rm -rf /var/lib/apt/lists/* && \
    rm -f /etc/machine-id /var/lib/dbus/machine-id /var/cache/ldconfig/aux-cache \
      /run/systemd/resolve/stub-resolv.conf && \
    rm -rf /var/cache/debconf/* && \
    find /var/log -mindepth 1 -delete && \
    find /etc /home /root /run /tmp /usr /var -xdev \
      \( -path /etc/hosts -o -path /etc/hostname -o -path /etc/resolv.conf \) -prune -o \
      -newerct "$touch_start" \
      -exec touch -h -d "@${SOURCE_DATE_EPOCH}" {} +

RUN --mount=type=bind,source=entrypoint.sh,target=/tmp/entrypoint.sh,ro \
    set -eux; \
    touch_start="$(date -u +'%Y-%m-%d %H:%M:%S')"; \
    install -m0755 /tmp/entrypoint.sh /docker-entrypoint.sh; \
    rm -f /etc/machine-id /var/lib/dbus/machine-id /var/cache/ldconfig/aux-cache \
      /run/systemd/resolve/stub-resolv.conf; \
    rm -rf /var/cache/debconf/*; \
    find /var/log -mindepth 1 -delete; \
    mkdir -p /var/log/app; \
    find / \
      \( -path /proc -o -path /sys -o -path /dev -o -path /etc/hosts -o -path /etc/hostname -o -path /etc/resolv.conf \) -prune -o \
      -newerct "$touch_start" \
      -exec touch -h -d "@${SOURCE_DATE_EPOCH}" {} +


ENTRYPOINT ["/bin/sh", "-c", "mkdir -p /var/log/app && /docker-entrypoint.sh 2>&1 | tee -a /var/log/app/entrypoint.log"]
