import { App, ExpressReceiver } from '@slack/bolt';
import { WebClient } from '@slack/web-api';
import { graphql } from '@octokit/graphql';
import { LinearClient } from '@linear/sdk';

import { config } from './config';

export const receiver = new ExpressReceiver({
  signingSecret: config.slackSigningSecret,
});

export const app = new App({
  token: config.slackBotToken,
  receiver,
});

export const userClient = config.slackUserToken
  ? new WebClient(config.slackUserToken)
  : null;

export const gh = graphql.defaults({
  headers: { authorization: `token ${config.githubToken}` },
});

export const linear = new LinearClient({
  apiKey: config.linearApiKey,
});
