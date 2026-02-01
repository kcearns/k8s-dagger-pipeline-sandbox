import { dag, Container, Directory } from "@dagger.io/dagger";
import * as dagger from "@dagger.io/dagger";
import { execSync } from "child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Deployment target: "kind" (default) or "eks"
const DEPLOYMENT_TARGET = process.env.DEPLOYMENT_TARGET || "kind";
const AWS_REGION = process.env.AWS_REGION || "us-east-1";
const AWS_ACCOUNT_ID = process.env.AWS_ACCOUNT_ID || "";
const ECR_REPO_URI = process.env.ECR_REPO_URI || "";

// Registry selection based on deployment target
const REGISTRY =
  DEPLOYMENT_TARGET === "eks"
    ? `${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com`
    : "localhost:5001";
const IMAGE_NAME =
  DEPLOYMENT_TARGET === "eks"
    ? ECR_REPO_URI
    : `${REGISTRY}/sample-app`;
const CHART_REPO =
  DEPLOYMENT_TARGET === "eks"
    ? `oci://${REGISTRY}/charts`
    : "oci://localhost:5001/charts";

const IMAGE_TAG = process.env.IMAGE_TAG || "latest";
const DEPLOY_ENV = process.env.DEPLOY_ENV || "dev";
const FULL_IMAGE = `${IMAGE_NAME}:${IMAGE_TAG}`;

const projectRoot = resolve(__dirname, "../..");
const helmChartDir = resolve(projectRoot, "helm/sample-app");
const environmentsDir = resolve(projectRoot, "environments");

async function getSource(): Promise<Directory> {
  return dag.host().directory("..", {
    exclude: ["node_modules", "dist", "dagger", ".git"],
  });
}

async function getNodeContainer(source: Directory): Promise<Container> {
  return dag
    .container()
    .from("node:22-alpine")
    .withDirectory("/app", source)
    .withWorkdir("/app")
    .withExec(["npm", "ci"]);
}

async function lint(): Promise<string> {
  console.log("🔍 Running linter...");
  const source = await getSource();
  const container = await getNodeContainer(source);

  const result = await container.withExec(["npm", "run", "lint"]).stdout();

  console.log("✅ Lint passed!");
  return result;
}

async function test(): Promise<string> {
  console.log("🧪 Running tests...");
  const source = await getSource();
  const container = await getNodeContainer(source);

  const result = await container.withExec(["npm", "test"]).stdout();

  console.log("✅ Tests passed!");
  return result;
}

async function chartLint(): Promise<void> {
  console.log("📋 Linting Helm chart...");

  try {
    execSync(`helm lint ${helmChartDir}`, { stdio: "inherit" });

    const envFiles = readdirSync(environmentsDir).filter((f) =>
      f.endsWith(".yaml")
    );
    for (const envFile of envFiles) {
      const valuesPath = resolve(environmentsDir, envFile);
      console.log(`📋 Linting chart with ${envFile}...`);
      execSync(`helm lint ${helmChartDir} -f ${valuesPath}`, {
        stdio: "inherit",
      });
    }

    console.log("✅ Helm chart lint passed!");
  } catch (error) {
    console.error("❌ Helm chart lint failed:", error);
    throw error;
  }
}

function ecrLogin(): void {
  console.log("🔑 Logging into ECR...");
  execSync(
    `aws ecr get-login-password --region ${AWS_REGION} | docker login --username AWS --password-stdin ${REGISTRY}`,
    { stdio: "inherit" }
  );
}

function helmLoginEcr(): void {
  console.log("🔑 Logging Helm into ECR...");
  execSync(
    `aws ecr get-login-password --region ${AWS_REGION} | helm registry login --username AWS --password-stdin ${REGISTRY}`,
    { stdio: "inherit" }
  );
}

function getEnvironmentFile(env: string): string {
  if (DEPLOYMENT_TARGET === "eks") {
    return resolve(environmentsDir, `eks-${env}.yaml`);
  }
  return resolve(environmentsDir, `${env}.yaml`);
}

function substituteEcrUri(valuesFile: string): string {
  if (DEPLOYMENT_TARGET !== "eks" || !ECR_REPO_URI) {
    return valuesFile;
  }

  const content = readFileSync(valuesFile, "utf-8");
  const substituted = content.replace(/\$\{ECR_REPO_URI\}/g, ECR_REPO_URI);
  const tmpFile = resolve(tmpdir(), `values-${Date.now()}.yaml`);
  writeFileSync(tmpFile, substituted);
  return tmpFile;
}

async function build(): Promise<string> {
  console.log(`🔨 Building image ${FULL_IMAGE}...`);

  if (DEPLOYMENT_TARGET === "eks") {
    ecrLogin();
    helmLoginEcr();
  }

  execSync(`docker build -t ${FULL_IMAGE} ${projectRoot}`, {
    stdio: "inherit",
  });

  console.log(`📤 Pushing image to registry...`);
  execSync(`docker push ${FULL_IMAGE}`, { stdio: "inherit" });

  console.log(`📦 Packaging Helm chart...`);
  execSync(`helm package ${helmChartDir} --destination /tmp`, {
    stdio: "inherit",
  });

  console.log(`📤 Pushing chart to ${CHART_REPO}...`);
  execSync(`helm push /tmp/sample-app-*.tgz ${CHART_REPO}`, {
    stdio: "inherit",
  });

  console.log(`✅ Image published: ${FULL_IMAGE}`);
  console.log(`✅ Chart published: ${CHART_REPO}/sample-app`);
  return FULL_IMAGE;
}

async function deploy(env?: string): Promise<void> {
  const targetEnv = env || DEPLOY_ENV;
  console.log(`🚀 Deploying to Kubernetes (env: ${targetEnv}, target: ${DEPLOYMENT_TARGET})...`);

  const valuesFile = getEnvironmentFile(targetEnv);

  if (!existsSync(valuesFile)) {
    throw new Error(
      `Environment values file not found: ${valuesFile}. Valid environments: dev, staging, prod`
    );
  }

  const resolvedValuesFile = substituteEcrUri(valuesFile);

  try {
    const namespaceArgs: string[] = [];
    if (DEPLOYMENT_TARGET === "eks") {
      // Ensure namespace exists
      try {
        execSync(`kubectl create namespace ${targetEnv} --dry-run=client -o yaml | kubectl apply -f -`, {
          stdio: "inherit",
        });
      } catch {
        // Namespace may already exist
      }
      namespaceArgs.push(`--namespace ${targetEnv}`);
    }

    const releaseName =
      DEPLOYMENT_TARGET === "eks" ? `sample-app-${targetEnv}` : "sample-app";
    const helmCmd = [
      `helm upgrade --install ${releaseName}`,
      `${CHART_REPO}/sample-app`,
      `-f ${resolvedValuesFile}`,
      `--set image.tag=${IMAGE_TAG}`,
      ...namespaceArgs,
      "--wait",
      "--timeout 120s",
    ].join(" ");

    execSync(helmCmd, { stdio: "inherit" });

    console.log(`✅ Deployment to ${targetEnv} complete!`);

    if (DEPLOYMENT_TARGET === "eks") {
      // Print ALB DNS if available
      try {
        const ingress = execSync(
          `kubectl get ingress -n ${targetEnv} -o jsonpath='{.items[0].status.loadBalancer.ingress[0].hostname}' 2>/dev/null`,
          { encoding: "utf-8" }
        ).trim();
        if (ingress) {
          console.log(`🌐 ALB DNS: ${ingress}`);
        }
      } catch {
        console.log("ℹ️  ALB DNS not yet available (may take a few minutes)");
      }
    }
  } catch (error) {
    console.error(`❌ Deployment to ${targetEnv} failed:`, error);
    throw error;
  }
}

async function helmTest(env?: string): Promise<void> {
  const targetEnv = env || DEPLOY_ENV;
  console.log(`🧪 Running Helm tests (env: ${targetEnv})...`);

  try {
    const releaseName =
      DEPLOYMENT_TARGET === "eks" ? `sample-app-${targetEnv}` : "sample-app";
    const namespaceArgs =
      DEPLOYMENT_TARGET === "eks" ? `--namespace ${targetEnv}` : "";
    execSync(`helm test ${releaseName} ${namespaceArgs} --timeout 60s`.trim(), {
      stdio: "inherit",
    });
    console.log(`✅ Helm tests passed for ${targetEnv}!`);
  } catch (error) {
    console.error(`❌ Helm tests failed for ${targetEnv}:`, error);
    throw error;
  }
}

async function deployAll(): Promise<void> {
  console.log("🚀 Deploying to all environments...\n");

  const environments = ["dev", "staging", "prod"];

  for (const env of environments) {
    console.log(`\n${"=".repeat(50)}`);
    console.log(`📦 Deploying to ${env}...\n`);
    await deploy(env);

    console.log(`\n🧪 Testing ${env}...\n`);
    await helmTest(env);

    console.log(`\n✅ ${env} complete!\n`);
  }

  console.log("=".repeat(50));
  console.log("🎉 All environments deployed and tested!");
}

async function pipeline(): Promise<void> {
  console.log("🚀 Starting CI/CD Pipeline\n");
  console.log(`   Target: ${DEPLOYMENT_TARGET}`);
  console.log("=".repeat(50));

  console.log("\n📦 Stage 1: Lint\n");
  await lint();

  console.log("\n📦 Stage 2: Test\n");
  await test();

  console.log("\n📦 Stage 3: Chart Lint\n");
  await chartLint();

  console.log("\n📦 Stage 4: Build & Push\n");
  await build();

  if (DEPLOYMENT_TARGET === "eks") {
    console.log("\n📦 Stage 5: Deploy All Environments\n");
    await deployAll();
  } else {
    console.log("\n📦 Stage 5: Deploy\n");
    await deploy();

    console.log("\n📦 Stage 6: Helm Test\n");
    await helmTest();
  }

  console.log("\n" + "=".repeat(50));
  console.log("🎉 Pipeline completed successfully!");
}

async function main(): Promise<void> {
  const command = process.argv[2] || "all";

  await dagger.connection(
    async () => {
      switch (command) {
        case "lint":
          await lint();
          break;
        case "test":
          await test();
          break;
        case "chart-lint":
          await chartLint();
          break;
        case "build":
          await build();
          break;
        case "deploy":
          await deploy();
          break;
        case "helm-test":
          await helmTest();
          break;
        case "deploy-all":
          await deployAll();
          break;
        case "all":
        default:
          await pipeline();
      }
    },
    { LogOutput: process.stderr }
  );
}

main().catch((err) => {
  console.error("Pipeline failed:", err);
  process.exit(1);
});
