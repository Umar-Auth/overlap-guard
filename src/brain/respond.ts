import { config } from '../config';
import { answerMyWorkStatusQuery } from '../integrations/myWork';
import { loadMemoryProfile } from '../memory/profile';
import type { ProjectRegistryEntry } from '../projects/registry';
import { generateText } from './openai';

function buildFallbackReply(senderName?: string) {
  const intro = senderName ? `Hi ${senderName}, ` : 'Hi, ';
  return `${intro}I saw your message. I'm away right now, but I'll follow up as soon as I'm back.`;
}

export async function buildQueryReply(params: {
  messageText: string;
  senderName: string;
  project?: ProjectRegistryEntry;
  threadContext?: string;
}) {
  const fallbackReply = buildFallbackReply(params.senderName);
  const workStatusReply = await answerMyWorkStatusQuery({
    messageText: params.messageText,
    threadContext: params.threadContext,
    project: params.project,
  });
  if (workStatusReply) {
    return workStatusReply;
  }

  if (!config.openAiApiKey) {
    return fallbackReply;
  }

  const memory = loadMemoryProfile();
  try {
    const reply = await generateText(
      config.openAiModel,
      [
        'You are Umar replying in Slack while temporarily away.',
        'Reply as Umar in first person.',
        'Keep it concise, natural, and helpful.',
        'Answer directly when possible.',
        'Do not ask format or scope clarifiers unless the request is genuinely ambiguous and cannot be answered from available context.',
        'For straightforward operational questions, give the answer rather than proposing documents, tickets, or options.',
        'Do not mention AI, automation, or a bot.',
        `ROLE CONTEXT:\n${memory.role}`,
        `SKILL CONTEXT:\n${memory.skill}`,
        `SOUL CONTEXT:\n${memory.soul}`,
      ].join('\n\n'),
      [
        `Sender: ${params.senderName}`,
        `Project: ${params.project ? `${params.project.name} - ${params.project.description}` : 'unknown'}`,
        `Thread context: ${params.threadContext || 'none'}`,
        `Message: ${params.messageText || '(no additional text provided)'}`,
      ].join('\n'),
    );

    return reply || fallbackReply;
  } catch (err: any) {
    console.error('Query reply generation error:', err.message);
    return fallbackReply;
  }
}
