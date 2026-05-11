.PHONY: build ensure-base build-pool-manager build-gateway build-base build-browser-node build-ttl-controller up local-keys local-secrets load-local-images deploy-local apply apply-local run-local-cluster connect clean

export DOCKER_BUILDKIT=1

PLATFORM ?= linux/amd64
GITHUB_ARTIFACT_MIRROR_REPO ?= reclaimprotocol/popcorn-oss
export GITHUB_ARTIFACT_MIRROR_REPO

CLUSTER_NAME := popcorn
LOCAL_ADMIN_USER ?= admin
LOCAL_ADMIN_PASS ?= admin
LOCAL_SERVICE_AUTH_TOKEN ?= local_service_auth_token
LOCAL_TURN_KEY_ID ?= $(TURN_KEY_ID)
LOCAL_TURN_API_TOKEN ?= $(TURN_API_TOKEN)
LOCAL_NEKO_ICESERVERS ?= $(NEKO_ICESERVERS)

POOL_MANAGER_IMAGE := popcorn/pool-manager:local
GATEWAY_IMAGE := popcorn/gateway:local
BROWSER_NODE_IMAGE := popcorn/browser-node:local
TTL_CONTROLLER_IMAGE := popcorn/ttl-controller:local

build-pool-manager:
	docker build -t $(POOL_MANAGER_IMAGE) ./services/pool-manager

build-gateway:
	docker build -t $(GATEWAY_IMAGE) ./services/gateway

build-base:
	@set -e; \
		eval "$$(./scripts/chromium-lock-env.sh "$(PLATFORM)")"; \
		artifact_layout_dir="$$(mktemp -d)"; \
		trap 'rm -rf "$$artifact_layout_dir"' EXIT; \
		./scripts/prepare-chromium-artifacts.sh "$$artifact_layout_dir" "$$TARGET_PLATFORM"; \
		docker buildx build \
			--platform "$$TARGET_PLATFORM" \
			--build-arg SOURCE_DATE_EPOCH=$$(git log -1 --pretty=%ct) \
			--build-arg UBUNTU_SNAPSHOT=$$UBUNTU_SNAPSHOT \
			--build-arg ARTIFACT_MIRROR_IMAGE=artifact-mirror \
			--build-context "artifact-mirror=$$artifact_layout_dir" \
			-f ./popcorn-images/images/chromium-headful/Dockerfile \
			-t popcorn-base:local \
			--load \
			./popcorn-images

ensure-base:
	@if ! docker image inspect popcorn-base:local >/dev/null 2>&1; then \
		$(MAKE) build-base; \
	fi

build-browser-node: ensure-base
	cp -f cosign.pub services/browser-node/cosign.pub
	docker build \
		--platform "$(PLATFORM)" \
		--build-arg SOURCE_DATE_EPOCH=$$(git log -1 --pretty=%ct) \
		--build-arg BASE_IMAGE=popcorn-base:local \
		-t $(BROWSER_NODE_IMAGE) \
		./services/browser-node

build-ttl-controller:
	docker build -t $(TTL_CONTROLLER_IMAGE) ./services/ttl-controller

build: build-pool-manager build-gateway build-browser-node build-ttl-controller

up:
	@if ! kind get clusters | grep -q "^$(CLUSTER_NAME)$$"; then \
		kind create cluster --name $(CLUSTER_NAME) --config kind-config.yaml; \
	else \
		echo "Cluster '$(CLUSTER_NAME)' already exists."; \
	fi
	kubectl config use-context kind-$(CLUSTER_NAME)
	kubectl wait --for=condition=Ready nodes --all --timeout=120s
	kubectl create namespace agones-system --dry-run=client -o yaml | kubectl apply -f -
	helm repo add agones https://agones.dev/chart/stable || true
	helm repo update
	helm upgrade --install agones --namespace agones-system agones/agones --set "agones.controller.generateTLS=false" || true

local-keys:
	@./scripts/local/generate-jwt-keys.sh

local-secrets: local-keys
	@kubectl config use-context kind-$(CLUSTER_NAME)
	@kubectl create secret generic gateway-jwt-keys \
		--from-file=private.pem=services/pool-manager/keys/private.pem \
		--from-file=public.pem=services/gateway/keys/public.pem \
		--dry-run=client -o yaml | kubectl apply -f -
	@kubectl create secret generic pool-manager-env-secrets \
		--from-literal=ADMIN_USER="$(LOCAL_ADMIN_USER)" \
		--from-literal=ADMIN_PASS="$(LOCAL_ADMIN_PASS)" \
		--dry-run=client -o yaml | kubectl apply -f -
	@kubectl create secret generic analytics-service-secret \
		--from-literal=SERVICE_AUTH_TOKEN="$(LOCAL_SERVICE_AUTH_TOKEN)" \
		--from-literal=ADMIN_TOKEN=local_admin_token_for_dev \
		--dry-run=client -o yaml | kubectl apply -f -
	@if { [ -n "$(LOCAL_TURN_KEY_ID)" ] && [ -z "$(LOCAL_TURN_API_TOKEN)" ]; } || { [ -z "$(LOCAL_TURN_KEY_ID)" ] && [ -n "$(LOCAL_TURN_API_TOKEN)" ]; }; then \
		echo "Set both TURN_KEY_ID and TURN_API_TOKEN, or neither to keep the existing local secret."; \
		exit 1; \
	fi
	@if [ -n "$(LOCAL_TURN_KEY_ID)" ] && [ -n "$(LOCAL_TURN_API_TOKEN)" ]; then \
		kubectl create secret generic browser-turn-secret \
			--from-literal=TURN_KEY_ID="$(LOCAL_TURN_KEY_ID)" \
			--from-literal=TURN_API_TOKEN="$(LOCAL_TURN_API_TOKEN)" \
			--from-literal=NEKO_ICESERVERS='$(LOCAL_NEKO_ICESERVERS)' \
			--dry-run=client -o yaml | kubectl apply -f -; \
	elif kubectl get secret browser-turn-secret >/dev/null 2>&1 && \
		[ -n "$$(kubectl get secret browser-turn-secret -o jsonpath='{.data.TURN_KEY_ID}')" ] && \
		[ -n "$$(kubectl get secret browser-turn-secret -o jsonpath='{.data.TURN_API_TOKEN}')" ]; then \
		echo "Reusing browser-turn-secret already stored in the local cluster."; \
	else \
		echo "Info: Local TURN credentials are empty; creating an empty browser-turn-secret for Kind."; \
		kubectl create secret generic browser-turn-secret \
			--from-literal=TURN_KEY_ID= \
			--from-literal=TURN_API_TOKEN= \
			--from-literal=NEKO_ICESERVERS= \
			--dry-run=client -o yaml | kubectl apply -f -; \
	fi

load-local-images:
	@kubectl config use-context kind-$(CLUSTER_NAME)
	kind load docker-image $(POOL_MANAGER_IMAGE) --name $(CLUSTER_NAME)
	kind load docker-image $(GATEWAY_IMAGE) --name $(CLUSTER_NAME)
	kind load docker-image $(BROWSER_NODE_IMAGE) --name $(CLUSTER_NAME)
	kind load docker-image $(TTL_CONTROLLER_IMAGE) --name $(CLUSTER_NAME)

deploy-local: up local-secrets load-local-images
	helm upgrade --install popcorn-platform charts/platform \
		--namespace default \
		--set registry=popcorn \
		--set imageTag=local \
		--set clusterName=local \
		--set provider=kind \
		--set poolManager.enabled=true \
		--set poolManager.imagePullPolicy=IfNotPresent \
		--set gateway.enabled=true \
		--set gateway.imagePullPolicy=IfNotPresent \
		--set gateway.serviceType=NodePort \
		--set gateway.nodePorts.http=30080 \
		--set gateway.backendConfig.enabled=false \
		--set redis.enabled=true \
		--set ttlController.enabled=true \
		--set ttlController.imagePullPolicy=IfNotPresent
	helm upgrade --install --force-conflicts browser-fleet charts/browser-fleet \
		--namespace default \
		--set externalSecrets.enabled=false \
		--set ccDevicePlugin.enabled=false \
		--set browserRuntimeImage=$(BROWSER_NODE_IMAGE) \
		--set browserRuntimeImagePullPolicy=IfNotPresent \
		--set browserRuntimeAttestor.enabled=false \
		--set fleet.replicas=1 \
		--set fleet.browserRuntimeCpuRequest=500m \
		--set fleet.browserRuntimeCpuLimit=2000m \
		--set fleet.browserRuntimeMemoryRequest=512Mi \
		--set fleet.browserRuntimeMemoryLimit=2Gi \
		--set autoscaler.bufferSize=1 \
		--set autoscaler.minReplicas=1 \
		--set autoscaler.maxReplicas=3
	kubectl rollout restart deployment/pool-manager deployment/popcorn-gateway || true
	kubectl exec deployment/redis -- redis-cli DEL idle_pods sessions || true
	@echo "Local cluster deployed. Gateway: http://localhost:8080"

apply: deploy-local
apply-local: deploy-local
run-local-cluster: build-pool-manager build-gateway build-browser-node build-ttl-controller deploy-local

connect:
	@kubectl config use-context kind-$(CLUSTER_NAME)
	@echo "Cluster available. Gateway is mapped to NodePort 30080 (localhost:8080)."
	@echo "Open http://localhost:8080 in your browser."

clean:
	kind delete cluster --name $(CLUSTER_NAME)
