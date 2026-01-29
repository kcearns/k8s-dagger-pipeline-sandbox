import { dag, Container, Directory } from "@dagger.io/dagger";
import * as dagger from "@dagger.io/dagger";
import { execSync } from "child_process";
import { existsSync, readdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const REGISTRY = "localhost:5001";
const IMAGE_NAME = `${REGISTRY}/sample-app`;
const CHART_REPO = `oci://${REGISTRY}/charts`;
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

async function build(): Promise<string> {
  console.log(`🔨 Building image ${FULL_IMAGE}...`);

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

async function deploy(): Promise<void> {
  console.log(`🚀 Deploying to Kubernetes (env: ${DEPLOY_ENV})...`);

  const valuesFile = resolve(environmentsDir, `${DEPLOY_ENV}.yaml`);

  if (!existsSync(valuesFile)) {
    throw new Error(
      `Environment values file not found: ${valuesFile}. Valid environments: dev, staging, prod`
    );
  }

  try {
    const helmCmd = [
      "helm upgrade --install sample-app",
      `${CHART_REPO}/sample-app`,
      `-f ${valuesFile}`,
      `--set image.tag=${IMAGE_TAG}`,
      "--wait",
      "--timeout 120s",
    ].join(" ");

    execSync(helmCmd, { stdio: "inherit" });

    console.log("✅ Deployment complete!");
  } catch (error) {
    console.error("❌ Deployment failed:", error);
    throw error;
  }
}

async function helmTest(): Promise<void> {
  console.log("🧪 Running Helm tests...");

  try {
    execSync("helm test sample-app --timeout 60s", { stdio: "inherit" });
    console.log("✅ Helm tests passed!");
  } catch (error) {
    console.error("❌ Helm tests failed:", error);
    throw error;
  }
}

async function pipeline(): Promise<void> {
  console.log("🚀 Starting CI/CD Pipeline\n");
  console.log("=".repeat(50));

  console.log("\n📦 Stage 1: Lint\n");
  await lint();

  console.log("\n📦 Stage 2: Test\n");
  await test();

  console.log("\n📦 Stage 3: Chart Lint\n");
  await chartLint();

  console.log("\n📦 Stage 4: Build & Push\n");
  await build();

  console.log("\n📦 Stage 5: Deploy\n");
  await deploy();

  console.log("\n📦 Stage 6: Helm Test\n");
  await helmTest();

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
