FROM golang:1.22 AS builder

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download

COPY main.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -o attestor main.go

FROM ubuntu:22.04

# Install runtime dependencies
RUN apt-get update && apt-get install -y curl ca-certificates jq && rm -rf /var/lib/apt/lists/*

# Install snpguest
ENV SNPGUEST_VERSION=v0.10.0
RUN curl -L -o /usr/local/bin/snpguest "https://github.com/virtee/snpguest/releases/download/${SNPGUEST_VERSION}/snpguest" && \
    chmod +x /usr/local/bin/snpguest

# Install Cosign
ENV COSIGN_VERSION=v2.2.3
RUN curl -L -o /usr/local/bin/cosign "https://github.com/sigstore/cosign/releases/download/${COSIGN_VERSION}/cosign-linux-amd64" && \
    chmod +x /usr/local/bin/cosign

# Install ECR Credential Helper
RUN curl -L -o /usr/local/bin/docker-credential-ecr-login "https://amazon-ecr-credential-helper-releases.s3.us-east-2.amazonaws.com/0.7.1/linux-amd64/docker-credential-ecr-login" && \
    chmod +x /usr/local/bin/docker-credential-ecr-login

RUN mkdir -p /root/.docker && \
    echo '{"credsStore": "ecr-login"}' > /root/.docker/config.json

WORKDIR /app
COPY --from=builder /app/attestor /usr/local/bin/attestor
# The public key MUST be copied to /etc/cosign.pub
# We assume it's copied in from the build context (repo root)
COPY ../../cosign.pub /etc/cosign.pub

EXPOSE 8080

CMD ["attestor"]
