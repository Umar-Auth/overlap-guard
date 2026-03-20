import { app } from '../clients';
import { getUsersForMatchingFile } from '../activity/state';
import { findGitHubPRs } from '../integrations/github';
import { findLinearIssues } from '../integrations/linear';
import { postToFileThread } from './threads';

export function registerWhoWorkingCommand() {
  app.command('/who-working', async ({ command, ack, respond }) => {
    await ack();

    const file = command.text?.trim();
    if (!file) {
      await respond({
        text: 'Please specify a file path. Usage: /who-working src/app.tsx',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '*Usage:* `/who-working src/app.tsx`\nSpecify a file path to check who is working on it.',
            },
          },
        ],
        response_type: 'ephemeral',
      });
      return;
    }

    await postToFileThread(file, {
      text: `Searching for activity on ${file}...`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `🔍 *Searching for activity on \`${file}\`...*\n\n⏳ Checking VS Code activity, GitHub PRs, and Linear tickets...`,
          },
        },
      ],
    });

    const [prs, issues] = await Promise.all([findGitHubPRs(file), findLinearIssues(file)]);
    const activeUsers = getUsersForMatchingFile(file);

    const sections: any[] = [
      {
        type: 'header',
        text: { type: 'plain_text', text: `Who's working on: ${file}` },
      },
      activeUsers.length > 0
        ? {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*🟢 Active Right Now (VS Code):*\n${activeUsers.map(user => `• *${user}*`).join('\n')}`,
            },
          }
        : {
            type: 'section',
            text: { type: 'mrkdwn', text: '*🟢 Active Right Now (VS Code):* No one' },
          },
      { type: 'divider' },
    ];

    if (prs.length > 0) {
      sections.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*GitHub PRs (${prs.length}):*\n${prs
            .map((pr: any) => `• <${pr.url}|${pr.title}> by *${pr.author?.login || 'unknown'}*`)
            .join('\n')}`,
        },
      });
    } else {
      sections.push({
        type: 'section',
        text: { type: 'mrkdwn', text: '*GitHub PRs:* None found' },
      });
    }

    sections.push({ type: 'divider' });

    if (issues.length > 0) {
      const issueLines = await Promise.all(
        issues.map(async issue => {
          const assignee = issue.assignee ? await issue.assignee : null;
          const assigneeName = assignee?.name || 'unassigned';
          return `• ${issue.identifier}: ${issue.title} — *${assigneeName}*`;
        })
      );

      sections.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*Linear Tickets (${issues.length}):*\n${issueLines.join('\n')}` },
      });
    } else {
      sections.push({
        type: 'section',
        text: { type: 'mrkdwn', text: '*Linear Tickets:* None found' },
      });
    }

    const total = prs.length + issues.length + activeUsers.length;
    const summary = total > 0 ? `⚠️ ${total} active work item(s) found on this file!` : '✅ No one is currently working on this file.';

    sections.push({ type: 'divider' });
    sections.push({
      type: 'section',
      text: { type: 'mrkdwn', text: summary },
    });

    await postToFileThread(file, {
      text: `${summary} (${activeUsers.length} active, ${prs.length} PRs, ${issues.length} Linear tickets)`,
      blocks: sections,
    });
  });
}
