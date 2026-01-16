# 🛠 Local Development Scripts

## Start / Restart Environment
To start the environment or apply any code changes, simply run:
```bash
./scripts/dev-up.sh
```
This script will:
1. Build the Docker images (`pool-manager`, `browser-node`).
2. Apply Kubernetes manifests.
3. **Restart the pods** to ensure the new code is running.

## Useful Commands

### Check Status
```bash
kubectl get pods
```

### View Logs
**Pool Manager:**
```bash
kubectl logs -l app=pool-manager -f
```

**Browser Node:**
```bash
kubectl logs -l app=browser-node -f
```

### Access Admin UI
Open [http://localhost/admin](http://localhost/admin) in your browser.

### Manually Restart a Service
If you want to just restart a pod without rebuilding:
```bash
kubectl rollout restart deployment/pool-manager
# or
kubectl rollout restart deployment/browser-pool
```
