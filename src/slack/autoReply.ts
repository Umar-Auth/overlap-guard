import { buildQueryReply } from '../brain/respond';
import { classifyMessage } from '../brain/classifier';
import { app, userClient } from '../clients';
import { runTaskAutomation } from '../automation/taskRunner';
import { config } from '../config';
import { logObservation } from '../observation/log';
import { resolveProject } from '../projects/registry';
import { getRoutingThreadContext, getThreadContext } from './context';
import { replyAsMe } from './replies';
import { clearAssistantLoader, showAssistantLoader } from './status';

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

async function safeProgress(action: () => Promise<void>, label: string) {
  try {
    await action();
  } catch (err: any) {
    debugLog(`assistant status step failed: ${label}`, { error: err.message });
  }
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

    if (isOwnMessage && config.allowSelfTest && !isMention) {
      debugLog('skipping self-test because own messages must still use an explicit mention');
      return;
    }

    const availability = await getAvailability();
    debugLog('availability check result', availability);
    if (!availability.unavailable) {
      debugLog('skipping because availability gate says I am available');
      return;
    }

    const threadTs = message.thread_ts || message.ts;
    await safeProgress(
      () => showAssistantLoader(message.channel, threadTs, 'generic'),
      'show generic loader'
    );

    const senderName = isOwnMessage ? 'Umar' : await getSenderName(message.user);
    const promptText = cleanPromptText(message.text);
    const threadContext = await getThreadContext(message.channel, threadTs, message.ts);
    const routingThreadContext = await getRoutingThreadContext(message.channel, threadTs, message.ts);

    const project = resolveProject(promptText, message.channel, routingThreadContext);

    const classification = await classifyMessage(promptText, project, routingThreadContext || threadContext);
    await safeProgress(
      () => showAssistantLoader(message.channel, threadTs, classification.type === 'task' ? 'task' : 'query'),
      'show typed loader'
    );

    logObservation({
      kind: 'slack_inbound',
      channelId: message.channel,
      slackTs: threadTs,
      senderId: message.user,
      senderName,
      promptText,
      projectId: project?.id,
      projectName: project?.name,
      classification,
    });

    debugLog('generating auto-reply', {
      senderName,
      promptText,
      project: project?.name,
      threadContext,
      routingThreadContext,
      classification,
    });

    const replyText = classification.type === 'task'
      ? (await runTaskAutomation({
          messageText: promptText,
          senderName,
          channelId: message.channel,
          slackTs: threadTs,
          classification,
          project,
          threadContext,
          onProgress: async text => replyAsMe(message.channel, threadTs, text),
        })).finalReply
      : await buildQueryReply({
          messageText: promptText,
          senderName,
          project,
          threadContext,
        });

    try {
      await replyAsMe(message.channel, threadTs, replyText);
      await safeProgress(() => clearAssistantLoader(message.channel, threadTs), 'clear loader');
      markReplied(message.channel, message.ts);
      logObservation({
        kind: 'slack_outbound',
        channelId: message.channel,
        slackTs: threadTs,
        senderId: config.myUserId,
        projectId: project?.id,
        projectName: project?.name,
        classification,
        replyText,
      });
      debugLog('auto-reply sent successfully', {
        channel: message.channel,
        threadTs,
      });
      console.log(`Auto-replied to ${message.channel}:${message.ts} because ${availability.reason}`);
    } catch (err: any) {
      await safeProgress(() => clearAssistantLoader(message.channel, threadTs), 'clear loader on failure');
      debugLog('auto-reply failed', { error: err.message });
      console.error('Slack auto-reply error:', err.message);
    }
  });
}
