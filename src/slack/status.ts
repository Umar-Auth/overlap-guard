import { app } from '../clients';

async function setAssistantStatus(channelId: string, threadTs: string, status: string, loadingMessages?: string[]) {
  await app.client.apiCall('assistant.threads.setStatus', {
    channel_id: channelId,
    thread_ts: threadTs,
    status,
    ...(loadingMessages && loadingMessages.length > 0 ? { loading_messages: loadingMessages } : {}),
  });
}

export async function showAssistantLoader(
  channelId: string,
  threadTs: string,
  mode: 'generic' | 'query' | 'task'
) {
  const states = {
    generic: {
      status: 'Gathering information...',
      loadingMessages: [
        'Gathering information...',
        'Thinking...',
        'Preparing a response...',
      ],
    },
    query: {
      status: 'Gathering information...',
      loadingMessages: [
        'Gathering information...',
        'Reviewing context...',
        'Drafting a response...',
      ],
    },
    task: {
      status: 'Gathering information...',
      loadingMessages: [
        'Gathering information...',
        'Reviewing the request...',
        'Planning the next step...',
      ],
    },
  };

  const selected = states[mode];
  await setAssistantStatus(channelId, threadTs, selected.status, selected.loadingMessages);
}

export async function clearAssistantLoader(channelId: string, threadTs: string) {
  await setAssistantStatus(channelId, threadTs, '');
}
