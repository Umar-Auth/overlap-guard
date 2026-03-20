import { linear } from '../clients';
import type { ProjectRegistryEntry } from '../projects/registry';

interface AssignmentSummary {
  userName: string;
  issues: Array<{
    identifier: string;
    title: string;
    status: string;
    url: string;
  }>;
}

function normalize(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function looksLikeWorkStatusQuery(messageText: string) {
  const text = normalize(messageText);
  const patterns = [
    /what .* working on/,
    /what task.* working on/,
    /which task.* working on/,
    /what .* assigned/,
    /show .* task/,
    /show .* tickets?/,
    /tell me .* working on/,
    /give me .* details/,
  ];

  return patterns.some(pattern => pattern.test(text));
}

async function resolveUserFromQuery(messageText: string) {
  const users = await linear.users();
  const normalizedMessage = normalize(messageText);

  const candidates = users.nodes
    .map(user => {
      const names = [
        user.name || '',
        user.displayName || '',
        user.email || '',
      ].filter(Boolean);

      let score = 0;
      for (const name of names) {
        const normalizedName = normalize(name);
        if (!normalizedName) continue;

        if (normalizedMessage.includes(normalizedName)) {
          score = Math.max(score, normalizedName.split(' ').length + 3);
        } else {
          const parts = normalizedName.split(' ').filter(Boolean);
          const matchedParts = parts.filter(part => normalizedMessage.includes(part)).length;
          score = Math.max(score, matchedParts);
        }
      }

      return { user, score };
    })
    .filter(candidate => candidate.score > 0)
    .sort((a, b) => b.score - a.score);

  return candidates[0]?.user || null;
}

async function listActiveIssuesForUser(userId: string, project?: ProjectRegistryEntry) {
  const issues = await linear.issues({
    filter: {
      assignee: { id: { eq: userId } },
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
      };
    })
  );

  return summaries;
}

export async function answerWorkStatusQuery(messageText: string, project?: ProjectRegistryEntry) {
  if (!looksLikeWorkStatusQuery(messageText)) {
    return null;
  }

  try {
    const user = await resolveUserFromQuery(messageText);
    if (!user) {
      return null;
    }

    const issues = await listActiveIssuesForUser(user.id, project);
    const summary: AssignmentSummary = {
      userName: user.displayName || user.name || 'that person',
      issues,
    };

    if (summary.issues.length === 0) {
      return `I don’t see any active Linear issues assigned to *${summary.userName}* right now${project ? ` for *${project.name}*` : ''}.`;
    }

    return [
      `Here’s what *${summary.userName}* is currently assigned${project ? ` for *${project.name}*` : ''}:`,
      ...summary.issues.map(issue => `• *${issue.identifier}* — ${issue.title} _(${issue.status})_ ${issue.url}`),
    ].join('\n');
  } catch (err: any) {
    console.error('Linear work-status query error:', err.message);
    return null;
  }
}
