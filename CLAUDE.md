# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Popcorn** is an ultra-fast browser isolation service that scales globally on Kubernetes, providing sub-second access to "warm" browser instances. It runs on AMD SEV-SNP encrypted AWS infrastructure. Users receive an ephemeral Chromium browser session (via Neko) with WebRTC display, CDP access, and a kernel API.

## Common Commands

### Local Development

```bash
# Build all Docker images locally
make build

# Create Kind cluster + install Agones
make up

# Load images into Kind and apply Kustomize manifests
make apply

# Port-forward gateway → http://localhost:8080
make connect

# Port-forward Grafana → http://localhost:3000 (admin/prom-operator)
make connect-grafana

# Tear down Kind cluster
make clean
```

### Production (AWS ECR)

```bash
# Build and push all images to ECR (requires active AWS credentials)
make push TAG=<git-sha>

# Connect to ArgoCD UI on AWS cluster
make connect-aws
```

### Pool Manager (TypeScript/Bun)

```bash
cd services/pool-manager
bun install         # Install dependencies
bun run dev         # Run with hot reload (--watch)
bun run index.ts    # Run without hot reload
```

### TTL Controller / Attestor (Go)

```bash
cd services/ttl-controller
go build ./...
go test ./...

cd services/attestor
go build ./...
go test ./...
```

### Infrastructure

```bash
# From within an environment directory, e.g. infra/live/aws/us-east-2/cluster/
terragrunt apply
terragrunt plan
```

## Architecture

### Request Flow

```
Client
  → Gateway (OpenResty/Nginx + Lua)
      → Pool Manager (Hono/Bun) via /session allocation
      → Redis (session-to-pod IP lookup)
      → Browser Pods (Agones GameServers)
            Neko :8082 | CDP :9222 | Kernel API :10001
```

### Services

| Service | Language | Purpose |
|---|---|---|
| `services/pool-manager` | TypeScript (Bun + Hono) | Allocates Agones GameServers, generates JWT tokens, manages Redis session state |
| `services/gateway` | Lua + OpenResty | Token-authenticated sticky-session reverse proxy |
| `services/browser-node` | Node.js | Chromium + Neko inside the browser pod; runs SEV-SNP attestation on startup |
| `services/ttl-controller` | Go (controller-runtime) | Kubernetes controller that deletes idle GameServers after TTL |
| `services/attestor` | Go | Validates SEV-SNP attestation reports fetched from S3 |

### State (Redis)

- `sessions:{sessionId}` → pod metadata hash
- `route:{sessionId}` → pod `IP:Port`
- `route:cdp:{sessionId}` → CDP endpoint
- `route:api:{sessionId}` → Kernel API endpoint
- `pod_heartbeats` → pod activity tracking hash

### Deployment Structure

- **`gitops/apps/`** — Kustomize bases: `platform/` (core services), `agones/` (Fleet), `observability/`
- **`gitops/clusters/`** — Kustomize overlays: `local/` (Kind), `aws-us-east-2/`, `aws-ap-south-1/`
- **`gitops/argocd/`** — Argo CD Application definitions (one per cluster)
- **`infra/modules/`** — Reusable OpenTofu/Terraform modules (EKS, VPC, ECR)
- **`infra/live/`** — Terragrunt environment configs per region
- **`popcorn-images/`** — Git submodule: Chromium headful Docker base image

### GitOps Workflow

Argo CD runs inside each cluster and syncs from `gitops/clusters/<env>`. Committing to `main` triggers CI (`.github/workflows/`) which builds and pushes images to ECR, then Argo CD syncs the updated manifests.

### SEV-SNP Attestation (browser-node)

On pod startup, `entrypoint.sh`:
1. Verifies the image signature via Cosign
2. Generates an SEV-SNP report with `snpguest`
3. Fetches VLEK certificates from AMD KDS
4. Uploads the attestation JSON to a public S3 bucket: `popcorn-attestations-{region}/`

Verification tools live in `scripts/attestation/`.

### Key Architectural Decisions

- **Agones** manages browser pod lifecycle as GameServers (Ready → Allocated → Shutdown).
- **JWT tokens** are embedded in URL paths and verified by the Lua auth module in the gateway.
- **Pool Manager** is the only component that writes to Redis and calls the Agones allocation API.
- **TTL Controller** watches GameServer resources directly via `controller-runtime` and deletes them after idle timeout.
- The `browser-node` image is built in two stages: base image from `popcorn-images/` submodule, then the service layer on top.

## Adding a New Region

See [NEW_REGION_SETUP.md](NEW_REGION_SETUP.md) for step-by-step instructions. The pattern is: provision infra with Terragrunt, create a new `gitops/clusters/<env>/` overlay, and add an Argo CD Application.
