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
  repoRoot: string;
}

export interface WorkspaceInspection {
  requestedPath: string;
  repoRoot: string;
  baseBranch: string;
  repoOwner: string;
  repoName: string;
  projectId?: string;
  projectName?: string;
}

function sanitizeBranchPart(input: string) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'task';
}

function buildGitHubAuthArgs() {
  const token = config.githubToken;
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');

  return [
    '-c', 'credential.helper=',
    '-c', 'core.askPass=',
    '-c', 'credential.interactive=never',
    '-c', `http.https://github.com/.extraheader=AUTHORIZATION: basic ${basic}`,
  ];
}

function gitAuthEnv() {
  return {
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never',
  };
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

async function resolveRepoRoot(candidate: string) {
  const result = await runCommand('git', ['rev-parse', '--show-toplevel'], candidate, { timeoutMs: 30000 });
  if (result.code !== 0 || !result.stdout.trim()) {
    return null;
  }

  return result.stdout.trim();
}

async function remoteBranchExists(repoRoot: string, branch: string) {
  const result = await runCommand('git', ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`], repoRoot, {
    timeoutMs: 30000,
  });
  return result.code === 0;
}

async function detectOriginHeadBranch(repoRoot: string) {
  const result = await runCommand('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repoRoot, {
    timeoutMs: 30000,
  });

  if (result.code !== 0 || !result.stdout.trim()) {
    return null;
  }

  return result.stdout.trim().replace(/^origin\//, '');
}

async function detectBaseBranch(repoRoot: string, preferredBranch?: string) {
  if (preferredBranch && await remoteBranchExists(repoRoot, preferredBranch)) {
    return preferredBranch;
  }

  for (const branch of ['staging', 'main']) {
    if (await remoteBranchExists(repoRoot, branch)) {
      return branch;
    }
  }

  const originHead = await detectOriginHeadBranch(repoRoot);
  if (originHead) {
    return originHead;
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

export async function inspectProjectWorkspace(project?: ProjectRegistryEntry) {
  if (!project) {
    return {
      ok: false as const,
      reason: 'No project was resolved from the Slack request.',
    };
  }

  const requestedPath = await locateProjectWorkspace(project);
  if (!requestedPath) {
    return {
      ok: false as const,
      reason: `I could not find a local repo for *${project.name}*.`,
    };
  }

  const repoRoot = await resolveRepoRoot(requestedPath);
  if (!repoRoot) {
    return {
      ok: false as const,
      reason: `Resolved path is not a git repository: ${requestedPath}`,
      details: {
        requestedPath,
        projectId: project.id,
        projectName: project.name,
      },
    };
  }

  const repoOwner = project.repoOwner || config.repoOwner;
  const repoName = project.repoName || config.repoName;
  const baseBranch = await detectBaseBranch(repoRoot, project.baseBranch);

  if (!baseBranch) {
    return {
      ok: false as const,
      reason: `I could not determine a base branch for ${repoName}.`,
      details: {
        requestedPath,
        repoRoot,
        repoOwner,
        repoName,
        projectId: project.id,
        projectName: project.name,
      },
    };
  }

  return {
    ok: true as const,
    inspection: {
      requestedPath,
      repoRoot,
      baseBranch,
      repoOwner,
      repoName,
      projectId: project.id,
      projectName: project.name,
    } satisfies WorkspaceInspection,
  };
}

export async function prepareTaskWorkspace(params: {
  project?: ProjectRegistryEntry;
  branchHint: string;
  inspection?: WorkspaceInspection;
}) {
  let inspected = params.inspection;
  if (!inspected) {
    const inspectionResult = await inspectProjectWorkspace(params.project);
    if (!inspectionResult.ok) {
      return {
        ok: false as const,
        reason: inspectionResult.reason,
      };
    }
    inspected = inspectionResult.inspection;
  }

  if (!inspected) {
    return { ok: false as const, reason: 'No verified repo workspace is available for this task.' };
  }

  const branchName = `codex/${sanitizeBranchPart(params.project?.id || inspected.repoName)}-${sanitizeBranchPart(params.branchHint)}-${Date.now().toString().slice(-6)}`;

  try {
    const fetchResult = await runCommand('git', ['fetch', 'origin', inspected.baseBranch], inspected.repoRoot, {
      timeoutMs: 120000,
      env: gitAuthEnv(),
    });
    let finalFetchResult = fetchResult;
    if (fetchResult.code !== 0) {
      finalFetchResult = await runCommand(
        'git',
        [...buildGitHubAuthArgs(), 'fetch', 'origin', inspected.baseBranch],
        inspected.repoRoot,
        {
          timeoutMs: 120000,
          env: gitAuthEnv(),
        }
      );
    }

    if (finalFetchResult.code !== 0) {
      return {
        ok: false as const,
        reason: finalFetchResult.stderr || finalFetchResult.stdout || `Failed to fetch origin/${inspected.baseBranch}.`,
      };
    }

    const worktreesRoot = path.join(inspected.repoRoot, '.delegate-worktrees');
    mkdirSync(worktreesRoot, { recursive: true });
    const worktreePath = path.join(worktreesRoot, branchName.replace(/\//g, '-'));

    const addResult = await runCommand(
      'git',
      ['worktree', 'add', '-B', branchName, worktreePath, `origin/${inspected.baseBranch}`],
      inspected.repoRoot,
      { timeoutMs: 120000 }
    );

    if (addResult.code !== 0) {
      return {
        ok: false as const,
        reason: addResult.stderr || addResult.stdout || 'Failed to prepare git worktree.',
      };
    }

    await runCommand('git', ['config', '--worktree', 'credential.interactive', 'never'], worktreePath, {
      timeoutMs: 30000,
      env: gitAuthEnv(),
    });
    await runCommand('git', ['config', '--worktree', 'credential.helper', ''], worktreePath, {
      timeoutMs: 30000,
      env: gitAuthEnv(),
    });

    return {
      ok: true as const,
      workspace: {
        workspacePath: worktreePath,
        branchName,
        baseBranch: inspected.baseBranch,
        repoOwner: inspected.repoOwner,
        repoName: inspected.repoName,
        baseRepoPath: inspected.requestedPath,
        repoRoot: inspected.repoRoot,
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
  const result = await runCommand('git', [...buildGitHubAuthArgs(), 'push', '-u', 'origin', params.branchName], params.workspacePath, {
    timeoutMs: 5 * 60 * 1000,
    env: gitAuthEnv(),
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
