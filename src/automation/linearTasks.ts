import { linear } from '../clients';
import { config } from '../config';
import type { MessageClassification } from '../brain/classifier';
import type { ProjectRegistryEntry } from '../projects/registry';
import { getLinearCurrentUser } from '../integrations/identity';

let cachedTeamId: string | null = null;

async function resolveLinearTeamId(project?: ProjectRegistryEntry) {
  if (project?.linearTeamId) {
    return project.linearTeamId;
  }

  if (config.linearDefaultTeamId) {
    return config.linearDefaultTeamId;
  }

  if (cachedTeamId) {
    return cachedTeamId;
  }

  const teams = await linear.teams();
  if (teams.nodes.length === 1) {
    cachedTeamId = teams.nodes[0].id;
    return cachedTeamId;
  }

  return null;
}

export async function createLinearTaskFromSlack(params: {
  messageText: string;
  senderName: string;
  channelId: string;
  slackTs: string;
  classification: MessageClassification;
  project?: ProjectRegistryEntry;
}) {
  if (!config.autoCreateLinearTasks) {
    return null;
  }

  try {
    const teamId = await resolveLinearTeamId(params.project);
    if (!teamId) {
      return null;
    }

    const payload = await linear.createIssue({
      teamId,
      title: params.classification.summary || 'Slack task',
      description: [
        `Slack sender: ${params.senderName}`,
        `Slack channel: ${params.channelId}`,
        `Slack ts: ${params.slackTs}`,
        params.project ? `Resolved project: ${params.project.name}` : 'Resolved project: unknown',
        '',
        'Original request:',
        params.messageText,
      ].join('\n'),
      assigneeId: (await getLinearCurrentUser())?.id,
      ...(params.project?.linearProjectId ? { projectId: params.project.linearProjectId } : {}),
    });

    const issue = await payload.issue;
    if (!issue) {
      return null;
    }

    return {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      url: issue.url,
    };
  } catch (err: any) {
    console.error('Linear task creation error:', err.message);
    return null;
  }
}
