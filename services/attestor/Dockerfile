# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
ARG GO_IMAGE=golang:1.25.6@sha256:06d1251c59a75761ce4ebc8b299030576233d7437c886a68b43464bad62d4bb1
FROM ${GO_IMAGE} AS builder

WORKDIR /app
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod \
    go mod download

COPY main.go ./
ARG TARGETOS=linux
ARG TARGETARCH=amd64
RUN --mount=type=cache,target=/root/.cache/go-build \
    --mount=type=cache,target=/go/pkg/mod \
    CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build \
    -buildvcs=false \
    -trimpath \
    -ldflags="-s -w -buildid=" \
    -o attestor \
    main.go

FROM scratch AS cosign
ARG COSIGN_VERSION=v2.2.3
ARG COSIGN_SHA256=f669f41176cb1d58bb6a3fdb06e24861540cfdb5a571b4ec5eb2218b0df5d304
ADD --checksum=sha256:${COSIGN_SHA256} https://github.com/sigstore/cosign/releases/download/${COSIGN_VERSION}/cosign-linux-amd64 /cosign

FROM ${GO_IMAGE} AS packager
ARG SOURCE_DATE_EPOCH=0

RUN mkdir -p /rootfs/app \
    /rootfs/usr/local/bin \
    /rootfs/etc/ssl/certs

COPY --from=builder /app/attestor /rootfs/usr/local/bin/attestor
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /rootfs/etc/ssl/certs/ca-certificates.crt
COPY --from=cosign /cosign /rootfs/usr/local/bin/cosign
COPY cosign.pub /rootfs/etc/cosign.pub

RUN chmod 0555 /rootfs/usr/local/bin/attestor /rootfs/usr/local/bin/cosign && \
    chmod 0644 /rootfs/etc/ssl/certs/ca-certificates.crt /rootfs/etc/cosign.pub && \
    find /rootfs -exec touch -h -d "@${SOURCE_DATE_EPOCH}" {} +

FROM scratch

COPY --from=packager /rootfs/ /

EXPOSE 8085

ENTRYPOINT ["/usr/local/bin/attestor"]
