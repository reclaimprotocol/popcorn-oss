# 🗺️ Project Master Plan: Popcorn

This document outlines the architectural roadmap for `popcorn`, an on-demand confidential browser service. 

## 🏗 Architectural Decision Record (ADR)
- **Deployment Target**: Kubernetes (GKE) is the primary target. 
- **Local Development**: We will **skip Docker Compose** for system-wide orchestration. Instead, we will use **Kind (Kubernetes in Docker)** or **Minikube** to replicate the exact GKE environment locally. This ensures our manifests and logic work seamlessly from local -> prod.
- **Infrastructure as Code**: OpenTofu (fork of Terraform) will manage all GCP resources.

---

## 📂 Repository Structure

```graphql
/popcorn
├── /infra              # OpenTofu (IaC) for GCP
│   ├── /modules
│   ├── /envs
│   │   ├── /dev
│   │   └── /prod
├── /services
│   ├── /pool-manager   # The Go/Node API that assigns pods to users
│   └── /browser-node   # Custom configs/sidecars for the Neko images
├── /k8s                # Kubernetes Manifests & Helm Charts
│   ├── /base
│   └── /overlays
└── /scripts            # Local dev setup scripts (Kind, scaffolding)
```

---

## 1️⃣ Phase 1: Infrastructure (OpenTofu)

We need to provision the hardware foundation.

### **Core Components**
1.  **VPC & Networking**: Custom VPC, subnets, and Router/NAT for egress.
2.  **GKE Cluster (Confidential)**: 
    -   Must use **Confidential Nodes** (AMD SEV enabled).
    -   Machine Type: `n2d-standard-8` (or similar).
    -   **Workload Identity**: enabled for secure access to GCP APIs.
3.  **State Store**: Cloud Memorystore (Redis) for the "Warm Pool" queue.
4.  **Artifact Registry**: To store our custom Docker images.

---

## 2️⃣ Phase 2: The Pool Manager Service

The "Brain" of the operation. This is a lightweight HTTP service.

### **Responsibilities**
1.  **User Interface**: `POST /session`
    -   Authenticates user.
    -   **POPs** an idle pod IP from Redis.
    -   Marks it as "Busy" in Redis (handling TTL/expiry).
    -   Returns the `http://<pod-ip>:<port>` to the user.
2.  **Health Monitor**:
    -   Ensures the Redis pool size matches target (e.g., maintain 10 idle browsers).
    -   Triggers K8s scaling events (optional, if not using HPA).

---

## 3️⃣ Phase 3: The Browser Pool (Neko)

The "Worker" nodes. We don't just run stock Neko; we need a lifecycle wrapper.

### **Lifecycle Logic**
1.  **Boot**: Container starts.
2.  **Registration**: A sidecar or startup script runs:
    -   `redis.LPUSH('idle_pods', my_ip)`
3.  **Session Start**: User connects.
4.  **Teardown**: 
    -   User disconnects -> Pod detects inactivity.
    -   **Self-Destruct**: Pod deletes itself or restarts to wipe data. Wiping data is critical for privacy. Re-entering the pool without a wipe is unsafe. 
    -   *Strategy*: Kubernetes `Job` or `Pod` that exits on completion, allowing the ReplicaSet/Deployment to spin up a fresh clean one.

---

## 4️⃣ Phase 4: Local Development (The "Kind" Loop)

Since we depend on Kubernetes logic (Pods calling Redis within a cluster DNS), we will use **Kind**.

1.  **Script**: `Start-Local-Env.sh`
    -   Spins up Kind cluster.
    -   Installs Redis (Helm).
    -   Builds functionality for Pool Manager.
    -   Applies K8s manifests.
2.  **Testing**:
    -   Run a script to hit the local Pool Manager NodePort.
    -   Confirm it redirects to a local Browser Pod.
