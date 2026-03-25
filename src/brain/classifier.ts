import { config } from '../config';
import { generateJson } from './openai';
import type { ProjectRegistryEntry } from '../projects/registry';

export type MessageRoute = 'query' | 'ticket_only_task' | 'code_change_task';

export interface MessageClassification {
  route: MessageRoute;
  type: 'query' | 'task';
  confidence: 'low' | 'medium' | 'high';
  summary: string;
  needsClarification: boolean;
  projectHint?: string;
}

function summarize(messageText: string) {
  return messageText.trim().slice(0, 140);
}

function normalize(text: string) {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function matchesAny(text: string, patterns: RegExp[]) {
  return patterns.some(pattern => pattern.test(text));
}

function buildClassification(
  route: MessageRoute,
  confidence: MessageClassification['confidence'],
  messageText: string,
  project?: ProjectRegistryEntry
): MessageClassification {
  return {
    route,
    type: route === 'query' ? 'query' : 'task',
    confidence,
    summary: summarize(messageText),
    needsClarification: false,
    projectHint: project?.id,
  };
}

function heuristicClassify(messageText: string, project?: ProjectRegistryEntry, threadContext?: string): MessageClassification {
  const text = normalize([threadContext, messageText].filter(Boolean).join(' '));

  const workStatusPatterns = [
    /what .* working on/,
    /on what .* working on/,
    /what task.* working on/,
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
    /get .* prs?/,
    /pull .* tickets?/,
    /pull .* prs?/,
    /give me .* details/,
    /status .* tasks?/,
    /status .* tickets?/,
    /status .* issues?/,
    /status .* prs?/,
    /current work/,
    /current tasks?/,
    /current prs?/,
    /current issues?/,
    /\bme\b/,
    /\bmy work\b/,
    /\bmy tasks\b/,
    /\bmy tickets\b/,
    /\bmy issues\b/,
    /\bmy prs?\b/,
  ];

  const codeChangePatterns = [
    /\bfix\b/,
    /\bimplement\b/,
    /\bbuild\b/,
    /\bupdate\b/,
    /\bchange\b/,
    /\bresolve\b/,
    /\brefactor\b/,
    /\badd\b/,
    /\bpatch\b/,
    /\bdebug\b/,
    /\bship\b/,
    /\bmake (?:a )?pr\b/,
    /\bopen (?:a )?pr\b/,
    /\bcreate (?:a )?pr\b/,
    /\bsend (?:a )?pr\b/,
  ];

  const ticketOnlyPatterns = [
    /\bcreate (?:a )?(?:linear )?(?:task|ticket|issue)\b/,
    /\bopen (?:a )?(?:linear )?(?:task|ticket|issue)\b/,
    /\blog this\b/,
    /\blog it\b/,
    /\braise (?:a )?(?:linear )?(?:task|ticket|issue)\b/,
    /\bmake (?:a )?(?:linear )?(?:task|ticket|issue)\b/,
    /\btrack this\b/,
    /\bput this in linear\b/,
  ];

  const queryWords = [
    /\bwhat\b/,
    /\bwhy\b/,
    /\bhow\b/,
    /\bwhich\b/,
    /\bwhen\b/,
    /\bwhere\b/,
    /\bcan you explain\b/,
  ];

  if (matchesAny(text, workStatusPatterns)) {
    return buildClassification('query', 'high', messageText, project);
  }

  const looksLikeCodeChange = matchesAny(text, codeChangePatterns);
  const looksLikeTicketOnly = matchesAny(text, ticketOnlyPatterns);

  if (looksLikeCodeChange) {
    return buildClassification('code_change_task', 'medium', messageText, project);
  }

  if (looksLikeTicketOnly) {
    return buildClassification('ticket_only_task', 'medium', messageText, project);
  }

  if (matchesAny(text, queryWords)) {
    return buildClassification('query', 'medium', messageText, project);
  }

  return buildClassification('ticket_only_task', 'low', messageText, project);
}

export async function classifyMessage(messageText: string, project?: ProjectRegistryEntry, threadContext?: string) {
  if (!config.openAiApiKey) {
    return heuristicClassify(messageText, project, threadContext);
  }

  try {
    const result = await generateJson<Partial<MessageClassification> & { route?: string }>(
      config.openAiClassifierModel,
      [
        'You classify Slack messages for Umar\'s delegate.',
        'Return strict JSON only.',
        'Choose exactly one route: "query", "ticket_only_task", or "code_change_task".',
        'Queries ask for explanation, status, guidance, or information.',
        'Requests to fetch, list, show, pull, or get current tickets, issues, PRs, or work status are queries, not tasks.',
        'Very short follow-ups like "me", "mine", "my work", or "my tickets" should inherit the thread context.',
        'Ticket-only tasks ask to create, log, track, or open a Linear task or issue without asking for implementation.',
        'Code-change tasks explicitly ask for implementation work such as fix, implement, add, update, change, refactor, resolve, or create a PR.',
        'If the message asks for both creating a ticket and implementing the fix, choose "code_change_task".',
        'Never ask the sender to classify the request.',
      ].join(' '),
      [
        `Project context: ${project ? `${project.name} - ${project.description}` : 'unknown'}`,
        `Thread context: ${threadContext || 'none'}`,
        `Message: ${messageText}`,
        'Return JSON with keys: route, confidence, summary, needsClarification, projectHint.',
      ].join('\n')
    );

    const route = result?.route;
    if (route === 'query' || route === 'ticket_only_task' || route === 'code_change_task') {
      return {
        route,
        type: route === 'query' ? 'query' : 'task',
        confidence:
          result.confidence === 'high' || result.confidence === 'medium' || result.confidence === 'low'
            ? result.confidence
            : 'medium',
        summary: typeof result.summary === 'string' && result.summary.trim() ? result.summary.trim() : summarize(messageText),
        needsClarification: Boolean(result.needsClarification),
        projectHint: typeof result.projectHint === 'string' ? result.projectHint : project?.id,
      } satisfies MessageClassification;
    }
  } catch (err: any) {
    console.error('Message classification error:', err.message);
  }

  return heuristicClassify(messageText, project, threadContext);
}
