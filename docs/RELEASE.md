# Release Management

This document describes the complete release process for shipping changes from your local machine to production on EKS. It covers the day-to-day workflow, what happens at each stage, how to handle failures, and how to roll back.

## GitHub Environment Setup (Required)

The production deployment workflow requires a GitHub Environment named `production` with required reviewers configured. Without this, the approval gate in the CI/CD pipeline will pass through without waiting for human sign-off.

To set this up:

1. Go to your GitHub repo → **Settings** → **Environments**
2. Click **New environment**, name it `production`
3. Check **Required reviewers** and add the users or teams who should approve production deploys
4. Optionally configure **Wait timer** (e.g., 5 minutes) to add a cooldown before deployment starts after approval
5. Optionally restrict **Deployment branches** to `main` only

You should also create `dev` and `staging` environments (no approval required) so that deploy history and status are visible in the GitHub UI for those environments.

## Overview

A release moves through four phases:

```
Local development  ->  Kind (integration test)  ->  EKS (dev -> staging -> prod)
```

The same Docker image and Helm chart artifact are built once and promoted through all environments. Environment-specific behavior is controlled entirely by values overlays (`environments/eks-*.yaml`), not by rebuilding.

## 1. Local Development

### Write and test your code

```bash
npm run dev           # Express server on http://localhost:3000 with hot reload
npm test              # Vitest unit tests
npm run lint          # ESLint
```

Tests run against the Express app directly (no container, no cluster). The test suite uses Supertest to make HTTP requests against the app in-process — the server skips binding to a port when `NODE_ENV=test`.

### What to verify before moving on

- `npm test` passes
- `npm run lint` passes
- You've manually hit the endpoints you changed on `localhost:3000` if the change is behavioral

## 2. Kind (Local Integration)

Kind gives you a real Kubernetes cluster on your machine. Use it to verify that your Docker image builds, your Helm chart renders, and the app runs correctly inside a cluster before touching AWS.

### First-time setup

```bash
./scripts/setup.sh
```

This creates a Kind cluster (`dagger-demo`), a local Docker registry on `localhost:5001`, installs Traefik as the ingress controller, and runs `npm install` in both the app and dagger directories. Idempotent — safe to re-run.

### Run the full pipeline

```bash
cd dagger && npm run pipeline
```

This runs all six stages in order:

| Stage | What it does | Runs in |
|-------|-------------|---------|
| **Lint** | ESLint on `src/**/*.ts` | Dagger container (node:22-alpine) |
| **Test** | Vitest unit tests | Dagger container (node:22-alpine) |
| **Chart Lint** | `helm lint` against every values file in `environments/` | Host machine |
| **Build & Push** | `docker build` + push to `localhost:5001`, `helm package` + push OCI chart | Host machine |
| **Deploy** | `helm upgrade --install` using the OCI chart from the registry | Host machine -> Kind cluster |
| **Helm Test** | Runs a curl pod inside the cluster that hits `/health`, `/health/ready`, `/health/live` | Kind cluster |

### Verify manually

```bash
curl -H "Host: sample-app.local" http://localhost/health
curl -H "Host: sample-app.local" http://localhost/health/ready
curl -H "Host: sample-app.local" http://localhost/health/live
```

### What to verify before moving on

- All six pipeline stages pass
- `kubectl get pods -l app.kubernetes.io/name=sample-app` shows pods Running and Ready
- Health endpoints respond correctly through ingress

### Run individual stages

If you're iterating on a specific part:

```bash
cd dagger
npm run pipeline:build       # Just rebuild and push
npm run pipeline:deploy      # Just redeploy
npm run pipeline:helm-test   # Just run the in-cluster test
```

## 3. EKS Deployment

### First-time infrastructure setup

```bash
./scripts/setup-eks.sh
```

This deploys the full CDK stack:
- VPC (2 AZs, public + private subnets, 1 NAT gateway)
- ECR repository (`sample-app`)
- EKS cluster (`dagger-demo-eks`, Kubernetes 1.31, t3.medium nodes, 2-5 auto-scaling)
- AWS Load Balancer Controller (for ALB ingress)
- Three namespaces: `dev`, `staging`, `prod`

It also configures your local `kubectl` context and writes `.env.eks` with all the environment variables the pipeline needs.

You only need to do this once. The cluster persists across releases.

### Source the environment

Every terminal session where you run EKS commands needs:

```bash
source .env.eks
```

This sets `DEPLOYMENT_TARGET=eks` and the AWS/ECR variables. Without it, the pipeline targets Kind.

### Tag your release

Use `IMAGE_TAG` to identify builds. This tag is applied to both the Docker image in ECR and the `image.tag` value passed to Helm at deploy time.

```bash
export IMAGE_TAG=v1.2.0     # or a commit SHA, or "latest"
```

If you don't set it, it defaults to `latest`. For production releases, use a specific version or commit SHA so you can identify and roll back to exact builds.

### Run the full pipeline

```bash
source .env.eks
cd dagger && npm run pipeline
```

When `DEPLOYMENT_TARGET=eks`, the pipeline runs:

```
lint -> test -> chart-lint -> build (ECR) -> deploy dev -> test dev -> deploy staging -> test staging -> deploy prod -> test prod
```

The build stage:
1. Authenticates Docker and Helm with ECR
2. Builds the Docker image and pushes to ECR
3. Packages the Helm chart and pushes it as an OCI artifact to ECR

The deploy-all stage loops through `[dev, staging, prod]` sequentially. For each environment it:
1. Ensures the namespace exists
2. Reads `environments/eks-<env>.yaml` and substitutes `${ECR_REPO_URI}` with the real ECR URI
3. Runs `helm upgrade --install sample-app-<env>` in the `<env>` namespace
4. Waits for the rollout to complete (120s timeout)
5. Prints the ALB DNS hostname if available
6. Runs `helm test` — a curl pod that hits all three health endpoints from inside the cluster
7. If any step fails, the pipeline stops. Environments that deployed successfully stay running.

### Deploy only to specific environments

Skip lint/test/build if the image is already in ECR:

```bash
# Deploy to all three environments
cd dagger && npm run pipeline:deploy-all

# Deploy to a single environment
DEPLOY_ENV=dev cd dagger && npm run pipeline:deploy
DEPLOY_ENV=staging cd dagger && npm run pipeline:deploy
DEPLOY_ENV=prod cd dagger && npm run pipeline:deploy
```

### Verify the deployment

```bash
# Check pods in each namespace
kubectl get pods -n dev
kubectl get pods -n staging
kubectl get pods -n prod

# Check ingress and get ALB DNS
kubectl get ingress -n dev
kubectl get ingress -n staging
kubectl get ingress -n prod

# Hit the app through the ALB (replace with actual ALB DNS)
ALB=$(kubectl get ingress -n prod -o jsonpath='{.items[0].status.loadBalancer.ingress[0].hostname}')
curl -H "Host: sample-app.local" http://$ALB/health
```

ALB provisioning can lag behind the deploy by a few minutes. If the hostname is empty, wait and check again.

## Environment Differences

Each environment progressively enables more production hardening:

| Feature | dev | staging | prod |
|---------|-----|---------|------|
| Replicas | 1 | 2 | 3 |
| HPA | off | 2-5 pods | 3-10 pods |
| PDB | off | minAvailable: 1 | minAvailable: 2 |
| NetworkPolicy | off | off | on (ingress on app port, egress DNS + HTTPS only) |
| Security contexts | off | off | runAsNonRoot, drop ALL capabilities, readOnlyRootFilesystem |
| Ingress | ALB, internet-facing | ALB, internet-facing | ALB, internet-facing |

The Docker image is identical across all three. The only differences come from the values overlays.

## Rollback

### Roll back with Helm

Helm keeps a history of releases. Each `helm upgrade` creates a new revision.

```bash
# See release history for an environment
helm history sample-app-prod -n prod

# Roll back to the previous revision
helm rollback sample-app-prod -n prod

# Roll back to a specific revision
helm rollback sample-app-prod 3 -n prod

# Verify
kubectl rollout status deployment/sample-app -n prod
```

Replace `prod` with `dev` or `staging` as needed. The release names follow the pattern `sample-app-<env>`.

### Roll back by redeploying a previous image tag

If you've been tagging releases, you can redeploy an older version:

```bash
export IMAGE_TAG=v1.1.0   # the known-good version
DEPLOY_ENV=prod cd dagger && npm run pipeline:deploy
```

This pulls the chart from ECR and deploys it with the old image tag. No rebuild needed — the old image is still in ECR.

### Partial rollback

If prod is broken but dev and staging are fine, you only need to roll back prod:

```bash
helm rollback sample-app-prod -n prod
```

The `deploy-all` command deploys sequentially and stops on failure, so if prod fails during a pipeline run, dev and staging will already be on the new version. This is intentional — it lets you fix forward or roll back just the broken environment.

## What the Pipeline Does Not Do

The pipeline handles build, push, deploy, and smoke testing. These things are outside its scope and should be handled by your team's process:

- **Git tagging / GitHub releases** — Tag your repo manually or via CI when you decide something is a release.
- **Changelog generation** — Not automated. Write changelogs as part of your PR process.
- **Approval gates between environments** — The CI/CD pipeline requires manual approval before deploying to production (via the GitHub `production` environment — see [GitHub Environment Setup](#github-environment-setup-required) above). The local `deploy-all` command still rolls straight through without pausing; the gate only applies to GitHub Actions workflows.
- **DNS / TLS** — ALB creates a DNS hostname automatically, but mapping that to a friendly domain (e.g., `app.example.com`) and provisioning TLS certificates is handled outside this pipeline (Route 53, ACM, or your DNS provider).
- **Monitoring and alerting** — The pipeline runs Helm tests (in-cluster health check) but does not set up CloudWatch, Datadog, or any observability stack.
- **Database migrations** — If your app has a database, run migrations before deploying, not as part of the pipeline.
- **Canary / blue-green deployments** — Helm does a rolling update. There is no canary or blue-green mechanism built in.

## Common Workflows

### Ship a feature to prod

```bash
# 1. Develop and test locally
npm test && npm run lint

# 2. Integration test on Kind
cd dagger && npm run pipeline
cd ..

# 3. Deploy to EKS (all environments)
source .env.eks
export IMAGE_TAG=$(git rev-parse --short HEAD)
cd dagger && npm run pipeline
```

### Hotfix prod without touching dev/staging

```bash
source .env.eks
export IMAGE_TAG=$(git rev-parse --short HEAD)
cd dagger && npm run pipeline:build              # Build and push to ECR
DEPLOY_ENV=prod cd dagger && npm run pipeline:deploy   # Deploy only to prod
DEPLOY_ENV=prod cd dagger && npm run pipeline:helm-test  # Verify
```

### Rebuild infrastructure from scratch

```bash
./scripts/teardown-eks.sh    # Destroy everything
./scripts/setup-eks.sh       # Recreate from CDK
source .env.eks
cd dagger && npm run pipeline   # Redeploy app
```

The CDK stack is fully declarative. Tearing down and recreating produces an identical cluster. The only state lost is the running application — ECR images are destroyed with the stack, so you'll need to rebuild.

## Troubleshooting

### Pipeline fails at ECR login

Your AWS credentials may be expired. Re-authenticate:

```bash
aws sts get-caller-identity   # Check if creds work
aws sso login                 # If using SSO
source .env.eks               # Re-source after fixing creds
```

### Deploy times out (120s)

The image may be failing to start. Check pod events:

```bash
kubectl describe pods -n <env> -l app.kubernetes.io/name=sample-app
kubectl logs -n <env> -l app.kubernetes.io/name=sample-app --previous
```

Common causes: image pull errors (wrong ECR URI or tag), crash loops (app startup failure), readiness probe never passing.

### Helm test fails

The test pod curls the app's health endpoints from inside the cluster. If it fails:

```bash
# Check if the service exists and has endpoints
kubectl get svc -n <env>
kubectl get endpoints -n <env>

# Run a manual curl from inside the cluster
kubectl run debug --image=curlimages/curl --rm -it -n <env> --restart=Never -- \
  curl -v http://sample-app:80/health
```

### ALB not provisioning

Check the AWS Load Balancer Controller logs:

```bash
kubectl logs -n kube-system -l app.kubernetes.io/name=aws-load-balancer-controller
```

Common causes: missing IAM permissions, subnet tagging issues, or the ingress annotations are wrong. Verify the ingress resource:

```bash
kubectl describe ingress -n <env>
```

### Namespace missing

The pipeline creates namespaces automatically during deploy, but if they're missing:

```bash
kubectl create namespace dev
kubectl create namespace staging
kubectl create namespace prod
```

The CDK stack also creates them during initial setup.
