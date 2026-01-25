#!/bin/bash
set -e

# Usage: ./scripts/setup-argocd-aws.sh [AWS_ENV]
ENV=${1:-aws-us-east-2}
AWS_CLUSTER_NAME="popcorn-cluster-aws"
AWS_REGION="us-east-2"

echo "🚀 Setting up ArgoCD for $ENV on $AWS_CLUSTER_NAME..."

# 1. Update Kubeconfig (MFA protected)
echo "🔐 Authenticating with AWS..."
./scripts/get-aws-mfa-creds.sh aws eks update-kubeconfig --region $AWS_REGION --name $AWS_CLUSTER_NAME

# 2. Install ArgoCD
echo "📦 Installing ArgoCD..."
kubectl create namespace argocd --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml

# 3. Setup SSH Deploy Key
KEY_FILE="argocd_key"
if [ ! -f "$KEY_FILE" ]; then
    echo "🔑 Generating SSH Key Pair..."
    ssh-keygen -t ed25519 -C "argocd@popcorn" -f "$KEY_FILE" -N ""
fi

echo "📤 Uploading Deploy Key to GitHub..."
# Check if key exists (requires 'gh' auth)
if gh repo deploy-key list | grep -q "ArgoCD Popcorn"; then
    echo "   Key 'ArgoCD Popcorn' already exists. Skipping upload."
else
    gh repo deploy-key add "$KEY_FILE.pub" --title "ArgoCD Popcorn ($ENV)" --allow-write=false
fi

# 4. Create Repo Secret
echo "🤫 Creating ArgoCD Repo Secret..."
PRIVATE_KEY=$(cat "$KEY_FILE")
cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: Secret
metadata:
  name: popcorn-repo-secret
  namespace: argocd
  labels:
    argocd.argoproj.io/secret-type: repository
stringData:
  type: git
  url: git@github.com:reclaimprotocol/popcorn.git
  sshPrivateKey: |
$(echo "$PRIVATE_KEY" | sed 's/^/    /')
EOF

# 5. Apply Applications
echo "🚀 Applying ArgoCD Applications..."
kubectl apply -f gitops/argocd/agones.yaml
kubectl apply -f gitops/argocd/platform.yaml

echo "✅ GitOps setup complete! ArgoCD is now managing the cluster."
echo "⚠️  Ensure you commit and push your 'gitops/clusters/$ENV' changes to GitHub!"
