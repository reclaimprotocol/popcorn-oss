ARG BASE_IMAGE=popcorn-base:local
FROM ${BASE_IMAGE}

USER root
# Install build dependencies, compile helper, and cleanup
# Install runtime tools
RUN apt-get update && apt-get install -y curl jq && rm -rf /var/lib/apt/lists/*

# Install snpguest from pre-built release
ENV SNPGUEST_VERSION=v0.10.0
RUN curl -L -o /usr/local/bin/snpguest "https://github.com/virtee/snpguest/releases/download/${SNPGUEST_VERSION}/snpguest" && \
    chmod +x /usr/local/bin/snpguest

# Install AWS SDK locally
WORKDIR /app
COPY package.json /app/
RUN npm install --production

# Removed legacy attest.js
COPY entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# Install Cosign
# We use a fixed version for reproducibility.
ENV COSIGN_VERSION=v2.2.3
RUN curl -L -o /usr/local/bin/cosign "https://github.com/sigstore/cosign/releases/download/${COSIGN_VERSION}/cosign-linux-amd64" && \
    chmod +x /usr/local/bin/cosign

# Install ECR Credential Helper for Cosign Auth
RUN curl -L -o /usr/local/bin/docker-credential-ecr-login "https://amazon-ecr-credential-helper-releases.s3.us-east-2.amazonaws.com/0.7.1/linux-amd64/docker-credential-ecr-login" && \
    chmod +x /usr/local/bin/docker-credential-ecr-login

# Configure Docker to use ECR Login
RUN mkdir -p /root/.docker && \
    echo '{"credsStore": "ecr-login"}' > /root/.docker/config.json

# Copy Public Key for verification
COPY cosign.pub /etc/cosign.pub


ENTRYPOINT ["/bin/sh", "-c", "mkdir -p /var/log/app && /docker-entrypoint.sh 2>&1 | tee -a /var/log/app/entrypoint.log"]
