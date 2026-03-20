export const config = {
  slackSigningSecret: process.env.SLACK_SIGNING_SECRET!,
  slackBotToken: process.env.SLACK_BOT_TOKEN!,
  slackUserToken: process.env.SLACK_USER_TOKEN,
  slackChannel: process.env.SLACK_CHANNEL || 'general',
  myUserId: process.env.SLACK_MY_USER_ID,
  teamId: process.env.SLACK_TEAM_ID,
  githubToken: process.env.GITHUB_TOKEN!,
  linearApiKey: process.env.LINEAR_API_KEY!,
  repoOwner: process.env.REPO_OWNER!,
  repoName: process.env.REPO_NAME!,
  port: process.env.PORT || 3000,
  staleMinutes: 30,
  autoReplyEnabled: process.env.SLACK_AUTO_REPLY_ENABLED !== 'false',
  allowSelfTest: process.env.SLACK_ALLOW_SELF_TEST === 'true',
  debugAutoReply: process.env.SLACK_DEBUG_AUTO_REPLY === 'true',
  autoCreateLinearTasks: process.env.AUTO_CREATE_LINEAR_TASKS === 'true',
  autoReplyKeywords: (process.env.SLACK_UNAVAILABLE_STATUSES || 'away,lunch,offline,travel,ooo,vacation')
    .split(',')
    .map(keyword => keyword.trim().toLowerCase())
    .filter(Boolean),
  openAiApiKey: process.env.OPENAI_API_KEY,
  openAiModel: process.env.OPENAI_MODEL || 'gpt-5-mini',
  openAiClassifierModel: process.env.OPENAI_CLASSIFIER_MODEL || process.env.OPENAI_MODEL || 'gpt-5-mini',
  openAiTaskModel: process.env.OPENAI_TASK_MODEL || process.env.OPENAI_MODEL || 'gpt-5-mini',
  googleApiKey: process.env.GOOGLE_API_KEY,
  googleImageModel: process.env.GOOGLE_IMAGE_MODEL || 'gemini-3.1-flash-image-preview',
  linearDefaultTeamId: process.env.LINEAR_DEFAULT_TEAM_ID,
};
