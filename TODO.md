# dagger-k8s Project Roadmap

## Completed

- [x] Express.js app with health check endpoints (`/health`, `/health/live`, `/health/ready`)
- [x] Unit tests with Vitest + Supertest
- [x] ESLint configuration
- [x] Multi-stage Dockerfile (non-root user, production optimized)
- [x] Dagger CI/CD pipeline (lint, test, build, deploy)
- [x] Kind cluster with local registry (localhost:5001)
- [x] Helm chart with multi-environment support (dev/staging/prod)
  - [x] Deployment, Service, ServiceAccount templates
  - [x] HPA template (staging/prod)
  - [x] PDB template (staging/prod)
  - [x] NetworkPolicy template (prod)
  - [x] Security contexts (prod)
- [x] Deployed to Kind cluster via Helm

## To Do

### 1. Ingress
- [x] Add Traefik IngressRoute (or standard Ingress) template to Helm chart
- [x] Make ingress configurable per environment in values files
- [x] Verify app is accessible without `kubectl port-forward`

### 2. Observability
- [ ] Add ServiceMonitor template to Helm chart for Prometheus scraping
- [ ] Add metrics endpoint to the app (e.g. prom-client)
- [ ] Add structured logging (e.g. pino)
- [ ] Verify metrics appear in Grafana (cluster already has Prometheus/Grafana stack)

### 3. GitHub Actions CI
- [ ] Add `.github/workflows/ci.yml` that runs the Dagger pipeline on push/PR
- [ ] Run lint + test stages in CI
- [ ] Build stage (push to registry only on main branch merge)

### 4. App Functionality
- [ ] Add actual API routes beyond health checks
- [ ] Add database connection (e.g. PostgreSQL)
- [ ] Add corresponding tests for new routes

### 5. Secrets Management
- [ ] Add Secret template to Helm chart
- [ ] Wire environment variables into the deployment from Secrets
- [ ] Document secret creation per environment

### 6. Helm Chart Testing
- [x] Add `helm test` hook (e.g. connectivity test pod)
- [ ] Add chart-testing (`ct lint`, `ct install`) validation (deferred to CI)
- [x] Integrate chart tests into Dagger pipeline or CI
