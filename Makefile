.PHONY: build build-pool-manager build-control-plane build-gateway build-minimal-vnc-desktop build-local-browser-runtime build-ttl-controller up patch-kind-orbstack-proxy local-keys local-secrets load-local-images deploy-local apply apply-local run-local-cluster connect clean

export DOCKER_BUILDKIT=1

PLATFORM ?= linux/amd64
GITHUB_ARTIFACT_MIRROR_REPO ?= reclaimprotocol/popcorn-oss
export GITHUB_ARTIFACT_MIRROR_REPO

CLUSTER_NAME := popcorn
ORBSTACK_NO_PROXY_EXTRA := .svc,.svc.cluster.local,cluster.local,kubernetes.default.svc,10.96.0.0/12,10.244.0.0/16,$(CLUSTER_NAME)-control-plane
LOCAL_SERVICE_AUTH_TOKEN ?= local_service_auth_token
LOCAL_POOL_MANAGER_SERVICE_AUTH_TOKEN ?= local_pool_manager_service_auth_token
LOCAL_CONTROL_PLANE_ADMIN_USER ?= admin
LOCAL_CONTROL_PLANE_ADMIN_PASS ?= admin
LOCAL_CONTROL_PLANE_ADMIN_SESSION_SECRET ?= local_control_plane_admin_session_secret_for_dev
LOCAL_CONTROL_PLANE_ADMIN_TOKEN ?= local_admin_token_for_dev
LOCAL_ANALYTICS_DB_PASSWORD ?= local_analytics_password
LOCAL_BROWSER_STARTUP_URL ?= https://www.google.com
LOCAL_BROWSER_STARTUP_ARGS = $(if $(LOCAL_BROWSER_STARTUP_URL),--set 'extraBrowserRuntimeEnv[0].name=POPCORN_BROWSER_STARTUP_URL' --set-string 'extraBrowserRuntimeEnv[0].value=$(LOCAL_BROWSER_STARTUP_URL)',)

POOL_MANAGER_IMAGE := popcorn/pool-manager:local
CONTROL_PLANE_IMAGE := popcorn/control-plane:local
GATEWAY_IMAGE := popcorn/gateway:local
MINIMAL_VNC_DESKTOP_IMAGE := popcorn/minimal-vnc-desktop:local
TTL_CONTROLLER_IMAGE := popcorn/ttl-controller:local
LOCAL_BROWSER_RUNTIME_IMAGE := $(MINIMAL_VNC_DESKTOP_IMAGE)

build-pool-manager:
	docker build -t $(POOL_MANAGER_IMAGE) ./services/pool-manager

build-control-plane:
	docker build -t $(CONTROL_PLANE_IMAGE) ./services/control-plane

build-gateway:
	docker build -t $(GATEWAY_IMAGE) ./services/gateway

build-minimal-vnc-desktop:
	IMAGE="$(MINIMAL_VNC_DESKTOP_IMAGE)" PLATFORM="$(PLATFORM)" images/minimal-vnc-desktop/build.sh

build-local-browser-runtime: build-minimal-vnc-desktop

build-ttl-controller:
	docker build -t $(TTL_CONTROLLER_IMAGE) ./services/ttl-controller

build: build-pool-manager build-control-plane build-gateway build-local-browser-runtime build-ttl-controller

up:
	@if ! kind get clusters | grep -q "^$(CLUSTER_NAME)$$"; then \
		kind create cluster --name $(CLUSTER_NAME) --config kind-config.yaml; \
	else \
		echo "Cluster '$(CLUSTER_NAME)' already exists."; \
	fi
	kubectl config use-context kind-$(CLUSTER_NAME)
	kubectl wait --for=condition=Ready nodes --all --timeout=120s
	$(MAKE) patch-kind-orbstack-proxy
	kubectl create namespace agones-system --dry-run=client -o yaml | kubectl apply -f -
	helm repo add agones https://agones.dev/chart/stable || true
	helm repo update
	helm upgrade --install agones --namespace agones-system agones/agones \
		--set "agones.controller.generateTLS=false" || true
	kubectl -n agones-system rollout status deployment/agones-controller --timeout=180s
	kubectl -n agones-system rollout status deployment/agones-extensions --timeout=180s

patch-kind-orbstack-proxy:
	@if docker inspect $(CLUSTER_NAME)-control-plane >/dev/null 2>&1 && \
		docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' $(CLUSTER_NAME)-control-plane | grep -q 'proxyproxy.orb.internal'; then \
		echo "Patching Kind static pod NO_PROXY for Orbstack Kubernetes service traffic..."; \
		docker exec -e NO_PROXY_EXTRA="$(ORBSTACK_NO_PROXY_EXTRA)" $(CLUSTER_NAME)-control-plane sh -lc '\
			for file in /etc/kubernetes/manifests/kube-apiserver.yaml /etc/kubernetes/manifests/kube-controller-manager.yaml /etc/kubernetes/manifests/kube-scheduler.yaml; do \
				[ -f "$$file" ] || continue; \
				if awk "/name: NO_PROXY/{getline; print; exit}" "$$file" | grep -q ".svc"; then \
					continue; \
				fi; \
				current=$$(awk "/name: NO_PROXY/{getline; sub(/^[[:space:]]*value: /, \"\"); print; exit}" "$$file"); \
				patched="$$current,$$NO_PROXY_EXTRA"; \
				sed -i "/name: NO_PROXY/{n;s|value: .*|value: $$patched|}; /name: no_proxy/{n;s|value: .*|value: $$patched|}" "$$file"; \
			done'; \
		sleep 12; \
		kubectl wait --for=condition=Ready nodes --all --timeout=120s; \
	fi

local-keys:
	@./scripts/local/generate-jwt-keys.sh

local-secrets: local-keys
	@kubectl config use-context kind-$(CLUSTER_NAME)
	@kubectl create secret generic gateway-jwt-keys \
		--from-file=private.pem=services/pool-manager/keys/private.pem \
		--from-file=public.pem=services/gateway/keys/public.pem \
		--dry-run=client -o yaml | kubectl apply -f -
	@kubectl create secret generic pool-manager-service-auth \
		--from-literal=POOL_MANAGER_SERVICE_AUTH_TOKEN="$(LOCAL_POOL_MANAGER_SERVICE_AUTH_TOKEN)" \
		--dry-run=client -o yaml | kubectl apply -f -
	@kubectl create secret generic control-plane-secret \
		--from-literal=CONTROL_PLANE_SERVICE_AUTH_TOKEN="$(LOCAL_SERVICE_AUTH_TOKEN)" \
		--from-literal=ADMIN_USER="$(LOCAL_CONTROL_PLANE_ADMIN_USER)" \
		--from-literal=ADMIN_PASS="$(LOCAL_CONTROL_PLANE_ADMIN_PASS)" \
		--from-literal=ADMIN_SESSION_SECRET="$(LOCAL_CONTROL_PLANE_ADMIN_SESSION_SECRET)" \
		--from-literal=ADMIN_TOKEN="$(LOCAL_CONTROL_PLANE_ADMIN_TOKEN)" \
		--dry-run=client -o yaml | kubectl apply -f -
	@kubectl create secret generic analytics-db-secret \
		--from-literal=host=local-postgres \
		--from-literal=port=5432 \
		--from-literal=database=analytics \
		--from-literal=username=analytics_admin \
		--from-literal=password="$(LOCAL_ANALYTICS_DB_PASSWORD)" \
		--dry-run=client -o yaml | kubectl apply -f -

load-local-images:
	@kubectl config use-context kind-$(CLUSTER_NAME)
	kind load docker-image $(POOL_MANAGER_IMAGE) --name $(CLUSTER_NAME)
	kind load docker-image $(CONTROL_PLANE_IMAGE) --name $(CLUSTER_NAME)
	kind load docker-image $(GATEWAY_IMAGE) --name $(CLUSTER_NAME)
	kind load docker-image $(LOCAL_BROWSER_RUNTIME_IMAGE) --name $(CLUSTER_NAME)
	kind load docker-image $(TTL_CONTROLLER_IMAGE) --name $(CLUSTER_NAME)

deploy-local: up local-secrets load-local-images
	kubectl apply -f examples/kubernetes/local-postgres.yaml
	kubectl rollout status statefulset/local-postgres --namespace default --timeout=180s
	helm upgrade --install popcorn-platform charts/platform \
		--namespace default \
		--set registry=popcorn \
		--set imageTag=local \
		--set clusterName=local \
		--set provider=kind \
		--set poolManager.enabled=true \
		--set poolManager.imagePullPolicy=IfNotPresent \
		--set controlPlane.enabled=true \
		--set controlPlane.imagePullPolicy=IfNotPresent \
		--set controlPlane.serviceType=NodePort \
		--set controlPlane.nodePorts.http=30081 \
		--set 'controlPlane.regions[0].name=local' \
		--set 'controlPlane.regions[0].clusterName=local' \
		--set 'controlPlane.regions[0].poolManagerUrl=http://pool-manager.default.svc.cluster.local' \
		--set 'controlPlane.regions[0].publicGatewayUrl=http://localhost:8080' \
		--set 'controlPlane.regions[0].enabled=true' \
		--set 'controlPlane.regions[0].poolManagerAuth.secretName=pool-manager-service-auth' \
		--set 'controlPlane.regions[0].poolManagerAuth.secretKey=POOL_MANAGER_SERVICE_AUTH_TOKEN' \
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
		--set-string browserRuntimeImage=$(LOCAL_BROWSER_RUNTIME_IMAGE) \
		--set browserRuntimeImagePullPolicy=IfNotPresent \
		--set browserRuntimeAttestor.enabled=false \
		$(LOCAL_BROWSER_STARTUP_ARGS) \
		--set fleet.replicas=1 \
		--set fleet.browserRuntimeCpuRequest=500m \
		--set fleet.browserRuntimeCpuLimit=2000m \
		--set fleet.browserRuntimeMemoryRequest=512Mi \
		--set fleet.browserRuntimeMemoryLimit=2Gi \
		--set autoscaler.bufferSize=1 \
		--set autoscaler.minReplicas=1 \
		--set autoscaler.maxReplicas=3
	kubectl rollout restart deployment/pool-manager deployment/control-plane deployment/popcorn-gateway deployment/ttl-controller || true
	kubectl exec deployment/redis -- redis-cli DEL idle_pods sessions || true
	@echo "Local cluster deployed. Gateway: http://localhost:8080"
	@echo "Control plane: http://localhost:8081"

apply: deploy-local
apply-local: deploy-local
run-local-cluster: build-pool-manager build-control-plane build-gateway build-local-browser-runtime build-ttl-controller deploy-local

connect:
	@kubectl config use-context kind-$(CLUSTER_NAME)
	@echo "Cluster available. Gateway is mapped to NodePort 30080 (localhost:8080)."
	@echo "Open http://localhost:8080 in your browser."

clean:
	kind delete cluster --name $(CLUSTER_NAME)
