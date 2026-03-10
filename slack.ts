import 'dotenv/config';
import { App } from '@slack/bolt';
import { graphql } from '@octokit/graphql';
import { LinearClient } from '@linear/sdk';
import http from 'http';

const app = new App({
  token: process.env.SLACK_BOT_TOKEN!,
  signingSecret: process.env.SLACK_SIGNING_SECRET!,
});

const gh = graphql.defaults({
  headers: { authorization: `token ${process.env.GITHUB_TOKEN}` },
});

const linear = new LinearClient({
  apiKey: process.env.LINEAR_API_KEY!,
});

const owner = process.env.REPO_OWNER!;
const repo = process.env.REPO_NAME!;
const SLACK_CHANNEL = process.env.SLACK_CHANNEL || 'general';
const STALE_MINUTES = 30; // consider activity stale after 30 min

// ---- Real-time file activity tracker ----
interface FileActivity {
  user: string;
  file: string;
  timestamp: number;
}

// Map of file path -> Map of user -> activity
const activeFiles = new Map<string, Map<string, FileActivity>>();

function cleanStaleEntries() {
  const cutoff = Date.now() - STALE_MINUTES * 60 * 1000;
  for (const [file, users] of activeFiles) {
    for (const [user, activity] of users) {
      if (activity.timestamp < cutoff) {
        users.delete(user);
      }
    }
    if (users.size === 0) {
      activeFiles.delete(file);
    }
  }
}

function trackFile(user: string, file: string): string[] {
  cleanStaleEntries();

  if (!activeFiles.has(file)) {
    activeFiles.set(file, new Map());
  }

  const fileUsers = activeFiles.get(file)!;
  const otherUsers = [...fileUsers.keys()].filter(u => u !== user);

  fileUsers.set(user, { user, file, timestamp: Date.now() });

  return otherUsers;
}

// ---- HTTP server for VS Code extension ----
const apiServer = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // POST /activity - report file activity from VS Code
  if (req.method === 'POST' && req.url === '/activity') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { user, file } = JSON.parse(body);
        if (!user || !file) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'user and file required' }));
          return;
        }

        const overlaps = trackFile(user, file);

        // Alert Slack if overlap detected
        if (overlaps.length > 0) {
          const others = overlaps.join(', ');
          try {
            await app.client.chat.postMessage({
              channel: SLACK_CHANNEL,
              text: `⚠️ File overlap detected! ${user} is editing ${file}, which ${others} is also working on.`,
              blocks: [{
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: `⚠️ *File Overlap Detected!*\n\n*\`${file}\`* is being edited by multiple people:\n• *${user}* (just now)\n${overlaps.map(u => `• *${u}*`).join('\n')}\n\nCoordinate to avoid merge conflicts!`
                }
              }]
            });
          } catch (err: any) {
            console.error('Slack alert error:', err.message);
          }
        }

        res.writeHead(200);
        res.end(JSON.stringify({ overlaps }));
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'invalid JSON' }));
      }
    });
    return;
  }

  // GET /activity - get all current activity
  if (req.method === 'GET' && req.url === '/activity') {
    cleanStaleEntries();
    const activity: Record<string, string[]> = {};
    for (const [file, users] of activeFiles) {
      activity[file] = [...users.keys()];
    }
    res.writeHead(200);
    res.end(JSON.stringify(activity));
    return;
  }

  // POST /heartbeat - keep-alive from VS Code
  if (req.method === 'POST' && req.url === '/heartbeat') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { user, files } = JSON.parse(body);
        if (user && Array.isArray(files)) {
          for (const file of files) {
            trackFile(user, file);
          }
        }
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'invalid JSON' }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'not found' }));
});

// ---- GitHub PR checks ----
async function findGitHubPRs(filePath: string) {
  try {
    const { repository } = await gh<any>(`
      query ($owner: String!, $repo: String!, $first: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequests(states: OPEN, first: $first) {
            nodes {
              title
              url
              author { login }
              files(first: 100) {
                nodes { path }
              }
            }
          }
        }
      }
    `, { owner, repo, first: 50 });

    return repository.pullRequests.nodes.filter((pr: any) =>
      pr.files.nodes.some((f: any) =>
        f.path.includes(filePath) || filePath.includes(f.path)
      )
    );
  } catch (err: any) {
    console.error('GitHub error:', err.message);
    return [];
  }
}

// ---- Linear issue checks ----
async function findLinearIssues(filePath: string) {
  try {
    const issues = await linear.issues({
      filter: {
        state: { type: { in: ["started", "unstarted"] } },
      },
    });

    const fileName = filePath.split('/').pop() || filePath;

    return issues.nodes.filter((issue) => {
      const text = `${issue.title} ${issue.description || ''}`.toLowerCase();
      return text.includes(filePath.toLowerCase()) || text.includes(fileName.toLowerCase());
    });
  } catch (err: any) {
    console.error('Linear error:', err.message);
    return [];
  }
}

// ---- Slack commands ----
app.command('/who-working', async ({ command, ack, say }) => {
  await ack();

  const file = command.text?.trim();
  if (!file) {
    await say({
      text: 'Please specify a file path. Usage: /who-working src/app.tsx',
      blocks: [{
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*Usage:* `/who-working src/app.tsx`\nSpecify a file path to check who is working on it.'
        }
      }]
    });
    return;
  }

  // Show loading message
  await say({
    text: `Searching for activity on ${file}...`,
    blocks: [{
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `🔍 *Searching for activity on \`${file}\`...*\n\n⏳ Checking VS Code activity, GitHub PRs, and Linear tickets...`
      }
    }]
  });

  // Fetch all sources in parallel
  const [prs, issues] = await Promise.all([
    findGitHubPRs(file),
    findLinearIssues(file),
  ]);

  // Check real-time VS Code activity
  cleanStaleEntries();
  const vsCodeUsers: string[] = [];
  for (const [trackedFile, users] of activeFiles) {
    if (trackedFile.includes(file) || file.includes(trackedFile)) {
      vsCodeUsers.push(...users.keys());
    }
  }
  const uniqueVsCodeUsers = [...new Set(vsCodeUsers)];

  const sections: any[] = [];

  sections.push({
    type: 'header',
    text: { type: 'plain_text', text: `Who's working on: ${file}` }
  });

  // VS Code real-time activity
  if (uniqueVsCodeUsers.length > 0) {
    sections.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*🟢 Active Right Now (VS Code):*\n${uniqueVsCodeUsers.map(u => `• *${u}*`).join('\n')}`
      }
    });
  } else {
    sections.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '*🟢 Active Right Now (VS Code):* No one' }
    });
  }

  sections.push({ type: 'divider' });

  // GitHub PRs section
  if (prs.length > 0) {
    const prLines = prs.map((pr: any) =>
      `• <${pr.url}|${pr.title}> by *${pr.author?.login || 'unknown'}*`
    ).join('\n');
    sections.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*GitHub PRs (${prs.length}):*\n${prLines}` }
    });
  } else {
    sections.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '*GitHub PRs:* None found' }
    });
  }

  sections.push({ type: 'divider' });

  // Linear issues section
  if (issues.length > 0) {
    const issueLines = await Promise.all(issues.map(async (issue) => {
      const assignee = issue.assignee ? await issue.assignee : null;
      const name = assignee?.name || 'unassigned';
      return `• ${issue.identifier}: ${issue.title} — *${name}*`;
    }));
    sections.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Linear Tickets (${issues.length}):*\n${issueLines.join('\n')}` }
    });
  } else {
    sections.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '*Linear Tickets:* None found' }
    });
  }

  const total = prs.length + issues.length + uniqueVsCodeUsers.length;
  const summary = total > 0
    ? `⚠️ ${total} active work item(s) found on this file!`
    : '✅ No one is currently working on this file.';

  sections.push({ type: 'divider' });
  sections.push({
    type: 'section',
    text: { type: 'mrkdwn', text: summary }
  });

  await say({
    text: `${summary} (${uniqueVsCodeUsers.length} active, ${prs.length} PRs, ${issues.length} Linear tickets)`,
    blocks: sections,
  });
});

// ---- Start servers ----
const API_PORT = Number(process.env.API_PORT || 3001);

app.start(process.env.PORT || 3000).then(() => {
  console.log('🤖 Overlap Guard Slack bot ready on port 3000!');
});

apiServer.listen(API_PORT, () => {
  console.log(`📡 Activity API ready on port ${API_PORT}!`);
});
