import { existsSync, readFileSync } from 'fs';
import path from 'path';

import { config } from '../config';

export interface ProjectRegistryEntry {
  id: string;
  name: string;
  description: string;
  repoOwner?: string;
  repoName?: string;
  localPath?: string;
  slackChannels?: string[];
  keywords?: string[];
  linearTeamId?: string;
  linearProjectId?: string;
  baseBranch?: string;
  testCommand?: string;
  executorCommand?: string;
}

const registryPath = path.resolve(process.cwd(), 'projects', 'registry.json');

function normalize(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function getDefaultProject(): ProjectRegistryEntry[] {
  return [
    {
      id: 'default',
      name: config.repoName || 'default-project',
      description: 'Default project used when no specific registry entry matches.',
      repoOwner: config.repoOwner,
      repoName: config.repoName,
      localPath: process.cwd(),
      keywords: [config.repoName, config.repoOwner, 'frontend', 'backend', 'slack bot'].filter(Boolean) as string[],
      baseBranch: 'staging',
    },
  ];
}

export function loadProjectRegistry() {
  if (!existsSync(registryPath)) {
    return getDefaultProject();
  }

  try {
    const parsed = JSON.parse(readFileSync(registryPath, 'utf8'));
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed as ProjectRegistryEntry[];
    }
  } catch (err: any) {
    console.error('Project registry parse error:', err.message);
  }

  return getDefaultProject();
}

export function resolveProject(messageText: string, channelId?: string) {
  const registry = loadProjectRegistry();
  const normalizedMessage = normalize(messageText);

  const scored = registry.map(project => {
    let score = 0;

    if (project.slackChannels?.includes(channelId || '')) {
      score += 5;
    }

    for (const keyword of project.keywords || []) {
      if (normalizedMessage.includes(normalize(keyword))) {
        score += 2;
      }
    }

    if (project.name && normalizedMessage.includes(normalize(project.name))) {
      score += 2;
    }

    if (project.repoOwner && normalizedMessage.includes(normalize(project.repoOwner))) {
      score += 2;
    }

    if (project.repoName && normalizedMessage.includes(normalize(project.repoName))) {
      score += 2;
    }

    return { project, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.project || registry[0];
}
