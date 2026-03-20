import { existsSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';

import { config } from '../config';
import type { ProjectRegistryEntry } from '../projects/registry';
import { runCommand, runCommandLine } from './shell';

export interface PreparedWorkspace {
  workspacePath: string;
  branchName: string;
  baseBranch: string;
  repoOwner: string;
  repoName: string;
  baseRepoPath: string;
}

function sanitizeBranchPart(input: string) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'task';
}

async function detectCurrentRepoMatch(project: ProjectRegistryEntry) {
  if (!project.repoOwner || !project.repoName) {
    return null;
  }

  try {
    const remote = await runCommand('git', ['remote', 'get-url', 'origin'], process.cwd());
    if (remote.code !== 0) {
      return null;
    }

    const normalized = remote.stdout.toLowerCase();
    if (normalized.includes(`${project.repoOwner.toLowerCase()}/${project.repoName.toLowerCase()}`)) {
      return process.cwd();
    }
  } catch {
    return null;
  }

  return null;
}

export async function locateProjectWorkspace(project?: ProjectRegistryEntry) {
  if (!project) {
    return null;
  }

  if (project.localPath && existsSync(project.localPath)) {
    return path.resolve(project.localPath);
  }

  const currentRepo = await detectCurrentRepoMatch(project);
  if (currentRepo) {
    return currentRepo;
  }

  for (const root of config.projectSearchRoots) {
    const candidates = [
      path.join(root, project.repoName || ''),
      path.join(root, project.name || ''),
    ].filter(Boolean);

    for (const candidate of candidates) {
      if (candidate && existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

export async function prepareTaskWorkspace(params: {
  project?: ProjectRegistryEntry;
  branchHint: string;
}) {
  const workspace = await locateProjectWorkspace(params.project);
  if (!workspace) {
    return { ok: false as const, reason: 'No local project workspace is configured for this project.' };
  }

  const repoOwner = params.project?.repoOwner || config.repoOwner;
  const repoName = params.project?.repoName || config.repoName;
  const baseBranch = params.project?.baseBranch || 'staging';
  const branchName = `codex/${sanitizeBranchPart(params.project?.id || repoName)}-${sanitizeBranchPart(params.branchHint)}-${Date.now().toString().slice(-6)}`;

  try {
    await runCommand('git', ['fetch', 'origin', baseBranch], workspace, { timeoutMs: 120000 });

    const worktreesRoot = path.join(workspace, '.delegate-worktrees');
    mkdirSync(worktreesRoot, { recursive: true });
    const worktreePath = path.join(worktreesRoot, branchName.replace(/\//g, '-'));

    const addResult = await runCommand(
      'git',
      ['worktree', 'add', '-B', branchName, worktreePath, `origin/${baseBranch}`],
      workspace,
      { timeoutMs: 120000 }
    );

    if (addResult.code !== 0) {
      return {
        ok: false as const,
        reason: addResult.stderr || addResult.stdout || 'Failed to prepare git worktree.',
      };
    }

    return {
      ok: true as const,
      workspace: {
        workspacePath: worktreePath,
        branchName,
        baseBranch,
        repoOwner,
        repoName,
        baseRepoPath: workspace,
      } satisfies PreparedWorkspace,
    };
  } catch (err: any) {
    return {
      ok: false as const,
      reason: err.message,
    };
  }
}

export async function getChangedFiles(workspacePath: string) {
  const result = await runCommand('git', ['status', '--short'], workspacePath, { timeoutMs: 30000 });
  if (result.code !== 0) {
    return [];
  }

  return result.stdout
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => line.replace(/^[A-Z?]+\s+/, ''));
}

export async function runProjectChecks(workspacePath: string, testCommand?: string) {
  if (!testCommand) {
    return {
      ran: false,
      success: true,
      output: 'No project test command configured.',
    };
  }

  const result = await runCommandLine(testCommand, workspacePath, { timeoutMs: 15 * 60 * 1000 });
  return {
    ran: true,
    success: result.code === 0,
    output: [result.stdout, result.stderr].filter(Boolean).join('\n').trim(),
  };
}

export async function commitChanges(params: {
  workspacePath: string;
  message: string;
}) {
  await runCommand('git', ['add', '-A'], params.workspacePath, { timeoutMs: 60000 });
  const result = await runCommand('git', ['commit', '-m', params.message], params.workspacePath, {
    timeoutMs: 120000,
  });

  return {
    success: result.code === 0,
    output: result.stderr || result.stdout,
  };
}

export async function pushBranch(params: {
  workspacePath: string;
  branchName: string;
}) {
  const result = await runCommand('git', ['push', '-u', 'origin', params.branchName], params.workspacePath, {
    timeoutMs: 5 * 60 * 1000,
  });

  return {
    success: result.code === 0,
    output: result.stderr || result.stdout,
  };
}

export async function createPullRequest(params: {
  repoOwner: string;
  repoName: string;
  branchName: string;
  baseBranch: string;
  title: string;
  body: string;
}) {
  const response = await fetch(`https://api.github.com/repos/${params.repoOwner}/${params.repoName}/pulls`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${config.githubToken}`,
      'User-Agent': 'overlap-guard',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: params.title,
      head: params.branchName,
      base: params.baseBranch,
      body: params.body,
      draft: false,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub PR creation failed with ${response.status}: ${text}`);
  }

  const payload = await response.json();
  return {
    number: payload.number,
    url: payload.html_url,
  };
}

export function writeTaskArtifact(params: {
  workspacePath: string;
  runId: string;
  fileName: string;
  content: string;
}) {
  const artifactDir = path.join(params.workspacePath, '.delegate-run');
  mkdirSync(artifactDir, { recursive: true });
  const filePath = path.join(artifactDir, `${params.runId}-${params.fileName}`);
  writeFileSync(filePath, params.content, 'utf8');
  return filePath;
}

