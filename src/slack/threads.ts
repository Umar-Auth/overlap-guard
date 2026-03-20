import { app } from '../clients';
import { config } from '../config';

const fileThreads = new Map<string, string>();

export async function postToFileThread(file: string, message: { text: string; blocks?: any[] }) {
  const existingThread = fileThreads.get(file);
  const payload: any = {
    channel: config.slackChannel,
    ...message,
    ...(existingThread ? { thread_ts: existingThread } : {}),
  };

  const result = await app.client.chat.postMessage(payload);
  if (!existingThread && result.ts) {
    fileThreads.set(file, result.ts as string);
  }
}
