.PHONY: build 

CLUSTER_NAME := popcorn

# Image Names
POOL_MANAGER_IMAGE := popcorn/pool-manager:local
GATEWAY_IMAGE := popcorn/gateway:local
BROWSER_NODE_IMAGE := popcorn/browser-node:local
TTL_CONTROLLER_IMAGE := popcorn/ttl-controller:local

build-pool-manager:
	@echo "🔨 Building Pool Manager..."
	docker build -t $(POOL_MANAGER_IMAGE) ./services/pool-manager

build-gateway:
	@echo "🔨 Building Gateway..."
	docker build -t $(GATEWAY_IMAGE) ./services/gateway

build-base:
	@echo "🏗️  Building base image locally (popcorn-base:local)..."
	docker build  -f ./popcorn-images/images/chromium-headful/Dockerfile -t popcorn-base:local ./popcorn-images

build-browser-node: build-base
	@echo "🏗️  Building Browser Node using local base..."
	cp -f cosign.pub services/browser-node/cosign.pub
	docker build --build-arg BASE_IMAGE=popcorn-base:local -t $(BROWSER_NODE_IMAGE) ./services/browser-node

build-ttl-controller:
	@echo "🏗️  Building TTL Controller..."
	docker build -t $(TTL_CONTROLLER_IMAGE) ./services/ttl-controller

build: build-pool-manager build-gateway build-browser-node build-ttl-controller
	@echo "✅ All Images built."

up:
	@echo "🌽 Starting Kind cluster..."
	@if ! kind get clusters | grep -q "^$(CLUSTER_NAME)$$"; then \
		kind create cluster --name $(CLUSTER_NAME) --config kind-config.yaml; \
	else \
		echo "✨ Cluster '$(CLUSTER_NAME)' already exists."; \
	fi
	kubectl config use-context kind-$(CLUSTER_NAME)
	@echo "⏳ Waiting for cluster to be ready..."
	kubectl wait --for=condition=Ready nodes --all --timeout=120s
	@echo "🎮 Installing Agones..."
	kubectl create namespace agones-system --dry-run=client -o yaml | kubectl apply -f -
	helm repo add agones https://agones.dev/chart/stable || true
	helm repo update
	helm upgrade --install agones --namespace agones-system agones/agones --set "agones.controller.generateTLS=false" || true
	@echo "✅ Environment ready."

apply:
	@echo "🚀 Applying manifests from gitops/clusters/local..."
	@kubectl config use-context kind-$(CLUSTER_NAME)
	# Ensure images are loaded into Kind (if not using local registry)
	kind load docker-image $(POOL_MANAGER_IMAGE) --name $(CLUSTER_NAME)
	kind load docker-image $(GATEWAY_IMAGE) --name $(CLUSTER_NAME)
	kind load docker-image $(BROWSER_NODE_IMAGE) --name $(CLUSTER_NAME)
	kind load docker-image $(TTL_CONTROLLER_IMAGE) --name $(CLUSTER_NAME)
	kubectl apply -k gitops/clusters/local
	@echo "🔄 Restarting deployments to pick up new images..."
	kubectl rollout restart deployment/pool-manager
	kubectl rollout restart deployment/popcorn-gateway
	kubectl rollout restart deployment/ttl-controller
	@echo "✅ Applied & Restarted."

clean:
	@echo "🧹 Deleting cluster..."
	kind delete cluster --name $(CLUSTER_NAME)

connect:
	@kubectl config use-context kind-$(CLUSTER_NAME)
	@echo "🔌 Cluster available. Gateway is mapped to NodePort 30080 (localhost:8080)."
	@echo "   Open http://localhost:8080 in your browser."

AWS_REGION ?= us-east-2
AWS_CLUSTER_NAME ?= popcorn-cluster-aws
connect-cd:
	@echo "🔌 Connecting to ArgoCD UI on AWS..."
	@aws eks update-kubeconfig --region $(AWS_REGION) --name $(AWS_CLUSTER_NAME)
	@echo "🔓 ArgoCD Admin Password: "
	@kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d && echo
	@echo "🔄 Port-forwarding 8888 -> 443..."
	@kubectl -n argocd port-forward svc/argocd-server 8888:443
