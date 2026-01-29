#!/usr/bin/env bash
set -euo pipefail

# Installs project prerequisites on Linux using official sources.
# Skips anything already present on PATH.

NODE_MAJOR=22

info()  { printf '\033[1;34m[info]\033[0m  %s\n' "$1"; }
ok()    { printf '\033[1;32m[ok]\033[0m    %s\n' "$1"; }
warn()  { printf '\033[1;33m[warn]\033[0m  %s\n' "$1"; }

need() {
  if command -v "$1" &>/dev/null; then
    ok "$1 already installed ($(command -v "$1"))"
    return 1
  fi
  return 0
}

# --- Node.js (via fnm) ---
if need node; then
  info "Installing Node.js ${NODE_MAJOR} via fnm..."
  curl -fsSL https://fnm.vercel.app/install | bash -s -- --skip-shell
  export PATH="$HOME/.local/share/fnm:$PATH"
  eval "$(fnm env)"
  fnm install "$NODE_MAJOR"
  fnm use "$NODE_MAJOR"
  ok "Node.js $(node --version) installed"
fi

# --- Docker ---
if need docker; then
  info "Installing Docker via official install script..."
  curl -fsSL https://get.docker.com | sh
  warn "You may need to add your user to the docker group: sudo usermod -aG docker \$USER"
  ok "Docker installed"
fi

# --- kubectl ---
if need kubectl; then
  info "Installing kubectl..."
  KUBECTL_VERSION=$(curl -fsSL https://dl.k8s.io/release/stable.txt)
  curl -fsSL -o /tmp/kubectl "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl"
  install -m 0755 /tmp/kubectl "$HOME/.local/bin/kubectl"
  rm -f /tmp/kubectl
  ok "kubectl ${KUBECTL_VERSION} installed"
fi

# --- Kind ---
if need kind; then
  info "Installing Kind..."
  KIND_VERSION=$(curl -fsSL https://api.github.com/repos/kubernetes-sigs/kind/releases/latest | grep '"tag_name"' | cut -d'"' -f4)
  curl -fsSL -o /tmp/kind "https://kind.sigs.k8s.io/dl/${KIND_VERSION}/kind-linux-amd64"
  install -m 0755 /tmp/kind "$HOME/.local/bin/kind"
  rm -f /tmp/kind
  ok "Kind ${KIND_VERSION} installed"
fi

# --- Helm ---
if need helm; then
  info "Installing Helm..."
  curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
  ok "Helm installed"
fi

# --- Dagger ---
if need dagger; then
  info "Installing Dagger CLI..."
  curl -fsSL https://dl.dagger.io/dagger/install.sh | sh
  ok "Dagger installed"
fi

echo ""
ok "All prerequisites are installed."
