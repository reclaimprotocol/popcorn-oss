# 🛠 Local Development (Makefile)

We have moved to a root-level `Makefile` for local development.

## Commands

### 1. Build and Start Environment
```bash
make build
make up
```

### 2. Apply Changes
To apply the latest manifests from `gitops/clusters/local`:
```bash
make apply
```

### 3. Reset
To delete the cluster:
```bash
make clean
```
