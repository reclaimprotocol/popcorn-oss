.PHONY: build up apply clean connect push login

CLUSTER_NAME := popcorn

# Image Names
POOL_MANAGER_IMAGE := popcorn/pool-manager:local
GATEWAY_IMAGE := popcorn/gateway:local
BROWSER_NODE_IMAGE := popcorn/browser-node:local
TTL_CONTROLLER_IMAGE := popcorn/ttl-controller:local

build:
	@echo "🔨 Building Docker images..."
	docker build -t $(POOL_MANAGER_IMAGE) ./services/pool-manager
	docker build -t $(GATEWAY_IMAGE) ./services/gateway
	@echo "🏗️  Building base image locally (popcorn-base:local)..."
	docker build  -f ./popcorn-images/images/chromium-headful/Dockerfile -t popcorn-base:local ./popcorn-images
	@echo "🏗️  Building Browser Node using local base..."
	docker build --build-arg BASE_IMAGE=popcorn-base:local -t $(BROWSER_NODE_IMAGE) ./services/browser-node
	@echo "🏗️  Building TTL Controller..."
	docker build -t $(TTL_CONTROLLER_IMAGE) ./services/ttl-controller
	@echo "✅ Images built."

up:
	@echo "🌽 Starting Kind cluster..."
	@if ! kind get clusters | grep -q "^$(CLUSTER_NAME)$$"; then \
		kind create cluster --name $(CLUSTER_NAME); \
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
	@echo "🔌 Forwarding port 8080 -> 80..."
	@echo "   Open http://localhost:8080 in your browser."
	kubectl port-forward svc/popcorn-gateway 8080:80

connect-grafana:
	@kubectl config use-context kind-$(CLUSTER_NAME)
	@echo "📊 Forwarding Grafana 3000 -> 80..."
	@echo "   Open http://localhost:3000 in your browser (admin/prom-operator)."
	kubectl port-forward -n monitoring svc/observability-grafana 3000:80

# -----------------------------------------------------------------------------
# ECR / Production
# -----------------------------------------------------------------------------
AWS_REGION ?= us-east-2
AWS_CLUSTER_NAME ?= popcorn-cluster-aws
# Lazy evaluation (=) so we don't call AWS CLI just by parsing the Makefile
AWS_ACCOUNT_ID = $(shell aws sts get-caller-identity --query Account --output text)
ECR_REGISTRY = $(AWS_ACCOUNT_ID).dkr.ecr.$(AWS_REGION).amazonaws.com

# Production Image Tags (Mutable 'latest' for simple dev loops, or use git sha)
TAG ?= latest

login: 
	@echo "🔓 Logging into ECR ($(AWS_REGION))..."
	aws ecr get-login-password --region $(AWS_REGION) > ecr_token.txt
	@if [ ! -s ecr_token.txt ]; then echo "❌ Generated token is empty or command failed!"; rm -f ecr_token.txt; exit 1; fi
	cat ecr_token.txt | docker login --username AWS --password-stdin $(ECR_REGISTRY)
	@rm -f ecr_token.txt

push: login
	@echo "🚀 Building & Pushing to ECR (linux/amd64)..."
	# Pool Manager
	docker buildx build --platform linux/amd64 -t $(ECR_REGISTRY)/popcorn/pool-manager:$(TAG) --push ./services/pool-manager
	# Gateway
	docker buildx build --platform linux/amd64 -t $(ECR_REGISTRY)/popcorn/gateway:$(TAG) --push ./services/gateway
	# Browser Node
	@echo "🏗️  Building base image locally (popcorn-base:local)..."
	docker build --platform linux/amd64 -f ./popcorn-images/images/chromium-headful/Dockerfile -t popcorn-base:local ./popcorn-images
	@echo "🏗️  Building Browser Node using local base..."
	docker build --platform linux/amd64 --build-arg BASE_IMAGE=popcorn-base:local -t $(ECR_REGISTRY)/popcorn/browser-node:$(TAG) ./services/browser-node
	@echo "⬆️  Pushing Browser Node..."
	docker push $(ECR_REGISTRY)/popcorn/browser-node:$(TAG)
	# TTL Controller
	docker buildx build --platform linux/amd64 -t $(ECR_REGISTRY)/popcorn/ttl-controller:$(TAG) --push ./services/ttl-controller
	@echo "✅ All images pushed to $(ECR_REGISTRY)/popcorn/*:$(TAG)"


connect-aws:
	@echo "🔌 Connecting to ArgoCD UI on AWS..."
	@aws eks update-kubeconfig --region $(AWS_REGION) --name $(AWS_CLUSTER_NAME)
	@echo "🔓 ArgoCD Admin Password: "
	@kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d && echo
	@echo "🔄 Port-forwarding 8888 -> 443..."
	@kubectl -n argocd port-forward svc/argocd-server 8888:443
