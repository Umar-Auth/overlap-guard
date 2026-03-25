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

  console.error('Linear task creation error: could not resolve team automatically', {
    availableTeams: teams.nodes.map(team => ({
      id: team.id,
      name: team.name,
      key: team.key,
    })),
    resolvedProject: project?.name || null,
  });
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
      console.error('Linear task creation error: missing team id', {
        project: params.project?.name || null,
        linearProjectId: params.project?.linearProjectId || null,
      });
      return null;
    }

    const assignee = await getLinearCurrentUser();

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
      assigneeId: assignee?.id,
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
    console.error('Linear task creation error:', {
      message: err.message,
      stack: err.stack,
      project: params.project?.name || null,
      linearProjectId: params.project?.linearProjectId || null,
      summary: params.classification.summary,
    });
    return null;
  }
}
