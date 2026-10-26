# Rebuild only Xvnc; keep the base browser, viewer and proxy unchanged.
ARG BASE_IMAGE=popcorn/minimal-vnc-desktop:local
ARG UBUNTU_IMAGE=docker.io/ubuntu:22.04@sha256:962f6cadeae0ea6284001009daa4cc9a8c37e75d1f5191cf0eb83fe565b63dd7
FROM ${BASE_IMAGE} AS base
FROM ${UBUNTU_IMAGE} AS xvnc-builder
USER root
ARG SOURCE_DATE_EPOCH=0
ARG UBUNTU_SNAPSHOT
ENV DEBIAN_FRONTEND=noninteractive
WORKDIR /build
COPY --from=base /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY locks/apt-packages.txt /build/apt-packages.txt
COPY locks/ubuntu-snapshot.lock /build/ubuntu-snapshot.lock
COPY native-input/install-build-deps.sh /build/install-build-deps.sh
RUN bash /build/install-build-deps.sh
COPY native-input/tigervnc-device-types.patch /build/tigervnc-device-types.patch
COPY native-input/build-xvnc.sh /build/build-xvnc.sh
RUN bash /build/build-xvnc.sh

FROM base
USER root
COPY --from=xvnc-builder /out /tmp/popcorn-xvnc
RUN dpkg -i /tmp/popcorn-xvnc/tigervnc-common_*.deb /tmp/popcorn-xvnc/tigervnc-standalone-server_*.deb \
    && mkdir -p /usr/share/doc/popcorn/native-input \
    && cp /tmp/popcorn-xvnc/tigervnc-device-types.patch /tmp/popcorn-xvnc/version /usr/share/doc/popcorn/native-input/ \
    && rm -rf /tmp/popcorn-xvnc
USER kernel
