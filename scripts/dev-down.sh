#!/bin/bash
echo "🗑️  Tearing down Popcorn Local Dev Environment..."

# Delete in reverse order of creation roughly
echo "🛑 Deleting Browser Pool..."
kubectl delete -f k8s/browser.yaml --ignore-not-found=true

echo "🛑 Deleting Pool Manager..."
kubectl delete -f k8s/pool-manager.yaml --ignore-not-found=true
kubectl delete -f k8s/rbac.yaml --ignore-not-found=true

echo "🛑 Deleting Redis..."
kubectl delete -f k8s/redis.yaml --ignore-not-found=true

# Wait for cleanup
echo "⏳ Waiting for pods to terminate..."
echo "💀 Force killing all pods..."
kubectl delete pod -l app=browser-node --grace-period=0 --force 2>/dev/null || true
kubectl delete pod -l app=pool-manager --grace-period=0 --force 2>/dev/null || true
kubectl delete pod -l app=redis --grace-period=0 --force 2>/dev/null || true

echo "✅ Environment torn down."
