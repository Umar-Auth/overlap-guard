import 'dotenv/config';

import { app } from './src/clients';
import { config } from './src/config';
import { registerActivityRoutes } from './src/routes/activity';
import { registerAutoReply } from './src/slack/autoReply';
import { registerWhoWorkingCommand } from './src/slack/whoWorking';

registerActivityRoutes();
registerAutoReply();
registerWhoWorkingCommand();

app.start(config.port).then(() => {
  console.log(`🤖 Overlap Guard ready on port ${config.port} (Slack bot + Activity API)`);
  console.log(`🤖 Auto-reply is ${config.autoReplyEnabled ? 'enabled' : 'disabled'}`);
});
