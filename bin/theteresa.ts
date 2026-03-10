#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { TheTeresaStack } from '../lib/theteresa-stack';

const app = new cdk.App();

new TheTeresaStack(app, 'TheTeresaStack', {
  env: {
    account: '495133941005',
    region: 'eu-south-1',
  },
});
