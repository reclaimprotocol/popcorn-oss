FROM node:20-slim

# Install dependencies
RUN apt-get update && \
    apt-get install -y curl && \
    rm -rf /var/lib/apt/lists/*

# Install snpguest
RUN curl -sL -o /usr/local/bin/snpguest \
    https://github.com/virtee/snpguest/releases/download/v0.10.0/snpguest && \
    chmod +x /usr/local/bin/snpguest

# Set working directory
WORKDIR /app

# Copy verification script
COPY verify_from_s3.js /app/

# Set default region
ENV AWS_REGION=us-east-2

ENTRYPOINT ["node", "verify_from_s3.js"]
