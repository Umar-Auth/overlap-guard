import type { WebClient } from '@slack/web-api';

import { app, userClient } from '../clients';

const USER_NAME_CACHE = new Map<string, string>();
const MAX_CONTEXT_MESSAGES = 200;

function normalizeContextText(text?: string | null) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

function formatSlackTime(ts?: string) {
  if (!ts) {
    return '';
  }

  const [seconds] = ts.split('.');
  const millis = Number(seconds) * 1000;
  if (!Number.isFinite(millis)) {
    return '';
  }

  const date = new Date(millis);
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  });
}

async function resolveUserName(userId: string) {
  if (USER_NAME_CACHE.has(userId)) {
    return USER_NAME_CACHE.get(userId)!;
  }

  try {
    const result = await app.client.users.info({ user: userId });
    const profile = result.user?.profile;
    const name = profile?.display_name || profile?.real_name || result.user?.name || userId;
    USER_NAME_CACHE.set(userId, name);
    return name;
  } catch {
    USER_NAME_CACHE.set(userId, userId);
    return userId;
  }
}

async function fetchAllThreadMessages(client: WebClient, channel: string, threadTs: string) {
  const messages: any[] = [];
  let cursor: string | undefined;

  while (messages.length < MAX_CONTEXT_MESSAGES) {
    const result = await client.conversations.replies({
      channel,
      ts: threadTs,
      limit: 200,
      cursor,
      inclusive: true,
    });

    messages.push(...(result.messages || []));

    cursor = result.response_metadata?.next_cursor || undefined;
    if (!cursor) {
      break;
    }
  }

  return messages;
}

async function loadThreadMessages(channel: string, threadTs: string) {
  const clients = [app.client, userClient].filter(Boolean) as WebClient[];
  let lastError: Error | null = null;

  for (const client of clients) {
    try {
      const messages = await fetchAllThreadMessages(client, channel, threadTs);
      if (messages.length > 0) {
        return messages;
      }
    } catch (err: any) {
      lastError = err;
    }
  }

  if (lastError) {
    throw lastError;
  }

  return [];
}

async function formatMessage(message: any) {
  const text = normalizeContextText(message?.text);
  if (!text) {
    return '';
  }

  const speaker = message.user
    ? await resolveUserName(message.user)
    : message.bot_profile?.name || message.username || 'Slack';
  const time = formatSlackTime(message.ts);

  return `${time ? `[${time}] ` : ''}${speaker}: ${text}`;
}

export async function getThreadContext(channel: string, threadTs: string, currentMessageTs?: string) {
  try {
    const messages = await loadThreadMessages(channel, threadTs);

    const formatted = await Promise.all(
      messages
        .filter(message => message?.text)
        .filter(message => !currentMessageTs || message.ts !== currentMessageTs)
        .map(formatMessage)
    );

    return formatted.filter(Boolean).join('\n');
  } catch (err: any) {
    console.error('Slack thread context error:', err.message);
    return '';
  }
}
