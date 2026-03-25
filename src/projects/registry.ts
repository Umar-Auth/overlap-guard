import { existsSync, readdirSync, readFileSync, realpathSync } from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

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

function compact(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function parseGitHubRemote(remoteUrl: string) {
  const trimmed = remoteUrl.trim();
  const sshMatch = trimmed.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (sshMatch) {
    return {
      owner: sshMatch[1],
      repo: sshMatch[2],
    };
  }

  return null;
}

function getRepoRoot(candidate: string) {
  try {
    return execFileSync('git', ['-C', candidate, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function normalizeLocalPath(localPath?: string) {
  if (!localPath || !existsSync(localPath)) {
    return undefined;
  }

  const repoRoot = getRepoRoot(localPath);
  if (!repoRoot) {
    return undefined;
  }

  try {
    return realpathSync(repoRoot);
  } catch {
    return path.resolve(repoRoot);
  }
}

function buildKeywords(entry: {
  name: string;
  repoOwner?: string;
  repoName?: string;
}) {
  const parts = [
    entry.name,
    entry.repoOwner,
    entry.repoName,
  ]
    .filter(Boolean)
    .flatMap(value => String(value).split(/[-_\s]+/g))
    .map(part => normalize(part))
    .filter(Boolean);

  const keywords = new Set<string>([
    normalize(entry.name),
    ...(entry.repoOwner ? [normalize(entry.repoOwner)] : []),
    ...(entry.repoName ? [normalize(entry.repoName)] : []),
    ...parts,
  ]);

  if ((entry.repoOwner || '').toLowerCase().includes('scale')) {
    keywords.add('scale');
  }

  if ((entry.repoName || '').toLowerCase().startsWith('platform-')) {
    keywords.add('platform');
  }

  return [...keywords].filter(Boolean);
}

function hydrateProjectEntry(entry: ProjectRegistryEntry): ProjectRegistryEntry {
  const localPath = normalizeLocalPath(entry.localPath);
  const repoName = entry.repoName || entry.name;
  const repoOwner = entry.repoOwner;

  return {
    ...entry,
    repoOwner,
    repoName,
    localPath,
    keywords: [...new Set([...(entry.keywords || []), ...buildKeywords({ name: entry.name, repoOwner, repoName })])],
  };
}

function discoverProjectsFromRoot(root: string): ProjectRegistryEntry[] {
  if (!root || !existsSync(root)) {
    return [];
  }

  const entries = readdirSync(root, { withFileTypes: true });
  const projects: ProjectRegistryEntry[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const localPath = normalizeLocalPath(path.join(root, entry.name));
    if (!localPath) {
      continue;
    }

    let repoOwner: string | undefined;
    let repoName: string | undefined;

    try {
      const remote = execFileSync('git', ['-C', localPath, 'remote', 'get-url', 'origin'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      const parsed = parseGitHubRemote(remote);
      repoOwner = parsed?.owner;
      repoName = parsed?.repo;
    } catch {
      repoName = path.basename(localPath);
    }

    const name = repoName || path.basename(localPath);
    projects.push({
      id: name,
      name,
      description: `Auto-discovered project from ${root}.`,
      repoOwner,
      repoName: repoName || path.basename(localPath),
      localPath,
      keywords: buildKeywords({
        name,
        repoOwner,
        repoName: repoName || path.basename(localPath),
      }),
    });
  }

  return projects;
}

function registryKey(entry: ProjectRegistryEntry) {
  return (entry.repoOwner && entry.repoName ? `${entry.repoOwner}/${entry.repoName}` : entry.localPath || entry.id);
}

function mergeProjectEntries(manualEntries: ProjectRegistryEntry[], discovered: ProjectRegistryEntry[]) {
  const merged = new Map<string, ProjectRegistryEntry>();

  for (const project of discovered.map(hydrateProjectEntry)) {
    merged.set(registryKey(project), project);
  }

  for (const manual of manualEntries.map(hydrateProjectEntry)) {
    const key = registryKey(manual);
    const existing = merged.get(key);
    merged.set(key, {
      ...existing,
      ...manual,
      localPath: manual.localPath || existing?.localPath,
      keywords: [...new Set([...(existing?.keywords || []), ...(manual.keywords || [])])],
    });
  }

  return [...merged.values()];
}

export function loadProjectRegistry() {
  const discovered = config.projectSearchRoots.flatMap(discoverProjectsFromRoot);
  const validDiscovered = discovered.filter(entry => entry.localPath);

  if (!existsSync(registryPath)) {
    return validDiscovered;
  }

  try {
    const parsed = JSON.parse(readFileSync(registryPath, 'utf8'));
    if (Array.isArray(parsed)) {
      return mergeProjectEntries(parsed as ProjectRegistryEntry[], validDiscovered);
    }
  } catch (err: any) {
    console.error('Project registry parse error:', err.message);
  }

  return validDiscovered;
}

export function resolveProject(messageText: string, channelId?: string, threadContext?: string) {
  const registry = loadProjectRegistry();
  if (registry.length === 0) {
    return undefined;
  }

  const normalizedMessage = normalize([threadContext, messageText].filter(Boolean).join(' '));
  const compactMessage = compact([threadContext, messageText].filter(Boolean).join(' '));
  if (!normalizedMessage) {
    return undefined;
  }

  const scored = registry.map(project => {
    let score = 0;

    if (project.slackChannels?.includes(channelId || '')) {
      score += 5;
    }

    if (project.repoName) {
      const normalizedRepoName = normalize(project.repoName);
      const compactRepoName = compact(project.repoName);
      if (normalizedMessage.includes(normalizedRepoName) || (compactRepoName && compactMessage.includes(compactRepoName))) {
        score += 20;
      }
    }

    if (project.name) {
      const normalizedProjectName = normalize(project.name);
      const compactProjectName = compact(project.name);
      if (normalizedMessage.includes(normalizedProjectName) || (compactProjectName && compactMessage.includes(compactProjectName))) {
        score += 14;
      }
    }

    if (project.repoOwner) {
      const normalizedRepoOwner = normalize(project.repoOwner);
      const compactRepoOwner = compact(project.repoOwner);
      if (normalizedMessage.includes(normalizedRepoOwner) || (compactRepoOwner && compactMessage.includes(compactRepoOwner))) {
        score += 3;
      }
    }

    for (const keyword of project.keywords || []) {
      const normalizedKeyword = normalize(keyword);
      const compactKeyword = compact(keyword);
      if (
        normalizedKeyword &&
        (normalizedMessage.includes(normalizedKeyword) || (compactKeyword && compactMessage.includes(compactKeyword)))
      ) {
        score += 4;
      }
    }

    return { project, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const winner = scored[0];
  const runnerUp = scored[1];
  if (!winner || winner.score <= 0) {
    return undefined;
  }

  if (runnerUp && runnerUp.score === winner.score) {
    return undefined;
  }

  return winner.project;
}
