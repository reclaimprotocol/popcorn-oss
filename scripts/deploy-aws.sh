#!/bin/bash
set -e

echo "🌽 Popcorn AWS Deployment"
echo "Target: AWS EKS"

# 0. MFA Authentication
MFA_ARN="arn:aws:iam::342772716647:mfa/abdul_mobile"
echo "🔐 MFA Authentication required for $MFA_ARN"
read -p "Enter MFA Code: " MFA_CODE

echo "🔄 Getting Session Token..."
CREDS_JSON=$(aws sts get-session-token --serial-number $MFA_ARN --token-code $MFA_CODE)

export AWS_ACCESS_KEY_ID=$(echo $CREDS_JSON | python3 -c "import sys, json; print(json.load(sys.stdin)['Credentials']['AccessKeyId'])")
export AWS_SECRET_ACCESS_KEY=$(echo $CREDS_JSON | python3 -c "import sys, json; print(json.load(sys.stdin)['Credentials']['SecretAccessKey'])")
export AWS_SESSION_TOKEN=$(echo $CREDS_JSON | python3 -c "import sys, json; print(json.load(sys.stdin)['Credentials']['SessionToken'])")

# 1. Check AWS Auth
echo "🔑 Checking AWS identity..."
aws sts get-caller-identity

# 1. Get ECR Login
echo "🔑 Logging into AWS ECR..."
# We need the registry URL. We can get it from Terraform output or assume standard format.
# Ideally, run `tofu output` to get the URLs, but for now we'll fetch one to get the registry root.
# Assuming all repos are in the same registry (account/region).
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
# Force Region to us-east-2 for SEV-SNP support
export AWS_REGION="us-east-2"
ECR_REGISTRY="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

# 1. Apply Infrastructure via OpenTofu (Creates ECR Repos & EKS)
echo "📦 Applying Infrastructure with OpenTofu..."
cd infra/aws
tofu init
tofu apply -var="aws_region=${AWS_REGION}" -auto-approve
cd ../..

# 2. Get ECR Login
echo "🔑 Logging into AWS ECR..."
aws ecr get-login-password --region ${AWS_REGION} | docker login --username AWS --password-stdin ${ECR_REGISTRY}

# Repo Names (Must match infra/aws/ecr.tf)
REPO_POOL_MANAGER="${ECR_REGISTRY}/popcorn/pool-manager:latest"
REPO_GATEWAY="${ECR_REGISTRY}/popcorn/gateway:latest"
REPO_BROWSER="${ECR_REGISTRY}/popcorn/browser-node:latest"

# 2. Build & Push Pool Manager
echo "🔨 Building Pool Manager..."
docker build \
  --no-cache \
  --platform linux/amd64 \
  -t ${REPO_POOL_MANAGER} \
  ./services/pool-manager

echo "⬆️  Pushing Pool Manager..."
docker push ${REPO_POOL_MANAGER}

# 2b. Build & Push Gateway
echo "🚪 Building Gateway..."
docker build \
  --platform linux/amd64 \
  -t ${REPO_GATEWAY} \
  ./services/gateway

echo "⬆️  Pushing Gateway..."
docker push ${REPO_GATEWAY}

# 3. Build & Push Browser Node
# Build the base image first (locally tagged)
echo "🥘 Building Base Image (popcorn-browser:latest)..."
docker build \
  --platform linux/amd64 \
  -t popcorn-browser:latest \
  -f ../kernel-images/images/chromium-headful/Dockerfile \
  ../kernel-images

echo "🦊 Building Browser Node..."
docker build \
  --platform linux/amd64 \
  -f ./services/browser-node/Dockerfile.prod \
  -t ${REPO_BROWSER} \
  ./services/browser-node

echo "⬆️  Pushing Browser Node..."
docker push ${REPO_BROWSER}


# 4. Configure kubectl & Apply Manifests
echo "🔧 Configuring kubectl for EKS..."
aws eks update-kubeconfig --region ${AWS_REGION} --name popcorn-cluster-aws

# Apply Pool Manager with AWS config
kubectl apply -f k8s/aws/pool-manager.yaml

echo "📦 Applying Browser Deployment..."
# Apply Browser Deployment (Image URL already hardcoded or handled manually)
kubectl apply -f k8s/aws/browser.yaml
# 5. Post-Deployment Info
echo "✅ AWS Deployment Complete!"
echo "---------------------------------------------------"
echo "👉 Note: Ensure you update NEKO_NAT1TO1 if using a LoadBalancer."
echo "---------------------------------------------------"
