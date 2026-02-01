#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { EksStack } from "../lib/eks-stack";

const app = new cdk.App();

const account = process.env.AWS_ACCOUNT_ID || process.env.CDK_DEFAULT_ACCOUNT;
const region = process.env.AWS_REGION || process.env.CDK_DEFAULT_REGION || "us-east-1";

if (!account) {
  throw new Error(
    "AWS_ACCOUNT_ID or CDK_DEFAULT_ACCOUNT must be set. " +
    "Run: export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)"
  );
}

new EksStack(app, "DaggerDemoEks", {
  env: { account, region },
});
