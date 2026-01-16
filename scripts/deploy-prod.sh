#!/bin/bash
set -e

echo "🌽 Popcorn Production Deployment"
echo "Target Cluster: popcorn-cluster (asia-south2-a)"
echo "Project: rc-popcorn"

# 1. Authenticate Docker (Safe to re-run)
echo "🔑 Configuring Docker auth..."
gcloud auth configure-docker gcr.io --quiet

# 2. Build & Push Pool Manager
echo "🔨 Building Pool Manager (gcr.io/rc-popcorn/pool-manager:latest)..."
# Using --platform linux/amd64 for GKE Standard (N2D) nodes
docker build \
  --platform linux/amd64 \
  -t gcr.io/rc-popcorn/pool-manager:latest \
  ./services/pool-manager

echo "⬆️  Pushing Pool Manager..."
docker push gcr.io/rc-popcorn/pool-manager:latest

# 2b. Build & Push Gateway
echo "🚪 Building Gateway (gcr.io/rc-popcorn/gateway:latest)..."
docker build \
  --platform linux/amd64 \
  -t gcr.io/rc-popcorn/gateway:latest \
  ./services/gateway

echo "⬆️  Pushing Gateway..."
docker push gcr.io/rc-popcorn/gateway:latest

# 3. Build & Push Browser Node
# Build the base image first
echo "🥘 Building Base Image (popcorn-browser:latest)..."
docker build \
  --platform linux/amd64 \
  -t popcorn-browser:latest \
  -f ../kernel-images/images/chromium-headful/Dockerfile \
  ../kernel-images

echo "🦊 Building Browser Node (gcr.io/rc-popcorn/browser-node:latest)..."
docker build \
  --platform linux/amd64 \
  -f ./services/browser-node/Dockerfile.prod \
  -t gcr.io/rc-popcorn/browser-node:latest \
  ./services/browser-node

echo "⬆️  Pushing Browser Node..."
docker push gcr.io/rc-popcorn/browser-node:latest

# 4. Apply Kubernetes Manifests
echo "📦 Applying Manifests to Cluster..."
kubectl apply -f k8s/prod/redis.yaml
kubectl apply -f k8s/prod/rbac.yaml
kubectl apply -f k8s/prod/pool-manager.yaml
kubectl apply -f k8s/prod/gateway.yaml
kubectl apply -f k8s/prod/browser.yaml

# 5. Force Restart (to ensure new images are pulled)
echo "🔄 Rolling out restarts..."
kubectl rollout restart deployment/popcorn-gateway
kubectl rollout restart deployment/pool-manager
kubectl rollout restart deployment/browser-pool
kubectl rollout restart deployment/redis


# 6. Post-Deployment Instructions
echo "✅ Production Successfully Deployed!"
echo "---------------------------------------------------"
echo "👉 Action Required: Update NEKO_NAT1TO1 for WebRTC"
echo "1. Get Gateway/LB IP: kubectl get svc popcorn-gateway"
echo "2. Edit k8s/prod/browser.yaml and set NEKO_NAT1TO1 to that External IP"
echo "3. Re-apply: kubectl apply -f k8s/prod/browser.yaml"
echo "4. Restart: kubectl rollout restart deployment/browser-pool"
echo "---------------------------------------------------"

