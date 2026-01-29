#!/usr/bin/env bash
set -euo pipefail

CLUSTER_NAME="dagger-demo"
REGISTRY_NAME="kind-registry"

echo "Tearing down Kind cluster and registry..."

echo "Deleting Kind cluster '${CLUSTER_NAME}'..."
kind delete cluster --name "${CLUSTER_NAME}" 2>/dev/null && echo "Cluster deleted." || echo "Cluster not found, skipping."

echo "Removing Docker registry '${REGISTRY_NAME}'..."
docker rm -f "${REGISTRY_NAME}" 2>/dev/null && echo "Registry removed." || echo "Registry not found, skipping."

echo "Done."
