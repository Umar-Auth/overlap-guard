import { existsSync } from 'fs';

import { config } from '../config';
import type { ProjectRegistryEntry } from '../projects/registry';
import { inspectProjectWorkspace } from './git';
import { runCommand } from './shell';

function hasCommand(commandPath: string) {
  if (commandPath.includes('/')) {
    return existsSync(commandPath);
  }

  return true;
}

export async function preflightTaskExecution(project?: ProjectRegistryEntry) {
  if (!config.githubToken) {
    return {
      ok: false as const,
      reason: 'GITHUB_TOKEN is missing.',
      details: { stage: 'credentials', key: 'GITHUB_TOKEN' },
    };
  }

  if (!config.linearApiKey) {
    return {
      ok: false as const,
      reason: 'LINEAR_API_KEY is missing.',
      details: { stage: 'credentials', key: 'LINEAR_API_KEY' },
    };
  }

  if (!hasCommand(config.codexCliPath)) {
    return {
      ok: false as const,
      reason: `Codex CLI was not found at ${config.codexCliPath}.`,
      details: { stage: 'codex', codexCliPath: config.codexCliPath },
    };
  }

  const loginStatus = await runCommand(config.codexCliPath, ['login', 'status'], process.cwd(), {
    timeoutMs: 30000,
  });
  const loginOutput = [loginStatus.stdout, loginStatus.stderr].filter(Boolean).join('\n');

  if (loginStatus.code !== 0 || !loginOutput.includes('Logged in')) {
    return {
      ok: false as const,
      reason: 'Codex is not logged in on this machine.',
      details: {
        stage: 'codex',
        codexCliPath: config.codexCliPath,
        stdout: loginStatus.stdout,
        stderr: loginStatus.stderr,
      },
    };
  }

  const inspection = await inspectProjectWorkspace(project);
  if (!inspection.ok) {
    return {
      ok: false as const,
      reason: inspection.reason,
      details: {
        stage: 'workspace',
        ...(inspection.details || {}),
      },
    };
  }

  return {
    ok: true as const,
      details: {
        stage: 'ready',
        codexCliPath: config.codexCliPath,
        codexLoginStatus: loginOutput.trim(),
        ...inspection.inspection,
      },
    };
}
