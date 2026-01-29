# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TypeScript/Express.js sample application with a Dagger-based CI/CD pipeline that builds, tests, and deploys to a local Kind Kubernetes cluster. Deployment is managed via Helm charts with multi-environment support (dev/staging/prod).

## Commands

```bash
# App development
npm run dev              # Start dev server with hot reload (port 3000)
npm run build            # Compile TypeScript to dist/
npm test                 # Run Vitest unit tests
npm run test:watch       # Run tests in watch mode
npm run lint             # ESLint on src/**/*.ts

# Setup (cluster, registry, deps) — idempotent
./scripts/setup.sh

# Full CI/CD pipeline (lint -> test -> chart-lint -> build -> deploy -> helm-test)
cd dagger && npm run pipeline

# Individual pipeline stages (run from dagger/ directory)
cd dagger && npm run pipeline:lint
cd dagger && npm run pipeline:test
cd dagger && npm run pipeline:chart-lint
cd dagger && npm run pipeline:build
cd dagger && npm run pipeline:deploy
cd dagger && npm run pipeline:helm-test

# Teardown cluster and registry
./scripts/teardown.sh
```

Environment variables for the pipeline:
- `IMAGE_TAG` — Docker image tag (default: "latest")
- `DEPLOY_ENV` — Target environment: dev, staging, prod (default: "dev")

## Architecture

**App** (`src/`): Express.js server with health check routes (`/health`, `/health/ready`, `/health/live`). Entry point is `src/index.ts`, routes are modular in `src/routes/`. Tests use Vitest + Supertest in `src/__tests__/`.

**Dagger Pipeline** (`dagger/src/index.ts`): 6-stage pipeline (lint → test → chart-lint → build/push → deploy → helm-test). Lint and test stages run in containerized Node.js 22-Alpine via Dagger SDK. Chart lint validates templates against all environment files. Build stage uses `docker build` + push to local registry (`localhost:5001`) and packages/pushes the Helm chart as an OCI artifact. Deploy stage runs `helm upgrade --install` with environment-specific values from `environments/`. Helm test runs an in-cluster connectivity check.

**Helm Chart** (`helm/sample-app/`): Templates for Deployment, Service, ServiceAccount, HPA, PDB, and NetworkPolicy. Contains only default `values.yaml` (schema contract) — no environment-specific values.

**Environment Config** (`environments/`): Per-environment values files (`dev.yaml`, `staging.yaml`, `prod.yaml`) kept separate from the chart artifact. Applied as overlays at deploy time via `-f environments/<env>.yaml`. Progressively enable features — dev is minimal, prod enables HPA, PDB, NetworkPolicy, and security contexts.

**Dockerfile**: Multi-stage build targeting `node:22-alpine`. Production stage runs as non-root user `appuser` (UID 1001).

## Infrastructure Setup

Requires a Kind cluster named `dagger-demo` with a local Docker registry on `localhost:5001` connected to the `kind` network. Run `./scripts/setup.sh` to create everything. Run `./scripts/teardown.sh` to destroy. For Linux prerequisites (Node.js, Docker, Kind, Helm, Dagger, kubectl), run `./scripts/install-prereqs.sh`.

**IMPORTANT**: Always use the local `kind.yaml` config file and shell commands to manage the Kind cluster. Do NOT use the k8s-kind MCP server — use `kind create cluster --name dagger-demo --config kind.yaml` and related CLI commands directly via Bash.

## Key Patterns

- The Dagger pipeline has its own `package.json` and `tsconfig.json` under `dagger/` — install deps there separately (`cd dagger && npm install`)
- Pipeline accepts a command argument (`lint`, `test`, `chart-lint`, `build`, `deploy`, `helm-test`, or `all`) to run individual stages
- The Express server skips binding to a port during test execution
- Environment values files live in `environments/`, not inside the Helm chart — the chart is built once and environment config is applied as an overlay at deploy time
- Helm values follow progressive enhancement: dev < staging < prod
