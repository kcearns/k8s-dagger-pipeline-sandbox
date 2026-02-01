#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CDK_DIR="$PROJECT_ROOT/cdk"
ENV_FILE="$PROJECT_ROOT/.env.eks"

echo "=== EKS Setup ==="
echo ""

# Check AWS CLI authentication
echo "Checking AWS CLI authentication..."
if ! aws sts get-caller-identity &>/dev/null; then
  echo "ERROR: AWS CLI is not configured or credentials are expired."
  echo "Run: aws configure  OR  export AWS_PROFILE=<profile>"
  exit 1
fi

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGION="${AWS_REGION:-us-east-1}"
echo "Account: $ACCOUNT_ID"
echo "Region:  $REGION"
echo ""

# Export for CDK
export AWS_ACCOUNT_ID="$ACCOUNT_ID"
export AWS_REGION="$REGION"

# Install CDK dependencies
echo "Installing CDK dependencies..."
cd "$CDK_DIR"
npm install
echo ""

# Bootstrap CDK (idempotent)
echo "Bootstrapping CDK..."
npx cdk bootstrap "aws://$ACCOUNT_ID/$REGION"
echo ""

# Deploy the stack
echo "Deploying EKS stack..."
npx cdk deploy --require-approval never --outputs-file outputs.json
echo ""

# Extract outputs
echo "Extracting stack outputs..."
CLUSTER_NAME=$(jq -r '.DaggerDemoEks.ClusterName' outputs.json)
ECR_REPO_URI=$(jq -r '.DaggerDemoEks.EcrRepoUri' outputs.json)
KUBECONFIG_CMD=$(jq -r '.DaggerDemoEks.KubeconfigCommand' outputs.json)
VPC_ID=$(jq -r '.DaggerDemoEks.VpcId' outputs.json)

echo "Cluster:  $CLUSTER_NAME"
echo "ECR Repo: $ECR_REPO_URI"
echo "VPC:      $VPC_ID"
echo ""

# Configure kubectl
echo "Configuring kubectl..."
eval "$KUBECONFIG_CMD"
echo ""

# Verify cluster
echo "Verifying cluster nodes..."
kubectl get nodes
echo ""

echo "Verifying namespaces..."
kubectl get ns dev staging prod
echo ""

# Write .env.eks
echo "Writing $ENV_FILE..."
cat > "$ENV_FILE" <<EOF
export DEPLOYMENT_TARGET=eks
export AWS_ACCOUNT_ID=$ACCOUNT_ID
export AWS_REGION=$REGION
export ECR_REPO_URI=$ECR_REPO_URI
export EKS_CLUSTER_NAME=$CLUSTER_NAME
export IMAGE_TAG=latest
EOF

echo ""
echo "=== EKS Setup Complete ==="
echo ""
echo "To use the EKS pipeline:"
echo "  source $ENV_FILE"
echo "  cd dagger && npm run pipeline"
echo ""
echo "To deploy all environments:"
echo "  source $ENV_FILE"
echo "  cd dagger && npm run pipeline:deploy-all"
