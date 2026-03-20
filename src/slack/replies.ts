import { userClient } from '../clients';

export async function replyAsMe(channel: string, threadTs: string, text: string) {
  if (!userClient) {
    throw new Error('SLACK_USER_TOKEN missing');
  }

  await userClient.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text,
  });
}

