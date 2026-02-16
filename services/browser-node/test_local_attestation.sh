#!/bin/bash
set -e

# Build Base Image if not exists (or force rebuild if needed, but keeping it simple)
echo "🏗️  Building base image (local/chromium-headful:latest)..."
if [ -d "popcorn-images" ]; then
    docker build -t popcorn-base:local -f popcorn-images/images/chromium-headful/Dockerfile popcorn-images
else
    echo "❌ popcorn-images directory not found! Are submodules initialized?"
    exit 1
fi

echo "🧪 Building local test image..."
docker build -t browser-node:test services/browser-node

echo "🏃 Running with MOCK_TEE=true..."
docker run --rm \
  -e MOCK_TEE=true \
  -e IMAGE_DIGEST="sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" \
  --entrypoint /bin/bash \
  browser-node:test \
  -c "mkdir -p /var/www && node /attest.js && ls -lh /var/www/attestation.bin"

echo "✅ Test Complete."
