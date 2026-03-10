import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as pipelines from 'aws-cdk-lib/pipelines';
import { Construct } from 'constructs';

const DOMAIN = 'theteresa.com';
const WWW_DOMAIN = `www.${DOMAIN}`;
const BUCKET_NAME = 'the-teresa-bucket';
const CODESTAR_CONNECTION_ARN =
  'arn:aws:codeconnections:eu-south-1:495133941005:connection/573b5341-5aa0-4a20-9294-87752d831c1a';

export class TheTeresaStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // --- Route53 Hosted Zone (lookup existing) ---
    const hostedZone = route53.HostedZone.fromLookup(this, 'Zone', {
      domainName: DOMAIN,
    });

    // --- ACM Certificate in us-east-1 (required for CloudFront) ---
    const certificate = new acm.DnsValidatedCertificate(this, 'Certificate', {
      domainName: DOMAIN,
      subjectAlternativeNames: [WWW_DOMAIN],
      hostedZone,
      region: 'us-east-1',
    });

    // --- S3 Bucket ---
    const bucket = new s3.Bucket(this, 'SiteBucket', {
      bucketName: BUCKET_NAME,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // --- CloudFront Distribution with OAC ---
    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      domainNames: [DOMAIN, WWW_DOMAIN],
      certificate,
      defaultRootObject: 'index.html',
      errorResponses: [
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.minutes(5),
        },
      ],
    });

    // --- Route53 Records ---
    // A record for apex
    new route53.ARecord(this, 'AliasRecord', {
      zone: hostedZone,
      target: route53.RecordTarget.fromAlias(
        new targets.CloudFrontTarget(distribution)
      ),
    });

    // AAAA record for apex
    new route53.AaaaRecord(this, 'AliasAAAARecord', {
      zone: hostedZone,
      target: route53.RecordTarget.fromAlias(
        new targets.CloudFrontTarget(distribution)
      ),
    });

    // A record for www
    new route53.ARecord(this, 'WwwAliasRecord', {
      zone: hostedZone,
      recordName: 'www',
      target: route53.RecordTarget.fromAlias(
        new targets.CloudFrontTarget(distribution)
      ),
    });

    // AAAA record for www
    new route53.AaaaRecord(this, 'WwwAliasAAAARecord', {
      zone: hostedZone,
      recordName: 'www',
      target: route53.RecordTarget.fromAlias(
        new targets.CloudFrontTarget(distribution)
      ),
    });

    // --- CodePipeline (self-mutating CDK Pipeline) ---
    const pipeline = new pipelines.CodePipeline(this, 'Pipeline', {
      pipelineName: 'TheTeresaPipeline',
      synth: new pipelines.ShellStep('Synth', {
        input: pipelines.CodePipelineSource.connection('hpfs74/theteresacom', 'main', {
          connectionArn: CODESTAR_CONNECTION_ARN,
        }),
        commands: [
          'npm ci',
          'npx cdk synth',
        ],
      }),
      selfMutation: true,
    });

    // Deploy step: sync to S3 + invalidate CloudFront
    const deployStep = new pipelines.CodeBuildStep('DeploySite', {
      commands: [
        `aws s3 sync web/ s3://${BUCKET_NAME}/ --delete`,
        `aws cloudfront create-invalidation --distribution-id ${distribution.distributionId} --paths "/*"`,
      ],
      rolePolicyStatements: [
        new iam.PolicyStatement({
          actions: ['s3:PutObject', 's3:DeleteObject', 's3:ListBucket', 's3:GetObject'],
          resources: [bucket.bucketArn, `${bucket.bucketArn}/*`],
        }),
        new iam.PolicyStatement({
          actions: ['cloudfront:CreateInvalidation'],
          resources: [
            `arn:aws:cloudfront::495133941005:distribution/${distribution.distributionId}`,
          ],
        }),
      ],
    });

    pipeline.addWave('Deploy', {
      post: [deployStep],
    });

    // Build pipeline so we can patch the underlying CfnPipeline
    pipeline.buildPipeline();

    // Patch to V2 + SUPERSEDED execution mode
    const cfnPipeline = pipeline.pipeline.node.defaultChild as cdk.CfnResource;
    cfnPipeline.addPropertyOverride('PipelineType', 'V2');
    cfnPipeline.addPropertyOverride('ExecutionMode', 'SUPERSEDED');

    // Add push trigger for CodeStar connection
    cfnPipeline.addPropertyOverride('Triggers', [
      {
        ProviderType: 'CodeStarSourceConnection',
        GitConfiguration: {
          SourceActionName: 'hpfs74_theteresacom',
          Push: [
            {
              Branches: {
                Includes: ['main'],
              },
            },
          ],
        },
      },
    ]);

    // --- Outputs ---
    new cdk.CfnOutput(this, 'DistributionId', {
      value: distribution.distributionId,
    });

    new cdk.CfnOutput(this, 'BucketName', {
      value: bucket.bucketName,
    });

    new cdk.CfnOutput(this, 'SiteUrl', {
      value: `https://${DOMAIN}`,
    });
  }
}
