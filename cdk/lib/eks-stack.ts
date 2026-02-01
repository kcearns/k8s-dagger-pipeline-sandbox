import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as eks from "aws-cdk-lib/aws-eks";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import { KubectlV31Layer } from "@aws-cdk/lambda-layer-kubectl-v31";

export class EksStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // VPC with 2 AZs, 1 NAT gateway
    const vpc = new ec2.Vpc(this, "EksVpc", {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        {
          name: "Public",
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: "Private",
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
      ],
    });

    // ECR repository
    const ecrRepo = new ecr.Repository(this, "SampleAppRepo", {
      repositoryName: "sample-app",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: true,
    });

    // EKS cluster
    const cluster = new eks.Cluster(this, "EksCluster", {
      clusterName: "dagger-demo-eks",
      version: eks.KubernetesVersion.V1_31,
      vpc,
      vpcSubnets: [{ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }],
      defaultCapacity: 0,
      kubectlLayer: new KubectlV31Layer(this, "KubectlLayer"),
      endpointAccess: eks.EndpointAccess.PUBLIC_AND_PRIVATE,
    });

    // Managed node group
    cluster.addNodegroupCapacity("DefaultNodeGroup", {
      instanceTypes: [new ec2.InstanceType("t3.medium")],
      minSize: 2,
      maxSize: 5,
      desiredSize: 2,
      diskSize: 20,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    // AWS Load Balancer Controller - IRSA service account
    const lbControllerSa = cluster.addServiceAccount("AwsLbController", {
      name: "aws-load-balancer-controller",
      namespace: "kube-system",
    });

    const lbControllerPolicyStatements = [
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "iam:CreateServiceLinkedRole",
          "ec2:DescribeAccountAttributes",
          "ec2:DescribeAddresses",
          "ec2:DescribeAvailabilityZones",
          "ec2:DescribeInternetGateways",
          "ec2:DescribeVpcs",
          "ec2:DescribeVpcPeeringConnections",
          "ec2:DescribeSubnets",
          "ec2:DescribeSecurityGroups",
          "ec2:DescribeInstances",
          "ec2:DescribeNetworkInterfaces",
          "ec2:DescribeTags",
          "ec2:DescribeCoipPools",
          "ec2:GetCoipPoolUsage",
          "ec2:DescribeNatGateways",
          "elasticloadbalancing:*",
          "ec2:CreateSecurityGroup",
          "ec2:AuthorizeSecurityGroupIngress",
          "ec2:RevokeSecurityGroupIngress",
          "ec2:DeleteSecurityGroup",
          "ec2:CreateTags",
          "ec2:DeleteTags",
          "cognito-idp:DescribeUserPoolClient",
          "acm:ListCertificates",
          "acm:DescribeCertificate",
          "iam:ListServerCertificates",
          "iam:GetServerCertificate",
          "waf-regional:*",
          "wafv2:*",
          "shield:*",
          "tag:GetResources",
          "tag:TagResources",
        ],
        resources: ["*"],
      }),
    ];

    lbControllerPolicyStatements.forEach((statement) => {
      lbControllerSa.addToPrincipalPolicy(statement);
    });

    // Install AWS Load Balancer Controller via Helm
    cluster.addHelmChart("AwsLoadBalancerController", {
      chart: "aws-load-balancer-controller",
      repository: "https://aws.github.io/eks-charts",
      namespace: "kube-system",
      release: "aws-load-balancer-controller",
      values: {
        clusterName: cluster.clusterName,
        serviceAccount: {
          create: false,
          name: "aws-load-balancer-controller",
        },
        region: this.region,
        vpcId: vpc.vpcId,
      },
    });

    // Create namespaces for each environment
    const namespaces = ["dev", "staging", "prod"];
    for (const ns of namespaces) {
      cluster.addManifest(`Namespace-${ns}`, {
        apiVersion: "v1",
        kind: "Namespace",
        metadata: { name: ns },
      });
    }

    // Outputs
    new cdk.CfnOutput(this, "ClusterName", {
      value: cluster.clusterName,
      description: "EKS cluster name",
    });

    new cdk.CfnOutput(this, "EcrRepoUri", {
      value: ecrRepo.repositoryUri,
      description: "ECR repository URI",
    });

    new cdk.CfnOutput(this, "KubeconfigCommand", {
      value: `aws eks update-kubeconfig --name ${cluster.clusterName} --region ${this.region}`,
      description: "Command to configure kubectl",
    });

    new cdk.CfnOutput(this, "VpcId", {
      value: vpc.vpcId,
      description: "VPC ID",
    });
  }
}
