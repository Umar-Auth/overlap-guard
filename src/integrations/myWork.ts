import { gh, linear } from '../clients';
import type { ProjectRegistryEntry } from '../projects/registry';
import { loadProjectRegistry } from '../projects/registry';
import { getGitHubViewer, getLinearCurrentUser } from './identity';

interface LinearWorkItem {
  identifier: string;
  title: string;
  status: string;
  url: string;
}

interface PullRequestWorkItem {
  number: number;
  title: string;
  url: string;
  branch: string;
  baseBranch: string;
  updatedAt: string;
  repository: string;
}

function normalize(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function looksLikeWorkStatusRequest(text: string) {
  const normalized = normalize(text);
  const patterns = [
    /what .* working on/,
    /on what .* working on/,
    /on what .* working/,
    /what task.* working on/,
    /on what task.* working on/,
    /on what task.* working/,
    /which task.* working on/,
    /what prs?.* working on/,
    /what issues?.* working on/,
    /what .* doing/,
    /what .* assigned/,
    /show .* task/,
    /show .* tickets?/,
    /show .* prs?/,
    /show .* issues?/,
    /fetch .* tickets?/,
    /fetch .* issues?/,
    /fetch .* prs?/,
    /list .* tickets?/,
    /list .* issues?/,
    /list .* prs?/,
    /get .* tickets?/,
    /get .* issues?/,
    /pull .* tickets?/,
    /give me .* details/,
    /status .* tasks?/,
    /status .* tickets?/,
    /status .* issues?/,
    /status .* prs?/,
    /current work/,
    /current tasks?/,
    /current prs?/,
    /current issues?/,
  ];

  return patterns.some(pattern => pattern.test(normalized));
}

function isShortSelfFollowup(text: string) {
  const normalized = normalize(text);
  return ['me', 'mine', 'my work', 'my tasks', 'my tickets', 'my issues', 'my prs', 'my pr', 'all details'].includes(normalized);
}

function referencesSomeoneElse(text: string) {
  const normalized = normalize(text);
  const thirdPartyPatterns = [
    /\bahmad\b/,
    /\bhammad\b/,
    /\bhussain\b/,
    /\bhe\b/,
    /\bshe\b/,
    /\bthey\b/,
    /\bsomeone else\b/,
    /\bother person\b/,
    /\banother person\b/,
  ];

  return thirdPartyPatterns.some(pattern => pattern.test(normalized));
}

function isSelfFocused(messageText: string, threadContext?: string) {
  const normalizedMessage = normalize(messageText);
  const normalizedThread = normalize(threadContext || '');
  const combined = [normalizedThread, normalizedMessage].filter(Boolean).join(' ');

  if (['umar', 'you', 'your', 'yours', 'yourself', 'me', 'mine', 'my'].some(token => new RegExp(`\\b${token}\\b`).test(combined))) {
    return true;
  }

  if (isShortSelfFollowup(normalizedMessage) && looksLikeWorkStatusRequest(normalizedThread)) {
    return true;
  }

  if (looksLikeWorkStatusRequest(combined) && !referencesSomeoneElse(combined)) {
    return true;
  }

  return false;
}

function wantsDetailedView(text: string) {
  const normalized = normalize(text);
  return ['all details', 'full details', 'everything', 'full overview', 'complete details'].some(token =>
    normalized.includes(token)
  );
}

function listRelevantRepos(project?: ProjectRegistryEntry) {
  const registry = project ? [project] : loadProjectRegistry();
  const deduped = new Map<string, { owner: string; repo: string }>();

  for (const entry of registry) {
    const owner = entry.repoOwner;
    const repo = entry.repoName;
    if (!owner || !repo) {
      continue;
    }

    deduped.set(`${owner}/${repo}`, { owner, repo });
  }

  return [...deduped.values()];
}

function buildProjectTokens(project?: ProjectRegistryEntry) {
  if (!project) {
    return [];
  }

  return [
    project.id,
    project.name,
    project.repoOwner,
    project.repoName,
    ...(project.keywords || []),
  ]
    .filter(Boolean)
    .map(value => normalize(value as string))
    .filter(Boolean);
}

async function listMyLinearIssues(project?: ProjectRegistryEntry) {
  const me = await getLinearCurrentUser();
  const issues = await linear.issues({
    filter: {
      assignee: { id: { eq: me.id } },
      state: { type: { in: ['started', 'unstarted'] } },
      ...(project?.linearProjectId ? { project: { id: { eq: project.linearProjectId } } } : {}),
    },
  });

  const summaries = await Promise.all(
    issues.nodes.map(async issue => {
      const state = issue.state ? await issue.state : null;
      return {
        identifier: issue.identifier,
        title: issue.title,
        status: state?.name || 'Unknown',
        url: issue.url,
      } satisfies LinearWorkItem;
    })
  );

  if (!project || project.linearProjectId) {
    return summaries;
  }

  const projectTokens = buildProjectTokens(project);
  const filtered = summaries.filter(issue => {
    const haystack = normalize(`${issue.identifier} ${issue.title} ${issue.url}`);
    return projectTokens.some(token => haystack.includes(token));
  });

  return filtered.length > 0 ? filtered : summaries;
}

async function listMyPullRequests(project?: ProjectRegistryEntry) {
  const viewer = await getGitHubViewer();
  const repos = listRelevantRepos(project);
  const results: PullRequestWorkItem[] = [];

  await Promise.all(
    repos.map(async ({ owner, repo }) => {
      try {
        const response = await gh<any>(
          `
          query ($owner: String!, $repo: String!, $first: Int!) {
            repository(owner: $owner, name: $repo) {
              nameWithOwner
              pullRequests(states: OPEN, first: $first, orderBy: { field: UPDATED_AT, direction: DESC }) {
                nodes {
                  number
                  title
                  url
                  updatedAt
                  headRefName
                  baseRefName
                  author { login }
                }
              }
            }
          }
        `,
          { owner, repo, first: 20 }
        );

        for (const pr of response.repository?.pullRequests?.nodes || []) {
          if (pr.author?.login !== viewer.login) {
            continue;
          }

          results.push({
            number: pr.number,
            title: pr.title,
            url: pr.url,
            branch: pr.headRefName,
            baseBranch: pr.baseRefName,
            updatedAt: pr.updatedAt,
            repository: response.repository?.nameWithOwner || `${owner}/${repo}`,
          });
        }
      } catch (err: any) {
        console.error(`GitHub work query error for ${owner}/${repo}:`, err.message);
      }
    })
  );

  return results.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

function formatPullRequest(pr: PullRequestWorkItem, detailed: boolean) {
  return detailed
    ? `• *#${pr.number}* — ${pr.title} _(${pr.repository}, ${pr.branch} -> ${pr.baseBranch})_ ${pr.url}`
    : `• *#${pr.number}* — ${pr.title} ${pr.url}`;
}

export async function getMyWorkSnapshot(project?: ProjectRegistryEntry) {
  const [linearIssues, pullRequests, linearMe, githubMe] = await Promise.all([
    listMyLinearIssues(project),
    listMyPullRequests(project),
    getLinearCurrentUser(),
    getGitHubViewer(),
  ]);

  return {
    linearIssues,
    pullRequests,
    linearMe,
    githubMe,
  };
}

export async function answerMyWorkStatusQuery(params: {
  messageText: string;
  threadContext?: string;
  project?: ProjectRegistryEntry;
}) {
  const combinedText = [params.threadContext, params.messageText].filter(Boolean).join('\n');
  if (!looksLikeWorkStatusRequest(combinedText)) {
    return null;
  }

  if (!isSelfFocused(params.messageText, params.threadContext)) {
    return 'I can only speak to what Umar is currently handling, not what someone else is working on.';
  }

  try {
    const detailed = wantsDetailedView(combinedText);
    const snapshot = await getMyWorkSnapshot(params.project);
    const linearHeading = params.project ? `Linear tasks for ${params.project.name}` : 'Linear tasks';
    const prHeading = params.project ? `GitHub PRs for ${params.project.name}` : 'GitHub PRs';

    const lines = [`Here’s what I’m currently handling${params.project ? ` for *${params.project.name}*` : ''}:`];

    if (snapshot.linearIssues.length > 0) {
      lines.push(`*${linearHeading}*`);
      lines.push(...snapshot.linearIssues.map(issue => `• *${issue.identifier}* — ${issue.title} _(${issue.status})_ ${issue.url}`));
    } else {
      lines.push(`*${linearHeading}*`);
      lines.push('• No active Linear issues right now.');
    }

    if (snapshot.pullRequests.length > 0) {
      lines.push('');
      lines.push(`*${prHeading}*`);
      lines.push(...snapshot.pullRequests.map(pr => formatPullRequest(pr, detailed)));
    } else {
      lines.push('');
      lines.push(`*${prHeading}*`);
      lines.push('• No open PRs right now.');
    }

    if (detailed) {
      lines.push('');
      lines.push(`Linear identity: ${snapshot.linearMe.displayName || snapshot.linearMe.name || 'Umar'}`);
      lines.push(`GitHub identity: ${snapshot.githubMe.login}`);
    }

    return lines.join('\n');
  } catch (err: any) {
    console.error('My work status query error:', err.message);
    return null;
  }
}
