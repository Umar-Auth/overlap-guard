import { existsSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';

import { config } from '../config';
import { loadMemoryProfile } from '../memory/profile';
import { generateJson } from '../brain/openai';

const observationFile = path.resolve(process.cwd(), 'data', 'observations.ndjson');
const memoryDir = path.resolve(process.cwd(), 'memory');

interface MemoryRefreshPayload {
  role: string;
  skill: string;
  soul: string;
}

function readRecentObservations(limit = 200) {
  if (!existsSync(observationFile)) {
    return [];
  }

  return readFileSync(observationFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .slice(-limit)
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export async function refreshMemoryFromObservations() {
  if (!config.openAiApiKey) {
    throw new Error('OPENAI_API_KEY is required to refresh memory.');
  }

  const observations = readRecentObservations();
  const current = loadMemoryProfile();

  if (observations.length === 0) {
    return {
      updated: false,
      reason: 'No observations found.',
    };
  }

  const payload = await generateJson<MemoryRefreshPayload>(
    config.observationModel,
    [
      'You update an assistant memory profile for Umar.',
      'Return strict JSON with keys role, skill, soul.',
      'Preserve stable identity traits.',
      'Only incorporate patterns that are clearly supported by the observations.',
      'Keep each section concise and operational.',
    ].join(' '),
    [
      'Current ROLE:',
      current.role,
      '',
      'Current SKILL:',
      current.skill,
      '',
      'Current SOUL:',
      current.soul,
      '',
      'Recent observations:',
      JSON.stringify(observations, null, 2),
    ].join('\n')
  );

  writeFileSync(path.join(memoryDir, 'ROLE.md'), payload.role.trim(), 'utf8');
  writeFileSync(path.join(memoryDir, 'SKILL.md'), payload.skill.trim(), 'utf8');
  writeFileSync(path.join(memoryDir, 'SOUL.md'), payload.soul.trim(), 'utf8');

  return {
    updated: true,
  };
}

