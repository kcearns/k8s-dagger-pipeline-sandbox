#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CDK_DIR="$PROJECT_ROOT/cdk"
ENV_FILE="$PROJECT_ROOT/.env.eks"

echo "=== EKS Teardown ==="
echo ""

# Delete K8s resources that create AWS resources (ALBs, etc.)
echo "Cleaning up Kubernetes ingress and service resources..."
for NS in dev staging prod; do
  echo "  Cleaning namespace: $NS"
  kubectl delete ingress --all -n "$NS" --ignore-not-found 2>/dev/null || true
  kubectl delete svc --all -n "$NS" --ignore-not-found 2>/dev/null || true
done
echo ""

echo "Waiting 30s for AWS resources (ALBs, etc.) to be cleaned up..."
sleep 30
echo ""

# Destroy CDK stack
echo "Destroying CDK stack..."
cd "$CDK_DIR"

# Export required env vars if .env.eks exists
if [ -f "$ENV_FILE" ]; then
  source "$ENV_FILE"
fi

export AWS_ACCOUNT_ID="${AWS_ACCOUNT_ID:-$(aws sts get-caller-identity --query Account --output text)}"
export AWS_REGION="${AWS_REGION:-us-east-1}"

npx cdk destroy --force
echo ""

# Clean up local files
echo "Cleaning up local files..."
rm -f "$ENV_FILE"
rm -f "$CDK_DIR/outputs.json"
echo ""

echo "=== EKS Teardown Complete ==="
