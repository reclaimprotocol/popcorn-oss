ARG BASE_IMAGE=popcorn-base:local
FROM ${BASE_IMAGE}

USER root
# Install build dependencies, compile helper, and cleanup
# Install runtime tools and AWS SDK
RUN apt-get update && apt-get install -y curl jq git build-essential && rm -rf /var/lib/apt/lists/*
RUN npm install -g @aws-sdk/client-s3

# Install Rust and build snpguest
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y && \
    . $HOME/.cargo/env && \
    git clone https://github.com/virtee/snpguest.git /tmp/snpguest && \
    cd /tmp/snpguest && cargo build --release && \
    cp target/release/snpguest /usr/local/bin/ && \
    rm -rf /tmp/snpguest $HOME/.cargo $HOME/.rustup

COPY attest.js /attest.js
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


ENTRYPOINT ["/docker-entrypoint.sh"]
