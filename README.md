# Dagger K8s CI/CD Pipeline

A sample TypeScript Express.js application with a complete Dagger-based CI/CD pipeline that builds, tests, and deploys to a local Kind Kubernetes cluster.

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│                              Dagger Pipeline                                         │
│  ┌────────┐   ┌────────┐   ┌────────────┐   ┌─────────────┐   ┌────────┐   ┌──────┐ │
│  │  Lint  │-->│  Test  │-->│ Chart Lint │-->│ Build/Push  │-->│ Deploy │-->│ Test │ │
│  └────────┘   └────────┘   └────────────┘   └─────────────┘   └────────┘   └──────┘ │
└──────────────────────────────────────────────────────────────────────────────────────┘
                                                     │
                                                     ▼
┌──────────────────────────────────────────────────────────────────────────────────────┐
│                              Kind Cluster                                            │
│  ┌──────────────────┐    ┌──────────────────┐                                        │
│  │  Local Registry  │ <- │  App Deployment   │                                       │
│  │  localhost:5001  │    │  (Helm-managed)   │                                       │
│  └──────────────────┘    └──────────────────┘                                        │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

## Project Structure

```
dagger-k8s/
├── src/                      # TypeScript application source
│   ├── index.ts             # Express server entry point
│   ├── routes/
│   │   └── health.ts        # Health check endpoints
│   └── __tests__/
│       └── health.test.ts   # Unit tests (Vitest)
├── dagger/                   # Dagger CI/CD pipeline
│   ├── src/
│   │   └── index.ts         # Pipeline definition
│   ├── package.json
│   └── tsconfig.json
├── environments/             # Per-environment Helm values (external to chart)
│   ├── dev.yaml
│   ├── staging.yaml
│   └── prod.yaml
├── helm/
│   └── sample-app/          # Helm chart (templates + default values only)
│       ├── templates/
│       └── values.yaml
├── scripts/                  # Setup and teardown scripts
│   ├── setup.sh             # Create Kind cluster, registry, install deps
│   ├── install-prereqs.sh   # Install CLI prerequisites (Linux)
│   └── teardown.sh          # Delete cluster and registry
├── kind.yaml                # Kind cluster configuration
├── Dockerfile               # Multi-stage production build
├── package.json
├── tsconfig.json
├── eslint.config.mjs
└── README.md
```

## Prerequisites

- [Node.js](https://nodejs.org/) v22+
- [Docker](https://www.docker.com/)
- [Dagger CLI](https://docs.dagger.io/install)
- [Kind](https://kind.sigs.k8s.io/) (for local Kubernetes)
- [Helm](https://helm.sh/)
- [kubectl](https://kubernetes.io/docs/tasks/tools/)

### macOS (Homebrew)

Install all prerequisites at once using the included [Brewfile](./Brewfile):

```bash
brew bundle
```

### Linux

Run the included prerequisites script to install anything not already on your PATH:

```bash
./scripts/install-prereqs.sh
```

Binaries are installed to `~/.local/bin` — make sure it's on your `PATH`.

## Quick Start

### 1. Setup (cluster, registry, dependencies)

```bash
./scripts/setup.sh
```

This creates the Kind cluster, starts a local Docker registry on `localhost:5001`, configures containerd, and installs npm dependencies. The script is idempotent — safe to re-run.

### 2. Run the Full CI/CD Pipeline

```bash
cd dagger && npm run pipeline
```

This will:
1. **Lint** - Run ESLint on the TypeScript code
2. **Test** - Run Vitest unit tests
3. **Chart Lint** - Validate Helm chart against all environment values
4. **Build & Push** - Build Docker image and Helm chart, push to local registry
5. **Deploy** - Helm install/upgrade to the target environment
6. **Helm Test** - Run in-cluster connectivity test

## Available Commands

### Application Commands

```bash
# Development server with hot reload
npm run dev

# Build TypeScript to JavaScript
npm run build

# Run production server
npm start

# Run tests
npm test

# Run tests in watch mode
npm run test:watch

# Run linter
npm run lint
```

### Pipeline Commands

```bash
cd dagger

# Run full pipeline (lint -> test -> chart-lint -> build -> deploy -> helm-test)
npm run pipeline

# Run individual stages
npm run pipeline:lint
npm run pipeline:test
npm run pipeline:chart-lint
npm run pipeline:build
npm run pipeline:deploy
npm run pipeline:helm-test
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Welcome message |
| `/health` | GET | Basic health check |
| `/health/ready` | GET | Readiness probe (includes uptime) |
| `/health/live` | GET | Liveness probe |

### Example Responses

```bash
# Root endpoint
curl http://localhost:3000/
{"message":"Hello from dagger-k8s sample app"}

# Health check
curl http://localhost:3000/health
{"status":"ok"}

# Readiness probe
curl http://localhost:3000/health/ready
{"status":"ready","uptime":42}

# Liveness probe
curl http://localhost:3000/health/live
{"status":"alive"}
```

## Kubernetes Resources

### Deployment

- **Replicas**: 1 (dev), 2 (staging), 3 (prod) — configured via environment values
- **Image**: `localhost:5001/sample-app:latest`
- **Resources**:
  - Requests: 50m CPU, 64Mi memory
  - Limits: 200m CPU, 128Mi memory
- **Probes**:
  - Liveness: `/health/live` (delay: 5s, period: 10s)
  - Readiness: `/health/ready` (delay: 3s, period: 5s)

### Service

- **Type**: ClusterIP
- **Port**: 80 -> 3000

## Testing the Deployment

```bash
# Check pods
kubectl get pods -l app.kubernetes.io/name=sample-app

# Check service
kubectl get svc sample-app

# Test via Traefik ingress (from host machine)
curl -H "Host: sample-app.local" http://localhost/health
curl -H "Host: sample-app.local" http://localhost/health/ready
curl -H "Host: sample-app.local" http://localhost/health/live

# Test from within cluster
kubectl run curl-test --image=curlimages/curl --rm -it --restart=Never -- \
  curl -s http://sample-app/health

# Port forward to access locally (alternative to ingress)
kubectl port-forward svc/sample-app 8080:80
curl http://localhost:8080/health
```

## Pipeline Details

The Dagger pipeline (`dagger/src/index.ts`) implements a 6-stage CI/CD workflow:

### Stage 1: Lint
Runs ESLint inside a containerized Node.js environment to ensure code quality.

### Stage 2: Test
Executes Vitest unit tests in an isolated container with all dependencies installed.

### Stage 3: Chart Lint
Validates the Helm chart with `helm lint`, including against each environment values file (dev, staging, prod).

### Stage 4: Build & Push
- Builds Docker image using multi-stage Dockerfile
- Pushes image to local registry at `localhost:5001`
- Packages and pushes Helm chart as an OCI artifact to `localhost:5001/charts`

### Stage 5: Deploy
- Runs `helm upgrade --install` using the OCI chart from the registry
- Applies environment-specific values overlay (default: dev)
- Waits for rollout to complete (timeout: 120s)

### Stage 6: Helm Test
- Runs `helm test` to execute the in-cluster connectivity test pod

## Environment Configuration

Environment-specific Helm values live in `environments/`, separate from the chart artifact. The chart is built once and each environment applies its own overlay at deploy time.

| File | Description |
|------|-------------|
| `environments/dev.yaml` | Minimal config: 1 replica, no HPA/PDB/NetworkPolicy |
| `environments/staging.yaml` | 2 replicas, HPA enabled (2–5), PDB |
| `environments/prod.yaml` | 3 replicas, HPA (3–10), PDB, NetworkPolicy, security contexts |

Deploy to a specific environment:

```bash
DEPLOY_ENV=staging npm run pipeline
```

Or manually with Helm:

```bash
helm upgrade --install sample-app oci://localhost:5001/charts/sample-app \
  -f environments/dev.yaml \
  --set image.tag=latest
```

## Inspecting the Local Registry

The local Docker registry at `localhost:5001` exposes the [Docker Registry HTTP API v2](https://docs.docker.com/registry/spec/api/). It stores both container images and Helm chart OCI artifacts.

```bash
# List all repositories
curl -s http://localhost:5001/v2/_catalog | jq .

# List tags for the app image
curl -s http://localhost:5001/v2/sample-app/tags/list | jq .

# List tags for the Helm chart
curl -s http://localhost:5001/v2/charts/sample-app/tags/list | jq .

# Get manifest details for a specific tag
curl -s http://localhost:5001/v2/sample-app/manifests/latest | jq .

# Inspect the chart via Helm
helm show all oci://localhost:5001/charts/sample-app --version 0.1.0
```

## Customization

### Change Image Tag

```bash
IMAGE_TAG=v1.0.0 cd dagger && npm run pipeline
```

### Modify Replicas

Edit the environment values file (e.g. `environments/dev.yaml`):
```yaml
replicaCount: 3
```

### Override Values at Deploy Time

```bash
helm upgrade --install sample-app oci://localhost:5001/charts/sample-app \
  -f environments/dev.yaml \
  --set replicaCount=3
```

## Cleanup

```bash
# Teardown cluster and registry
./scripts/teardown.sh

# Or manually:
helm uninstall sample-app
kind delete cluster --name dagger-demo
docker rm -f kind-registry
```

## Troubleshooting

### Image Pull Errors

If pods show `ImagePullBackOff`, ensure the containerd registry config is set:

```bash
docker exec dagger-demo-control-plane cat /etc/containerd/certs.d/localhost:5001/hosts.toml
```

### Registry Connection Issues

Verify the registry is running and connected to the kind network:

```bash
docker ps | grep registry
docker network inspect kind | grep kind-registry
```

### Dagger Engine Issues

Restart the Dagger engine if needed:

```bash
docker restart dagger-engine-v0.19.8
```

## Technology Stack

- **Runtime**: Node.js 22 (Alpine)
- **Framework**: Express.js
- **Language**: TypeScript 5.7
- **Testing**: Vitest
- **Linting**: ESLint 9 with TypeScript plugin
- **CI/CD**: Dagger (TypeScript SDK)
- **Container**: Docker with multi-stage builds
- **Orchestration**: Kubernetes (Kind)
- **Registry**: Docker Registry v2

## License

MIT
