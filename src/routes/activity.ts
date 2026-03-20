import express from 'express';

import { receiver } from '../clients';
import { getActivitySnapshot, trackFile } from '../activity/state';
import { postToFileThread } from '../slack/threads';

export function registerActivityRoutes() {
  receiver.router.use(express.json());

  receiver.router.options('/activity', (_req, res) => {
    res.sendStatus(200);
  });

  receiver.router.options('/heartbeat', (_req, res) => {
    res.sendStatus(200);
  });

  receiver.router.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    next();
  });

  receiver.router.post('/activity', async (req, res) => {
    const { user, file } = req.body;
    if (!user || !file) {
      res.status(400).json({ error: 'user and file required' });
      return;
    }

    const overlaps = trackFile(user, file);
    if (overlaps.length > 0) {
      const others = overlaps.join(', ');
      try {
        await postToFileThread(file, {
          text: `⚠️ File overlap detected! ${user} is editing ${file}, which ${others} is also working on.`,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `⚠️ *File Overlap Detected!*\n\n*\`${file}\`* is being edited by multiple people:\n• *${user}* (just now)\n${overlaps.map(overlapUser => `• *${overlapUser}*`).join('\n')}\n\nCoordinate to avoid merge conflicts!`,
              },
            },
          ],
        });
      } catch (err: any) {
        console.error('Slack alert error:', err.message);
      }
    }

    res.json({ overlaps });
  });

  receiver.router.get('/activity', (_req, res) => {
    res.json(getActivitySnapshot());
  });

  receiver.router.post('/heartbeat', (req, res) => {
    const { user, files } = req.body;
    if (user && Array.isArray(files)) {
      for (const file of files) {
        trackFile(user, file);
      }
    }

    res.json({ ok: true });
  });
}
