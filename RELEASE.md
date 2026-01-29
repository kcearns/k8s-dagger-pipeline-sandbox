# Release Pipeline

End-to-end CI/CD pipeline from local development through preview, staging, UAT, and production environments.

## Repository Layout

| Repo | Purpose |
|------|---------|
| **app repo** (this repo) | Application source, Dagger pipeline, Dockerfile, Helm chart |
| **gitops-config repo** | Environment values files, ArgoCD Application manifests |

The app repo owns the code and chart artifact. The gitops-config repo owns the runtime configuration for every environment. Changes to either repo trigger different parts of the pipeline.

---

## Environments

| Environment | Namespace | Trigger | Purpose |
|-------------|-----------|---------|---------|
| **dev** | `dev` | Local pipeline (`npm run pipeline`) | Developer inner loop on Kind cluster |
| **preview** | `preview-<pr-number>` | PR opened/updated | Ephemeral per-PR environment for review |
| **staging** | `staging` | Merge to `main` | Integration testing, always tracks latest `main` |
| **uat** | `uat` | Git tag `vX.Y.Z-rc.*` | Pre-release validation by QA/stakeholders |
| **prod** | `prod` | Promotion from UAT (manual approval) | Production traffic |

---

## Pipeline Stages

### 1. Local Development (dev)

Developers run the full Dagger pipeline locally against a Kind cluster with a local registry on `localhost:5001`.

```
npm run pipeline
```

This runs: lint -> test -> chart-lint -> build (push to local registry) -> deploy (to Kind) -> helm-test.

No CI infrastructure required. The same Dagger pipeline stages used locally are reused in CI.

---

### 2. Pull Request — Preview Environment

**Trigger:** PR opened or updated against `main`.

```yaml
# .github/workflows/pr.yaml
name: PR Pipeline
on:
  pull_request:
    branches: [main]

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22

      # Install Dagger CLI
      - uses: dagger/dagger-for-github@v7

      # Run lint and test stages via Dagger (same as local)
      - run: cd dagger && npm ci
      - run: cd dagger && npx tsx src/index.ts lint
      - run: cd dagger && npx tsx src/index.ts test
      - run: cd dagger && npx tsx src/index.ts chart-lint

  preview:
    needs: validate
    runs-on: ubuntu-latest
    permissions:
      id-token: write      # OIDC for AWS
      contents: read
      pull-requests: write  # Comment preview URL
    env:
      IMAGE_TAG: pr-${{ github.event.pull_request.number }}-${{ github.sha }}
      PREVIEW_NS: preview-${{ github.event.pull_request.number }}
    steps:
      - uses: actions/checkout@v4

      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::ACCOUNT_ID:role/ci-role
          aws-region: us-east-1

      - uses: aws-actions/amazon-ecr-login@v2

      # Build and push container image
      - run: |
          docker build -t $ECR_REGISTRY/sample-app:$IMAGE_TAG .
          docker push $ECR_REGISTRY/sample-app:$IMAGE_TAG

      # Package and push Helm chart (OCI)
      - run: |
          helm package helm/sample-app --version 0.0.0-$IMAGE_TAG
          helm push sample-app-0.0.0-$IMAGE_TAG.tgz oci://$ECR_REGISTRY/charts

      # Deploy ephemeral preview environment directly (no ArgoCD)
      - run: |
          helm upgrade --install sample-app-$PREVIEW_NS \
            oci://$ECR_REGISTRY/charts/sample-app \
            --version 0.0.0-$IMAGE_TAG \
            -n $PREVIEW_NS --create-namespace \
            -f environments/preview.yaml \
            --set image.tag=$IMAGE_TAG \
            --wait --timeout 120s

      # Comment the preview URL on the PR
      - uses: actions/github-script@v7
        with:
          script: |
            github.rest.issues.createComment({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: context.issue.number,
              body: `Preview deployed: https://pr-${context.issue.number}.preview.example.com`
            });
```

**Cleanup:** A separate workflow tears down the preview namespace when the PR is closed.

```yaml
# .github/workflows/pr-cleanup.yaml
name: Preview Cleanup
on:
  pull_request:
    types: [closed]

jobs:
  cleanup:
    runs-on: ubuntu-latest
    steps:
      - run: |
          helm uninstall sample-app-preview-${{ github.event.pull_request.number }} \
            -n preview-${{ github.event.pull_request.number }}
          kubectl delete namespace preview-${{ github.event.pull_request.number }}
```

---

### 3. Merge to Main — Staging

**Trigger:** Push to `main` (PR merge).

```yaml
# .github/workflows/main.yaml
name: Main Pipeline
on:
  push:
    branches: [main]

jobs:
  build-and-publish:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read
    outputs:
      image_tag: ${{ steps.meta.outputs.tag }}
      chart_version: ${{ steps.meta.outputs.chart_version }}
    steps:
      - uses: actions/checkout@v4

      - id: meta
        run: |
          TAG="sha-$(git rev-parse --short HEAD)"
          echo "tag=$TAG" >> "$GITHUB_OUTPUT"
          echo "chart_version=0.1.0-$TAG" >> "$GITHUB_OUTPUT"

      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::ACCOUNT_ID:role/ci-role
          aws-region: us-east-1
      - uses: aws-actions/amazon-ecr-login@v2

      # Dagger lint + test (same stages as local)
      - uses: dagger/dagger-for-github@v7
      - run: cd dagger && npm ci
      - run: cd dagger && npx tsx src/index.ts lint
      - run: cd dagger && npx tsx src/index.ts test
      - run: cd dagger && npx tsx src/index.ts chart-lint

      # Build and push image
      - run: |
          docker build -t $ECR_REGISTRY/sample-app:${{ steps.meta.outputs.tag }} .
          docker push $ECR_REGISTRY/sample-app:${{ steps.meta.outputs.tag }}

      # Package and push Helm chart
      - run: |
          helm package helm/sample-app --version ${{ steps.meta.outputs.chart_version }}
          helm push sample-app-${{ steps.meta.outputs.chart_version }}.tgz oci://$ECR_REGISTRY/charts

  promote-to-staging:
    needs: build-and-publish
    runs-on: ubuntu-latest
    steps:
      # Update the gitops-config repo to point staging at the new chart + image
      - uses: actions/checkout@v4
        with:
          repository: your-org/gitops-config
          token: ${{ secrets.GITOPS_PAT }}

      - run: |
          cd environments/staging
          yq e '.image.tag = "${{ needs.build-and-publish.outputs.image_tag }}"' -i values.yaml
          yq e '.spec.source.targetRevision = "${{ needs.build-and-publish.outputs.chart_version }}"' -i ../../apps/staging/sample-app.yaml
          git add .
          git commit -m "deploy sample-app ${{ needs.build-and-publish.outputs.image_tag }} to staging"
          git push
```

ArgoCD detects the commit to the gitops-config repo and syncs staging automatically.

---

### 4. Release Candidate — UAT

**Trigger:** A release candidate tag is pushed (`vX.Y.Z-rc.N`).

```yaml
# .github/workflows/release-candidate.yaml
name: Release Candidate
on:
  push:
    tags: ['v*-rc.*']

jobs:
  publish-rc:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: actions/checkout@v4

      - id: meta
        run: |
          echo "tag=${GITHUB_REF_NAME}" >> "$GITHUB_OUTPUT"
          # Strip the leading 'v' for chart version
          echo "chart_version=${GITHUB_REF_NAME#v}" >> "$GITHUB_OUTPUT"

      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::ACCOUNT_ID:role/ci-role
          aws-region: us-east-1
      - uses: aws-actions/amazon-ecr-login@v2

      # Full validation
      - uses: dagger/dagger-for-github@v7
      - run: cd dagger && npm ci
      - run: cd dagger && npx tsx src/index.ts lint
      - run: cd dagger && npx tsx src/index.ts test
      - run: cd dagger && npx tsx src/index.ts chart-lint

      # Build with release tag
      - run: |
          docker build -t $ECR_REGISTRY/sample-app:${{ steps.meta.outputs.tag }} .
          docker push $ECR_REGISTRY/sample-app:${{ steps.meta.outputs.tag }}

      # Package chart with release version
      - run: |
          helm package helm/sample-app \
            --version ${{ steps.meta.outputs.chart_version }} \
            --app-version ${{ steps.meta.outputs.tag }}
          helm push sample-app-${{ steps.meta.outputs.chart_version }}.tgz oci://$ECR_REGISTRY/charts

  promote-to-uat:
    needs: publish-rc
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          repository: your-org/gitops-config
          token: ${{ secrets.GITOPS_PAT }}

      - run: |
          cd environments/uat
          yq e '.image.tag = "${{ github.ref_name }}"' -i values.yaml
          yq e '.spec.source.targetRevision = "${{ needs.publish-rc.outputs.chart_version }}"' -i ../../apps/uat/sample-app.yaml
          git add .
          git commit -m "deploy sample-app ${{ github.ref_name }} to uat"
          git push
```

ArgoCD syncs UAT. QA and stakeholders validate the release candidate.

---

### 5. Production — Promotion from UAT

**Trigger:** Manual workflow dispatch after UAT sign-off. A final `vX.Y.Z` tag (no `-rc`) is created from the validated RC.

```yaml
# .github/workflows/promote-prod.yaml
name: Promote to Production
on:
  workflow_dispatch:
    inputs:
      release_tag:
        description: 'Release tag to promote (e.g., v1.2.0)'
        required: true

jobs:
  promote:
    runs-on: ubuntu-latest
    environment: production    # Requires GitHub environment approval
    steps:
      - uses: actions/checkout@v4
        with:
          repository: your-org/gitops-config
          token: ${{ secrets.GITOPS_PAT }}

      - name: Verify artifacts exist
        run: |
          # Confirm the image and chart were published
          aws ecr describe-images --repository-name sample-app \
            --image-ids imageTag=${{ inputs.release_tag }}
          helm show chart oci://$ECR_REGISTRY/charts/sample-app \
            --version ${RELEASE_TAG#v}

      - name: Update production config
        run: |
          RELEASE_TAG=${{ inputs.release_tag }}
          cd environments/prod
          yq e ".image.tag = \"$RELEASE_TAG\"" -i values.yaml
          yq e ".spec.source.targetRevision = \"${RELEASE_TAG#v}\"" -i ../../apps/prod/sample-app.yaml
          git add .
          git commit -m "promote sample-app $RELEASE_TAG to production"
          git push

      - name: Create GitHub Release
        uses: softprops/action-gh-release@v2
        with:
          tag_name: ${{ inputs.release_tag }}
          generate_release_notes: true
```

ArgoCD syncs production. The ArgoCD Application for prod is configured with manual sync or auto-sync depending on your risk tolerance.

---

## GitOps Config Repo Structure

```
gitops-config/
  apps/
    staging/
      sample-app.yaml          # ArgoCD Application manifest
    uat/
      sample-app.yaml
    prod/
      sample-app.yaml
  environments/
    preview.yaml               # Shared base for all preview envs
    staging/
      values.yaml              # staging overrides (image.tag, resources, etc.)
    uat/
      values.yaml
    prod/
      values.yaml
```

**ArgoCD Application manifest example** (`apps/staging/sample-app.yaml`):

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: sample-app-staging
  namespace: argocd
spec:
  project: default
  source:
    chart: sample-app
    repoURL: ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com/charts
    targetRevision: 0.1.0-sha-abc1234     # Updated by CI
    helm:
      valueFiles:
        - $values/environments/staging/values.yaml
  destination:
    server: https://kubernetes.default.svc
    namespace: staging
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
```

---

## Artifact Flow

```
                 app repo                              gitops-config repo
                    |                                         |
             push / tag / PR                                  |
                    |                                         |
            GitHub Actions                                    |
           +-----------------+                                |
           | lint            |                                |
           | test            |                                |
           | chart-lint      |                                |
           | docker build    |                                |
           | helm package    |                                |
           +--------+--------+                                |
                    |                                         |
         publish artifacts                                    |
          |                |                                  |
    +-----v-----+  +------v------+                            |
    |    ECR     |  | ECR (OCI)  |                            |
    |  (image)   |  |  (chart)   |                            |
    +-----+------+  +------+-----+                            |
          |                |                                  |
          +-------+--------+                                  |
                  |                                           |
       CI commits new version ------>  environments/<env>/values.yaml
                                       apps/<env>/sample-app.yaml
                                                  |
                                            ArgoCD detects
                                                  |
                                         +--------v--------+
                                         |  sync to cluster |
                                         +-----------------+
```

---

## Rollback

**Staging/UAT:** Revert the commit in the gitops-config repo. ArgoCD syncs to the previous version.

**Production:** Run the promote workflow again with the previous known-good tag. Or revert the gitops-config commit. ArgoCD handles the rest.

No re-build required — the previous image and chart are still in ECR.

---

## Environment Progression Summary

```
feature branch
    |
    PR --> preview-<n>  (ephemeral, helm install, auto-cleanup)
    |
  merge
    |
   main --> staging     (auto-deploy via ArgoCD)
    |
  v1.0.0-rc.1
    |
   tag --> uat          (auto-deploy via ArgoCD, QA validates)
    |
  v1.0.0 (manual)
    |
   promote --> prod     (manual trigger + GitHub environment approval, ArgoCD syncs)
```
