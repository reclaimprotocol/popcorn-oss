# 🍿 Popcorn: On-Demand Browser Service

Popcorn is an ultra-fast browser isolation service. It is designed to scale globally on Kubernetes, providing sub-second access to "warm" browser instances.

## 🏗 Architecture



### Application Stack
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

   ```bash
   kubectl apply -k kustomize/dev # example, you need to provide your own manifests
   ```

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

Popcorn is designed to be deployed on any standard Kubernetes cluster.

1. Build and push your own Docker images.
2. Deploy the core services (`pool-manager`, `gateway`, `ttl-controller`) using standard Kubernetes manifests or Helm charts.
3. Install Agones on your cluster and configure your browser-node fleets.

---

## 🔒 Security

- **SEV-SNP Hardware Attestation**: Popcorn instances run within an AMD cryptographic enclave. Attestation proofs dynamically bind the actively running container digests (e.g., `neko` browser) to a nonce, guaranteeing the exact codebase is running securely. Proofs can be fetched and verified using the tools in [`scripts/attestation/`](scripts/attestation/README.md).
- **Isolation**: Every session runs in a dedicated ephemeral pod.
- **Network**: WebRTC traffic is routed via a private TURN server (Coturn) or internal ClusterIPs.

## 👥 Contributing

1. Clone the repo.
2. Run `make up` to stand up the local dev stack.
3. Make changes to `services/`.
4. Run `make build` and deploy to test.