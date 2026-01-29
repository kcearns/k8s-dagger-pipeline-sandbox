#!/usr/bin/env bash
set -euo pipefail

# Creates the Kind cluster with a local Docker registry and installs npm dependencies.
# Idempotent — safe to re-run.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

CLUSTER_NAME="dagger-demo"
REGISTRY_NAME="kind-registry"
REGISTRY_PORT=5001

info()  { printf '\033[1;34m[info]\033[0m  %s\n' "$1"; }
ok()    { printf '\033[1;32m[ok]\033[0m    %s\n' "$1"; }
warn()  { printf '\033[1;33m[warn]\033[0m  %s\n' "$1"; }

# --- Kind Cluster ---
if kind get clusters 2>/dev/null | grep -q "^${CLUSTER_NAME}$"; then
  ok "Kind cluster '${CLUSTER_NAME}' already exists"
else
  info "Creating Kind cluster '${CLUSTER_NAME}'..."
  kind create cluster --name "${CLUSTER_NAME}" --config "${PROJECT_ROOT}/kind.yaml"
  ok "Kind cluster '${CLUSTER_NAME}' created"
fi

# --- Local Docker Registry ---
if docker inspect "${REGISTRY_NAME}" &>/dev/null; then
  ok "Docker registry '${REGISTRY_NAME}' already running"
else
  info "Starting local Docker registry on port ${REGISTRY_PORT}..."
  docker run -d --restart=always -p "${REGISTRY_PORT}:5000" --name "${REGISTRY_NAME}" registry:2
  ok "Docker registry '${REGISTRY_NAME}' started"
fi

# --- Connect registry to kind network ---
if docker network inspect kind | grep -q "${REGISTRY_NAME}"; then
  ok "Registry already connected to kind network"
else
  info "Connecting registry to kind network..."
  docker network connect kind "${REGISTRY_NAME}"
  ok "Registry connected to kind network"
fi

# --- Configure containerd to use the local registry ---
CERTS_DIR="/etc/containerd/certs.d/localhost:${REGISTRY_PORT}"
if docker exec "${CLUSTER_NAME}-control-plane" test -f "${CERTS_DIR}/hosts.toml" 2>/dev/null; then
  ok "Containerd registry config already exists"
else
  info "Configuring containerd to use local registry..."
  docker exec "${CLUSTER_NAME}-control-plane" mkdir -p "${CERTS_DIR}"
  docker exec "${CLUSTER_NAME}-control-plane" bash -c "cat > ${CERTS_DIR}/hosts.toml <<EOF
server = \"http://${REGISTRY_NAME}:5000\"

[host.\"http://${REGISTRY_NAME}:5000\"]
  capabilities = [\"pull\", \"resolve\"]
EOF"
  ok "Containerd configured for local registry"
fi

# --- Install npm dependencies ---
info "Installing app dependencies..."
(cd "${PROJECT_ROOT}" && npm install)
ok "App dependencies installed"

info "Installing Dagger pipeline dependencies..."
(cd "${PROJECT_ROOT}/dagger" && npm install)
ok "Dagger pipeline dependencies installed"

echo ""
ok "Setup complete. Run 'cd dagger && npm run pipeline' to execute the full CI/CD pipeline."
