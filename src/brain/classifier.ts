import { config } from '../config';
import { generateJson } from './openai';
import type { ProjectRegistryEntry } from '../projects/registry';

export interface MessageClassification {
  type: 'query' | 'task';
  confidence: 'low' | 'medium' | 'high';
  summary: string;
  needsClarification: boolean;
  projectHint?: string;
  executionMode: 'none' | 'linear_ticket' | 'code_change';
}

function heuristicClassify(messageText: string, project?: ProjectRegistryEntry): MessageClassification {
  const text = messageText.toLowerCase();
  const taskWords = ['fix', 'implement', 'build', 'create', 'update', 'change', 'ship', 'deploy', 'bug', 'issue', 'ticket'];
  const queryWords = ['what', 'why', 'how', 'can you explain', 'which', 'when', 'where'];

  const looksTask = taskWords.some(word => text.includes(word));
  const looksQuery = queryWords.some(word => text.includes(word));

  if (looksTask && !looksQuery) {
    return {
      type: 'task',
      confidence: 'medium',
      summary: messageText.trim().slice(0, 140),
      needsClarification: false,
      projectHint: project?.id,
      executionMode: 'linear_ticket',
    };
  }

  return {
    type: 'query',
    confidence: 'medium',
    summary: messageText.trim().slice(0, 140),
    needsClarification: false,
    projectHint: project?.id,
    executionMode: 'none',
  };
}

export async function classifyMessage(messageText: string, project?: ProjectRegistryEntry) {
  if (!config.openAiApiKey) {
    return heuristicClassify(messageText, project);
  }

  try {
    const result = await generateJson<MessageClassification>(
      config.openAiClassifierModel,
      [
        'You classify Slack messages for Umar\'s delegate.',
        'Return strict JSON only.',
        'A query asks for explanation, status, guidance, or information.',
        'A task asks for work to be done, changed, implemented, fixed, created, or executed.',
        'Use executionMode="code_change" only when the user is explicitly asking for implementation work.',
      ].join(' '),
      `Project context: ${project ? `${project.name} - ${project.description}` : 'unknown'}\nMessage: ${messageText}\nReturn JSON with keys: type, confidence, summary, needsClarification, projectHint, executionMode.`
    );

    if (result?.type === 'query' || result?.type === 'task') {
      return {
        ...result,
        confidence:
          result.confidence === 'high' || result.confidence === 'medium' || result.confidence === 'low'
            ? result.confidence
            : 'medium',
        executionMode:
          result.executionMode === 'code_change' || result.executionMode === 'linear_ticket'
            ? result.executionMode
            : result.type === 'task'
              ? 'linear_ticket' as const
              : 'none' as const,
      } satisfies MessageClassification;
    }
  } catch (err: any) {
    console.error('Message classification error:', err.message);
  }

  return heuristicClassify(messageText, project);
}
