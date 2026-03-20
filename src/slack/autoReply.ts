import { app, userClient } from '../clients';
import { config } from '../config';

const RECENT_REPLY_WINDOW_MS = 5 * 60 * 1000;
const recentAutoReplies = new Map<string, number>();

function debugLog(message: string, details?: Record<string, unknown>) {
  if (!config.debugAutoReply) {
    return;
  }

  if (details) {
    console.log(`[auto-reply] ${message}`, details);
  } else {
    console.log(`[auto-reply] ${message}`);
  }
}

function pruneRecentAutoReplies() {
  const cutoff = Date.now() - RECENT_REPLY_WINDOW_MS;
  for (const [key, timestamp] of recentAutoReplies) {
    if (timestamp < cutoff) {
      recentAutoReplies.delete(key);
    }
  }
}

function alreadyReplied(channel: string, ts: string) {
  pruneRecentAutoReplies();
  return recentAutoReplies.has(`${channel}:${ts}`);
}

function markReplied(channel: string, ts: string) {
  pruneRecentAutoReplies();
  recentAutoReplies.set(`${channel}:${ts}`, Date.now());
}

function messageMentionsMe(text?: string) {
  return Boolean(text && config.myUserId && text.includes(`<@${config.myUserId}>`));
}

function cleanPromptText(text: string) {
  if (!config.myUserId) {
    return text.trim();
  }

  return text.replace(new RegExp(`<@${config.myUserId}>`, 'g'), '').replace(/\s+/g, ' ').trim();
}

function buildFallbackReply(senderName?: string) {
  const intro = senderName ? `Hi ${senderName}, ` : 'Hi, ';
  return `${intro}I saw your message. I'm away right now, but I'll follow up as soon as I'm back.`;
}

function extractResponseText(payload: any) {
  if (typeof payload?.output_text === 'string' && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  const parts = payload?.output
    ?.flatMap((item: any) => item?.content ?? [])
    ?.filter((item: any) => item?.type === 'output_text')
    ?.map((item: any) => item.text?.trim())
    ?.filter(Boolean);

  return parts?.join('\n\n') || '';
}

async function getSenderName(userId: string) {
  try {
    const result = await app.client.users.info({ user: userId });
    const profile = result.user?.profile;
    return profile?.display_name || profile?.real_name || result.user?.name || 'there';
  } catch (err: any) {
    console.error('Slack user lookup error:', err.message);
    return 'there';
  }
}

async function getAvailability() {
  if (!config.myUserId) {
    return { unavailable: false, reason: 'SLACK_MY_USER_ID missing' };
  }

  try {
    const [presenceResult, profileResult] = await Promise.all([
      app.client.users.getPresence({ user: config.myUserId }),
      app.client.users.profile.get({ user: config.myUserId }),
    ]);

    const presence = presenceResult.presence || 'unknown';
    const statusText = (profileResult.profile?.status_text || '').trim();
    const normalizedStatus = statusText.toLowerCase();
    const statusMatches = config.autoReplyKeywords.some(keyword => normalizedStatus.includes(keyword));
    const unavailable = presence === 'away' || statusMatches;

    return {
      unavailable,
      reason: unavailable
        ? presence === 'away'
          ? 'presence is away'
          : `status "${statusText}" matched away keywords`
        : 'presence is active',
    };
  } catch (err: any) {
    console.error('Slack availability check error:', err.message);
    return { unavailable: false, reason: 'availability check failed' };
  }
}

async function generateAutoReply(messageText: string, senderName: string) {
  const fallbackReply = buildFallbackReply(senderName);
  if (!config.openAiApiKey) {
    return fallbackReply;
  }

  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.openAiApiKey}`,
      },
      body: JSON.stringify({
        model: config.openAiModel,
        input: [
          {
            role: 'system',
            content: [
              {
                type: 'input_text',
                text:
                  'You are Umar replying in Slack while he is temporarily away. Reply as Umar in first person. Keep it short, helpful, natural, and specific to the message. If you are unsure, say you will follow up once back. Do not mention AI, automation, or a bot.',
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: `Sender: ${senderName}\nMessage: ${messageText || '(no additional text provided)'}`,
              },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI request failed with ${response.status}`);
    }

    const payload = await response.json();
    return extractResponseText(payload) || fallbackReply;
  } catch (err: any) {
    console.error('OpenAI auto-reply error:', err.message);
    return fallbackReply;
  }
}

async function replyAsMe(channel: string, threadTs: string, text: string) {
  if (!userClient) {
    throw new Error('SLACK_USER_TOKEN missing');
  }

  await userClient.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text,
  });
}

export function registerAutoReply() {
  app.event('message', async ({ event }) => {
    const message = event as any;
    debugLog('received message event', {
      user: message.user,
      channel: message.channel,
      channelType: message.channel_type,
      subtype: message.subtype,
      ts: message.ts,
      text: message.text,
    });

    if (!config.autoReplyEnabled || !config.myUserId || !userClient) {
      debugLog('skipping because auto-reply prerequisites are missing', {
        autoReplyEnabled: config.autoReplyEnabled,
        hasMyUserId: Boolean(config.myUserId),
        hasUserClient: Boolean(userClient),
      });
      return;
    }

    if (message.subtype || !message.user || !message.channel || !message.ts || !message.text) {
      debugLog('skipping because message payload is incomplete or subtype is not supported');
      return;
    }

    if (config.teamId && message.team && message.team !== config.teamId) {
      debugLog('skipping because team does not match', {
        eventTeam: message.team,
        configuredTeam: config.teamId,
      });
      return;
    }

    const isOwnMessage = message.user === config.myUserId;
    if (!config.allowSelfTest && isOwnMessage) {
      debugLog('skipping because message is from my own account and self-test is disabled');
      return;
    }

    if (alreadyReplied(message.channel, message.ts)) {
      debugLog('skipping because message was already auto-replied to recently');
      return;
    }

    const isMention = messageMentionsMe(message.text);
    const isDirectMessage = message.channel_type === 'im';
    debugLog('message routing decision', {
      isOwnMessage,
      isMention,
      isDirectMessage,
      allowSelfTest: config.allowSelfTest,
    });

    if (!isMention && !isDirectMessage) {
      debugLog('skipping because message is neither a direct message nor a mention');
      return;
    }

    const availability = await getAvailability();
    debugLog('availability check result', availability);
    if (!availability.unavailable) {
      debugLog('skipping because availability gate says I am available');
      return;
    }

    const senderName = isOwnMessage ? 'Umar' : await getSenderName(message.user);
    const promptText = cleanPromptText(message.text);
    debugLog('generating auto-reply', {
      senderName,
      promptText,
    });
    const replyText = await generateAutoReply(promptText, senderName);

    try {
      await replyAsMe(message.channel, message.thread_ts || message.ts, replyText);
      markReplied(message.channel, message.ts);
      debugLog('auto-reply sent successfully', {
        channel: message.channel,
        threadTs: message.thread_ts || message.ts,
      });
      console.log(`Auto-replied to ${message.channel}:${message.ts} because ${availability.reason}`);
    } catch (err: any) {
      debugLog('auto-reply failed', { error: err.message });
      console.error('Slack auto-reply error:', err.message);
    }
  });
}
