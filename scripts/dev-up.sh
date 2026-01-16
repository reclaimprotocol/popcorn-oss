#!/bin/bash
set -e

echo "🌽 Popcorn Local Dev Setup (OrbStack)"

# 1. Build the Pool Manager Image
echo "🔨 Building Pool Manager image..."
docker build -t popcorn/pool-manager:local ./services/pool-manager
# 2. Build the Gateway Image
echo "🚪 Building Gateway image..."
docker build -t popcorn/gateway:local ./services/gateway

# 3. Apply Redis
# 2. Apply Redis
echo "📦 Deploying Redis..."
kubectl apply -f k8s/redis.yaml

# 3. Apply Pool Manager
echo "🏊 Deploying Pool Manager..."
kubectl apply -f k8s/rbac.yaml
kubectl apply -f k8s/pool-manager.yaml
kubectl apply -f k8s/gateway.yaml

# 4. Build Browser Node
echo "🦊 Building Browser Node image..."
docker build -t popcorn/browser-node:local ./services/browser-node

# 5. Kill old Browser Pods (Hard Reset)
echo "💀 Killing old browser pods..."
kubectl delete deployment browser-pool --ignore-not-found=true
kubectl delete pod -l app=browser-node --grace-period=0 --force 2>/dev/null || true

# 6. Apply Browser Pool
echo "🧖‍♀️ Deploying Warm Browser Pool..."
kubectl apply -f k8s/browser.yaml

# 7. Clear Redis State (to remove stale pods)
echo "🧹 Clearing Redis state..."
kubectl exec deployment/redis -- redis-cli DEL idle_pods sessions || true

# 8. Restart Pods to pick up new images
echo "🔄 Restarting deployments to load new code..."
kubectl rollout restart deployment/pool-manager || true
kubectl rollout restart deployment/popcorn-gateway || true

# 7. Success
echo "✅ Done! Monitor status with: kubectl get pods"
echo "   Test with: curl http://localhost/health (once LB is ready)"
