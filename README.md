# 🍿 Popcorn: On-Demand Browser Service

Popcorn is an ultra-fast browser isolation service. It is designed to scale globally on Kubernetes, providing sub-second access to "warm" browser instances.

## 🏗 Architecture

### 1. Infrastructure (Terragrunt)
We use **OpenTofu** (via Terragrunt) to manage the underlying cloud resources (e.g., AWS EKS).
- **Directory**: `infra/`
- **Structure**:
  - `infra/modules/`: Reusable blueprints (VPC, EKS, Redis).
  - `infra/live/`: Environment-specific instantiations (`dev`, `prod-mum`, `prod-blr`).
- **Key Resources**:
  - **Kubernetes Cluster**: Runs the workload (EKS).
  - **Worker Nodes**: Standard compute instances.
  - **Redis**: Stores session state and the "idle" pod list.

### 2. GitOps (Argo CD + Kustomize)
We use a **GitOps** workflow for application deployment.
- **Directory**: `gitops/`
- **Structure**:
  - `gitops/apps/`: Kustomize "Bases" for applications.
    - `platform`: Core services (Pool Manager, Gateway, Redis, etc.).
    - `agones`: Game Server Fleet definitions.
  - `gitops/clusters/`: Kustomize "Overlays" for specific environments.
    - `local`: Kind-based local dev.
    - `prod-mum`: Production overlay for Mumbai.
- **Workflow**:
  - Developers commit to `main`.
  - Argo CD (running in the cluster) syncs changes from `gitops/clusters/<env>`.

### 3. Application Stack
- **Pool Manager**: Node.js service that assigns idle pods to users.
- **Browser Node**: Custom Docker image running Chromium with Neko.
- **Agones (Fleets)**:
  - We use [Agones](https://agones.dev/) to manage the lifecycle of browser sessions.
  - **Fleets** maintain a set of warm GameServers.
  - **GameServers** are "allocated" (marked as Busy) when a user connects.
- **Gateway**: OpenResty (Nginx) for sticky session routing.

---

## 🛠 Local Development

We use **Kind** (Kubernetes in Docker) to replicate the production environment locally.

### Prerequisites
- [Docker](https://docs.docker.com/get-docker/)
- [Kind](https://kind.sigs.k8s.io/) (`brew install kind`)
- [Kubectl](https://kubernetes.io/docs/tasks/tools/)
- [Helm](https://helm.sh/)
- [Make](https://www.gnu.org/software/make/)

### Quick Start
Use the `Makefile` to control the local environment.

1. **Build Images & Start Local Cluster**:
   ```bash
   make build
   make up
   ```
   *This starts a Kind cluster named `popcorn` and installs Agones.*

2. **Apply Manifests**:
   ```bash
   make apply
   ```
   *This deploys the `gitops/clusters/local` overlay.*

3. **Connect**:
   ```bash
   make connect
   ```
   *Forwards port 8080 to the gateway. Access at `http://localhost:8080`.*

4. **Reset**:
   ```bash
   make clean
   ```

---

## 📦 Deployment Strategy (Production)

### 1. Push Images to ECR
We use `docker buildx` to build for `linux/amd64` (compatible with AWS) and push to ECR.
```bash
make push
```
*Note: Requires AWS CLI credentials to be active.*

### 2. Provision Infrastructure
cd into the specific environment in `infra/live/` and run:
```bash
terragrunt apply
```

### 2. Bootstrap GitOps
Install Argo CD and point it to this repository.
```bash
kubectl apply -k gitops/apps/platform/argo-cd
```

### 3. Multi-Region Deployment
For instructions on adding a new AWS region (like `ap-south-1`), see the [Region Setup Guide](NEW_REGION_SETUP.md).

---

## 🔒 Security

- **Isolation**: Every session runs in a dedicated ephemeral pod.
- **Network**: WebRTC traffic is routed via a private TURN server (Coturn) or internal ClusterIPs.

## 👥 Contributing

1. Clone the repo.
2. Run `make up` to stand up the local dev stack.
3. Make changes to `services/` or `gitops/`.
4. Run `make build` and `make apply` to test.