#!/bin/bash
set -e

echo "🎮 Installing Agones on local cluster..."

# Add Agones Helm Repository
helm repo add agones https://agones.dev/chart/stable
helm repo update

# Install Agones (targeting local development, e.g., OrbStack/Minikube)
# explicit namespaces not required, helm handles creation if needed, but Agones recommends agones-system
helm upgrade --install --wait --namespace agones-system --create-namespace agones agones/agones \
  --set "agones.allocator.service.serviceType=LoadBalancer" \
  --set "agones.allocator.http.enabled=true"

# Note: Allocator serviceType=LoadBalancer is crucial for local access if running outside the cluster
# http.enabled=true allows us to use simple HTTP requests instead of gRPC if desired (easier for MVP)

echo "✅ Agones installed successfully!"
kubectl get pods -n agones-system
