#!/bin/bash
set -e

echo "🌽 Popcorn Local Dev Setup (Agones Mode)"
kubectl config use-context orbstack

# 1. Build Images
echo "🔨 Building Pool Manager image..."
docker build -t popcorn/pool-manager:local ./services/pool-manager

echo "🦊 Building Browser Node image..."
docker build -t popcorn/browser-node:local ./services/browser-node

echo "🚪 Building Gateway image..."
docker build -t popcorn/gateway:local ./services/gateway

# 2. Deploy Infrastructure
echo "📦 Deploying Redis..."
kubectl apply -f k8s/redis.yaml

echo "🏊 Deploying Pool Manager & Gateway..."
kubectl apply -f k8s/rbac.yaml
kubectl apply -f k8s/pool-manager.yaml
kubectl apply -f k8s/gateway.yaml

# 3. Deploy Agones Fleet
echo "🎮 Deploying Agones Fleet..."
# Kill old standard browser deployment if it exists
kubectl delete deployment browser-pool --ignore-not-found=true

kubectl apply -f k8s/agones/fleet.yaml
kubectl apply -f k8s/agones/autoscaler.yaml

# 4. Clear Redis State
echo "🧹 Clearing Redis state..."
kubectl exec deployment/redis -- redis-cli DEL idle_pods sessions || true

# 5. Restart Pool Manager to pick up new image
kubectl rollout restart deployment/pool-manager
kubectl rollout restart deployment/popcorn-gateway

echo "✅ Done! Monitor Fleet with: kubectl get fleet"
echo "   Monitor GameServers with: kubectl get gameservers"
